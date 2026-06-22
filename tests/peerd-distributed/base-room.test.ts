import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { createBaseNetwork } from '../../extension/peerd-distributed/base-network.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// Two base networks linked over a memoryPair mesh — the live offscreen lobby's
// shape, minus WebRTC. A "room" is openRoom() on top: a namespaced overlay on
// this ONE shared mesh, no second rendezvous + mesh (that's the whole point).
const linkedPair = async () => {
  const ia = await generateIdentity();
  const ib = await generateIdentity();
  const ma = createRoomMesh({ roomId: 'base', identity: ia });
  const mb = createRoomMesh({ roomId: 'base', identity: ib });
  const a = await createBaseNetwork({ identity: ia, mesh: ma });
  const b = await createBaseNetwork({ identity: ib, mesh: mb });
  const [ca, cb] = memoryPair();
  await Promise.all([
    createSession({ channel: ca, identity: ia }),
    createSession({ channel: cb, identity: ib }),
  ]);
  ma.addLink(ca, ib.did);
  mb.addLink(cb, ia.did);
  a.node.start(); b.node.start();
  return { a, b, ia, ib };
};

describe('base-room — a dwapp room over the shared base mesh (no signaler)', () => {
  test('feed: a publish on a room reaches the other member', async () => {
    const { a, b } = await linkedPair();
    const ra = a.openRoom('peerd-global', { meta: () => ({ name: 'ada' }) });
    const rb = b.openRoom('peerd-global', { meta: () => ({ name: 'bo' }) });
    const got: any[] = [];
    rb.gossip.subscribe('feed', (m: any) => got.push(m));
    await tick();
    await ra.gossip.publish('feed', { text: 'hi room' });
    await tick();
    expect(got.map((m) => m.data.text)).toContain('hi room');
    ra.leave(); rb.leave(); a.close(); b.close();
  });

  test('rooms are isolated: a different room id never crosses over', async () => {
    const { a, b } = await linkedPair();
    const ra = a.openRoom('peerd-global');
    const rbAlpha = b.openRoom('peerd-global');
    const rbBeta = b.openRoom('private-xyz');   // same mesh, different namespace
    const alpha: any[] = [];
    const beta: any[] = [];
    rbAlpha.gossip.subscribe('feed', (m: any) => alpha.push(m));
    rbBeta.gossip.subscribe('feed', (m: any) => beta.push(m));
    await tick();
    await ra.gossip.publish('feed', { text: 'global-only' });
    await tick();
    expect(alpha.map((m) => m.data.text)).toContain('global-only');
    expect(beta.length).toBe(0);                // never leaked into the other room
    ra.leave(); rbAlpha.leave(); rbBeta.leave(); a.close(); b.close();
  });

  test('presence: members see each other with display names', async () => {
    const { a, b, ia } = await linkedPair();
    const ra = a.openRoom('peerd-global', { meta: () => ({ name: 'ada' }) });
    const rb = b.openRoom('peerd-global', { meta: () => ({ name: 'bo' }) });
    await tick();
    ra.presence.announce(); rb.presence.announce();
    await tick();
    const bSeesA = rb.presence.list().find((p: any) => p.did === ia.did);
    expect(bSeesA?.meta).toEqual({ name: 'ada' });
    ra.leave(); rb.leave(); a.close(); b.close();
  });

  test('direct: a 1:1 message is proto-tagged and delivered to the recipient', async () => {
    const { a, b, ia } = await linkedPair();
    const ra = a.openRoom('peerd-global');
    const rb = b.openRoom('peerd-global');
    const directs: any[] = [];
    rb.direct.onMessage((m: any) => directs.push(m));
    await tick();
    await ra.direct.send(b.did, { secret: 'just you' });
    await tick();
    expect(directs.map((m) => m.data.secret)).toContain('just you');
    expect(directs[0].from).toBe(ia.did);
    ra.leave(); rb.leave(); a.close(); b.close();
  });

  test('retained feed: history is kept under the namespaced topic', async () => {
    const { a } = await linkedPair();
    const ra = a.openRoom('peerd-global');
    ra.sync.retain('feed');
    await ra.sync.publish('feed', { text: 'kept' });
    const hist = ra.sync.history('feed');
    expect(hist.map((e: any) => e.body.data.text)).toContain('kept');
    expect(hist[0].body.topic).toBe('dwapp/peerd-global/feed'); // namespaced, not bare 'feed'
    ra.leave(); a.close();
  });

  test('retained feed backfills over an ALREADY-connected peer (link precedes retain)', async () => {
    // The production case the offscreen hits: the base mesh is linked on unlock,
    // long before the dwapp opens + retains. retain() must reconcile against the
    // existing link, not only future ones — else a late joiner sees empty chat.
    const { a, b } = await linkedPair();   // a and b are already linked
    const ra = a.openRoom('peerd-global');
    ra.sync.retain('feed');
    await ra.sync.publish('feed', { text: 'said-before-you-opened' });
    await tick();

    const rb = b.openRoom('peerd-global');
    const got: any[] = [];
    rb.gossip.subscribe('feed', (m: any) => got.push(m));
    rb.sync.retain('feed');                // reconciles against the pre-existing link
    await tick(60);

    expect(got.map((m) => m.data.text)).toContain('said-before-you-opened');
    ra.leave(); rb.leave(); a.close(); b.close();
  });

  test('retained feed backfills a member who links in later', async () => {
    // A retains + publishes BEFORE B is linked; when the link forms, the
    // new-link sync moment backfills B over the shared mesh (same protocol,
    // namespaced topics). This is the late-joiner "the room has history" path.
    const ia = await generateIdentity();
    const ib = await generateIdentity();
    const ma = createRoomMesh({ roomId: 'base', identity: ia });
    const mb = createRoomMesh({ roomId: 'base', identity: ib });
    const a = await createBaseNetwork({ identity: ia, mesh: ma });
    const b = await createBaseNetwork({ identity: ib, mesh: mb });
    a.node.start(); b.node.start();

    const ra = a.openRoom('peerd-global');
    ra.sync.retain('feed');
    await ra.sync.publish('feed', { text: 'before-you-joined' });

    const rb = b.openRoom('peerd-global');
    rb.sync.retain('feed');
    const got: any[] = [];
    rb.gossip.subscribe('feed', (m: any) => got.push(m));

    // Link them NOW — the new link is the sync moment (both sides requestFrom).
    const [ca, cb] = memoryPair();
    await Promise.all([
      createSession({ channel: ca, identity: ia }),
      createSession({ channel: cb, identity: ib }),
    ]);
    ma.addLink(ca, ib.did);
    mb.addLink(cb, ia.did);
    await tick(80);

    expect(got.map((m) => m.data.text)).toContain('before-you-joined');
    ra.leave(); rb.leave(); a.close(); b.close();
  });
});
