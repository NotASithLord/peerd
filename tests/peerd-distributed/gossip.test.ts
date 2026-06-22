import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { createGossip } from '../../extension/peerd-distributed/gossip/topic.js';
import { createPresence, PRESENCE_TOPIC } from '../../extension/peerd-distributed/gossip/presence.js';
import { createTopicSync, createMemoryTopicStore } from '../../extension/peerd-distributed/gossip/sync.js';

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// A fully-linked clique of N peers: real identities, real HELLOs, real
// signed envelopes — only the bytes ride memoryPair instead of WebRTC.
const clique = async (n: number, opts: any = {}) => {
  const peers: any[] = [];
  for (let i = 0; i < n; i++) {
    const identity = await generateIdentity();
    const mesh = createRoomMesh({ roomId: 'room', identity, ...opts });
    const gossip = createGossip({ mesh, audit: opts.audit });
    peers.push({ identity, mesh, gossip });
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const [ci, cj] = memoryPair();
      await Promise.all([
        createSession({ channel: ci, identity: peers[i].identity }),
        createSession({ channel: cj, identity: peers[j].identity }),
      ]);
      peers[i].mesh.addLink(ci, peers[j].identity.did);
      peers[j].mesh.addLink(cj, peers[i].identity.did);
    }
  }
  return peers;
};

const close = (peers: any[]) => { for (const p of peers) { p.gossip.close(); p.mesh.close(); } };

describe('topic gossip', () => {
  test('a publish reaches every subscriber exactly once (flood + dedup)', async () => {
    const peers = await clique(4);
    const got: Record<number, any[]> = { 1: [], 2: [], 3: [] };
    for (const i of [1, 2, 3]) peers[i].gossip.subscribe('feed', (m: any) => got[i].push(m));

    await peers[0].gossip.publish('feed', { text: 'hello room' });
    await tick();

    for (const i of [1, 2, 3]) {
      // In a 4-clique each peer hears the frame from up to 3 paths —
      // exactly one delivery means the sig-keyed dedup is doing its job.
      expect(got[i]).toHaveLength(1);
      expect(got[i][0].from).toBe(peers[0].identity.did);
      expect(got[i][0].data).toEqual({ text: 'hello room' });
    }
    close(peers);
  });

  test('floods cross hops: a partial mesh still delivers (a—b—c line)', async () => {
    // Build a LINE, not a clique: a—b, b—c. a's publish must reach c
    // through b's re-broadcast.
    const ids = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
    const ms = ids.map((identity) => createRoomMesh({ roomId: 'room', identity }));
    const gs = ms.map((mesh) => createGossip({ mesh }));
    const link = async (x: number, y: number) => {
      const [cx, cy] = memoryPair();
      await Promise.all([
        createSession({ channel: cx, identity: ids[x] }),
        createSession({ channel: cy, identity: ids[y] }),
      ]);
      ms[x].addLink(cx, ids[y].did);
      ms[y].addLink(cy, ids[x].did);
    };
    await link(0, 1);
    await link(1, 2);

    const atC: any[] = [];
    gs[2].subscribe('t', (m: any) => atC.push(m));
    await gs[0].publish('t', 'over the hop');
    await tick();
    expect(atC).toHaveLength(1);
    expect(atC[0].from).toBe(ids[0].did); // origin attribution survives the hop
    for (const g of gs) g.close();
    for (const m of ms) m.close();
  });

  test('mute drops a sender locally AND stops relaying them', async () => {
    const peers = await clique(3);
    const got: any[] = [];
    peers[2].gossip.subscribe('t', (m: any) => got.push(m));
    peers[2].gossip.mute(peers[0].identity.did);

    await peers[0].gossip.publish('t', 'unwanted');
    await tick();
    expect(got).toHaveLength(0);
    close(peers);
  });

  test('a sender past the rate limit is dropped and audited', async () => {
    const audits: any[] = [];
    const ids = await Promise.all([generateIdentity(), generateIdentity()]);
    const ma = createRoomMesh({ roomId: 'r', identity: ids[0] });
    const mb = createRoomMesh({ roomId: 'r', identity: ids[1] });
    const ga = createGossip({ mesh: ma });
    const gb = createGossip({ mesh: mb, rateBurst: 5, ratePerSec: 0.0001, audit: (t: string, d: any) => audits.push(t) });
    const [ca, cb] = memoryPair();
    await Promise.all([
      createSession({ channel: ca, identity: ids[0] }),
      createSession({ channel: cb, identity: ids[1] }),
    ]);
    ma.addLink(ca, ids[1].did);
    mb.addLink(cb, ids[0].did);

    const got: any[] = [];
    gb.subscribe('t', (m: any) => got.push(m));
    for (let i = 0; i < 12; i++) await ga.publish('t', i);
    await tick();
    expect(got.length).toBe(5); // burst allowance, then the wall
    expect(audits).toContain('gossip_rate_limited');
    ga.close(); gb.close(); ma.close(); mb.close();
  });
});

describe('presence', () => {
  test('beacons produce join events with app meta; silence produces leave', async () => {
    const peers = await clique(2);
    const pa = createPresence({
      gossip: peers[0].gossip, selfDid: peers[0].identity.did,
      heartbeatMs: 30, expireMs: 90,
    });
    const pb = createPresence({
      gossip: peers[1].gossip, selfDid: peers[1].identity.did,
      meta: () => ({ name: 'walt' }), heartbeatMs: 30, expireMs: 90,
    });
    const joins: any[] = [];
    const leaves: any[] = [];
    pa.onJoin((j: any) => joins.push(j));
    pa.onLeave((l: any) => leaves.push(l));

    pa.start(); pb.start();
    await tick(50);
    expect(joins.map((j) => j.did)).toContain(peers[1].identity.did);
    expect(joins.find((j) => j.did === peers[1].identity.did).meta).toEqual({ name: 'walt' });
    expect(pa.list().map((p: any) => p.did)).toContain(peers[1].identity.did);

    pb.stop(); // b goes silent → a times it out
    await tick(250);
    expect(leaves.map((l) => l.did)).toContain(peers[1].identity.did);
    pa.close(); pb.close();
    close(peers);
  });

  test('forget() drops a peer NOW (mesh link died) without waiting for expiry', async () => {
    const peers = await clique(2);
    const pa = createPresence({ gossip: peers[0].gossip, selfDid: peers[0].identity.did, heartbeatMs: 30, expireMs: 100_000 });
    const pb = createPresence({ gossip: peers[1].gossip, selfDid: peers[1].identity.did, heartbeatMs: 30, expireMs: 100_000 });
    const leaves: any[] = [];
    pa.onLeave((l: any) => leaves.push(l));
    pa.start(); pb.start();
    await tick(50);
    expect(pa.list().map((p: any) => p.did)).toContain(peers[1].identity.did);

    // expiry is ~forever here; forget() drops it immediately (the link-died path).
    pa.forget(peers[1].identity.did);
    expect(pa.list().map((p: any) => p.did)).not.toContain(peers[1].identity.did);
    expect(leaves.map((l) => l.did)).toContain(peers[1].identity.did);
    pa.close(); pb.close();
    close(peers);
  });

  test('forget() suppresses a stale in-flight beacon (no flap), but a real re-join re-adds', () => {
    // Deterministic: a fake gossip we feed beacons into + an injected clock, so
    // the suppression window is exercised without real timers. Reproduces the
    // "vanish fast -> reappear briefly -> vanish again" flap and its fix.
    let clock = 1000;
    const now = () => clock;
    let deliver: (m: any) => void = () => {};
    const fakeGossip = {
      subscribe: (_t: string, cb: (m: any) => void) => { deliver = cb; return () => {}; },
      publish: () => Promise.resolve({}),
    };
    const other = 'did:other';
    const pa = createPresence({ gossip: fakeGossip as any, selfDid: 'did:self', now });
    const leaves: any[] = [];
    pa.onLeave((l: any) => leaves.push(l));

    deliver({ from: other, data: { meta: { name: 'bee' } } });
    expect(pa.list().map((p: any) => p.did)).toContain(other);

    // The mesh tells us B's link died → forget arms the suppression window.
    pa.forget(other);
    expect(pa.list().map((p: any) => p.did)).not.toContain(other);
    expect(leaves.map((l) => l.did)).toContain(other);

    // B's LAST beacon, still flooding via a third member, lands 1s later: DROPPED.
    clock += 1000;
    deliver({ from: other, data: { meta: { name: 'bee' } } });
    expect(pa.list().map((p: any) => p.did)).not.toContain(other); // no flap

    // A GENUINE re-join, after the window: re-added on its next beacon.
    clock += 3000;
    deliver({ from: other, data: { meta: { name: 'bee' } } });
    expect(pa.list().map((p: any) => p.did)).toContain(other);
    pa.close();
  });

  test('presence rides the reserved topic — visible as plain gossip', async () => {
    const peers = await clique(2);
    const raw: any[] = [];
    peers[1].gossip.subscribe(PRESENCE_TOPIC, (m: any) => raw.push(m));
    const pa = createPresence({ gossip: peers[0].gossip, selfDid: peers[0].identity.did, heartbeatMs: 1000 });
    pa.start();
    await tick();
    expect(raw.length).toBeGreaterThanOrEqual(1);
    pa.close();
    close(peers);
  });
});

describe('topic sync (late-join backfill)', () => {
  const withSync = (p: any) => {
    const store = createMemoryTopicStore();
    const sync = createTopicSync({ mesh: p.mesh, gossip: p.gossip, store });
    sync.retain('feed');
    return { ...p, sync, store };
  };

  test('a late joiner backfills history from a peer, originals verified', async () => {
    // a and b share history; c arrives later with none.
    const [pa, pb] = (await clique(2)).map(withSync);
    await pa.sync.publish('feed', { post: 'first' });
    await pb.sync.publish('feed', { post: 'second' });
    await tick();
    expect(pa.sync.history('feed')).toHaveLength(2);

    // c links to a only — and must end with BOTH posts.
    const idC = await generateIdentity();
    const meshC = createRoomMesh({ roomId: 'room', identity: idC });
    const gossipC = createGossip({ mesh: meshC });
    const pc = withSync({ identity: idC, mesh: meshC, gossip: gossipC });
    const seen: any[] = [];
    pc.gossip.subscribe('feed', (m: any) => seen.push(m));

    const [ca, cc] = memoryPair();
    await Promise.all([
      createSession({ channel: ca, identity: pa.identity }),
      createSession({ channel: cc, identity: idC }),
    ]);
    pa.mesh.addLink(ca, idC.did);
    pc.mesh.addLink(cc, pa.identity.did);
    await tick(60);

    expect(pc.sync.history('feed')).toHaveLength(2);
    expect(seen.map((m) => m.data.post).sort()).toEqual(['first', 'second']);
    // Attribution survives backfill: each post still credits its author.
    expect(seen.find((m) => m.data.post === 'second').from).toBe(pb.identity.did);
    pc.sync.close(); pc.gossip.close(); pc.mesh.close();
    pa.sync.close(); pb.sync.close();
    close([pa, pb]);
  });

  test('sync is symmetric: a rejoiner pushes its offline posts forward', async () => {
    // d wrote a post while disconnected; on link-up, the ROOM backfills d's
    // post because d's side answers the other peer's SYNC_REQ.
    const [pa] = (await clique(1)).map(withSync);
    const idD = await generateIdentity();
    const meshD = createRoomMesh({ roomId: 'room', identity: idD });
    const gossipD = createGossip({ mesh: meshD });
    const pd = withSync({ identity: idD, mesh: meshD, gossip: gossipD });
    await pd.sync.publish('feed', { post: 'written offline' }); // no links yet

    const [ca, cd] = memoryPair();
    await Promise.all([
      createSession({ channel: ca, identity: pa.identity }),
      createSession({ channel: cd, identity: idD }),
    ]);
    pa.mesh.addLink(ca, idD.did);
    pd.mesh.addLink(cd, pa.identity.did);
    await tick(60);

    expect(pa.sync.history('feed').map((e: any) => e.body.data.post)).toContain('written offline');
    pd.sync.close(); pd.gossip.close(); pd.mesh.close();
    pa.sync.close();
    close([pa]);
  });

  test('fabricated history in a response is rejected (inner sig check)', async () => {
    const [pa] = (await clique(1)).map(withSync);
    const idEvil = await generateIdentity();
    const meshEvil = createRoomMesh({ roomId: 'room', identity: idEvil });

    const [ca, ce] = memoryPair();
    await Promise.all([
      createSession({ channel: ca, identity: pa.identity }),
      createSession({ channel: ce, identity: idEvil }),
    ]);
    pa.mesh.addLink(ca, idEvil.did);
    meshEvil.addLink(ce, pa.identity.did);
    await tick();

    // Evil answers a's SYNC_REQ with a forged "post by X": valid OUTER
    // frame (evil signs it), garbage INNER signature.
    const victim = await generateIdentity();
    const forged = {
      v: 1, ch: 4, typ: 0, from: victim.did, id: 'f-1', ts: 1,
      body: { topic: 'feed', data: { post: 'forged' } },
      sig: 'AAAA' + 'B'.repeat(82) + '==',
    };
    const resp = await meshEvil.sign(4, 3, { topic: 'feed', envs: [forged] });
    meshEvil.send(pa.identity.did, resp);
    await tick(60);

    expect(pa.sync.history('feed')).toHaveLength(0);
    pa.sync.close();
    close([pa]);
    meshEvil.close();
  });

  test('a MUTED peer\'s history is not stored or re-served via backfill (D-9)', async () => {
    // Regression: ingest() returns false for BOTH "already seen" and
    // "muted"; the seen-but-not-stored fallback must not store a muted
    // sender's history, or mute leaks back into the room through sync.
    const [pa] = (await clique(1)).map(withSync);

    // B is a real author A has muted; their PUB envelope is validly signed.
    const idB = await generateIdentity();
    const meshB = createRoomMesh({ roomId: 'room', identity: idB });
    const bEnv = await meshB.sign(4, 0, { topic: 'feed', data: { post: 'from a muted peer' } });
    pa.gossip.mute(idB.did);

    // A relay R (not muted) answers A's SYNC_REQ carrying B's envelope.
    const idR = await generateIdentity();
    const meshR = createRoomMesh({ roomId: 'room', identity: idR });
    const [ca, cr] = memoryPair();
    await Promise.all([
      createSession({ channel: ca, identity: pa.identity }),
      createSession({ channel: cr, identity: idR }),
    ]);
    pa.mesh.addLink(ca, idR.did);   // A ↔ R
    meshR.addLink(cr, pa.identity.did);
    await tick();

    const delivered: any[] = [];
    pa.gossip.subscribe('feed', (m: any) => delivered.push(m));
    const resp = await meshR.sign(4, 3, { topic: 'feed', envs: [bEnv] });
    meshR.send(pa.identity.did, resp);
    await tick(60);

    // The inner sig is VALID (B signed it), so it's not a fabrication —
    // it must be dropped purely because B is muted, on the backfill path.
    expect(delivered).toHaveLength(0);
    expect(pa.sync.history('feed').some((e: any) => e.body.data.post === 'from a muted peer')).toBe(false);
    pa.sync.close();
    close([pa]);
    meshB.close(); meshR.close();
  });
});
