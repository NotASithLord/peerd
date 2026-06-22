import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { createBaseNetwork } from '../../extension/peerd-distributed/base-network.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const link = async (a: any, b: any) => {
  const [ca, cb] = memoryPair();
  await Promise.all([
    createSession({ channel: ca, identity: a.identity }),
    createSession({ channel: cb, identity: b.identity }),
  ]);
  a.mesh.addLink(ca, b.identity.did);
  b.mesh.addLink(cb, a.identity.did);
  await a.base.node.dht.learn(b.identity.did);
  await b.base.node.dht.learn(a.identity.did);
};

const spawn = async (label: string) => {
  const identity = await generateIdentity();
  const mesh = createRoomMesh({ roomId: 'base', identity });
  const base = await createBaseNetwork({ identity, mesh, meta: () => ({ name: label }) });
  return { identity, mesh, base, label };
};

const clique = async (n: number) => {
  const peers = [];
  for (let i = 0; i < n; i++) peers.push(await spawn(`n${i}`));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) await link(peers[i], peers[j]);
  return peers;
};

describe('base network — the always-on lobby + sub-protocols', () => {
  test('global presence: every node sees every other on the lobby', async () => {
    const peers = await clique(5);
    for (const p of peers) p.base.presence.announce();
    await tick(60);
    for (const p of peers) expect(p.base.presence.list().length).toBeGreaterThanOrEqual(4);
    for (const p of peers) p.base.close();
  });

  test('a sub-protocol broadcasts, direct-messages, and tracks its own members', async () => {
    const peers = await clique(4);
    const subs = peers.map((p) => p.base.joinSubProtocol('commons'));
    const gotMsg: Record<string, any[]> = {}; const gotDirect: Record<string, any[]> = {};
    subs.forEach((s, i) => { gotMsg[i] = []; gotDirect[i] = []; s.onMessage((m: any) => gotMsg[i].push(m.data)); s.onDirect((m: any) => gotDirect[i].push(m.data)); });
    await tick(60); // PEER_ON_DWAPP floods → membership

    // membership: everyone sees the other 3 on "commons"
    for (const s of subs) expect(s.peers().length).toBeGreaterThanOrEqual(3);

    // broadcast from node0 reaches the other members
    await subs[0].broadcast({ hello: 'commons' });
    await tick(60);
    for (let i = 1; i < 4; i++) expect(gotMsg[i]).toContainEqual({ hello: 'commons' });

    // a private direct message goes to exactly one member
    subs[0].send(peers[2].identity.did, { secret: 'for n2' });
    await tick(60);
    expect(gotDirect[2]).toContainEqual({ secret: 'for n2' });
    expect(gotDirect[1]).toHaveLength(0); // not broadcast — only n2 got it
    for (const p of peers) p.base.close();
  });

  test('dwapp discovery: a card streams to subscribed peers (default-subscribe on connect)', async () => {
    const peers = await clique(4);
    for (const p of peers) p.base.start();   // discovery.subscribeAll() over the clique
    await tick(60);
    const heard: Record<string, any[]> = {};
    peers.forEach((p, i) => { heard[i] = []; p.base.onDwappAnnounce((a: any) => heard[i].push(a)); });
    const { dwapp_id } = await peers[0].base.publishMeta({
      slug: 'commons', name: 'commons', head: { version_id: 'v1', content_addr: 'peerd://pub/h', size: 1 },
    });
    await tick(80);
    for (let i = 1; i < 4; i++) expect(heard[i].some((a) => a.dwapp_id === dwapp_id)).toBe(true);
    expect((await peers[1].base.findDwapp(dwapp_id))?.value.name).toBe('commons');
    for (const p of peers) p.base.close();
  });

  test('dwapp discovery: a cold late joiner gets the whole Library on connect (no publisher known)', async () => {
    // The exact bug from the original report: a peer browsing Discover knows
    // neither publisher nor id, so the DHT can't help. It SUBSCRIBES on connect
    // and the sharer answers with a snapshot — heardDwapps populates with no
    // findDwapp(publisher) call at all.
    const sharer = await spawn('sharer');
    sharer.base.start();
    const { dwapp_id } = await sharer.base.publishMeta({
      slug: 'tictactoe', name: 'tic tac toe', head: { version_id: 'v1', content_addr: 'peerd://pub/t', size: 1 },
    });

    const late = await spawn('late');
    late.base.start();
    expect(late.base.heardDwapps()).toHaveLength(0); // hasn't asked anyone yet
    await link(sharer, late);                         // newcomer subscribes; sharer snapshots
    await tick(80);

    const heard = late.base.heardDwapps();
    expect(heard.some((a: any) => a.dwapp_id === dwapp_id)).toBe(true);
    expect(heard.find((a: any) => a.dwapp_id === dwapp_id)?.name).toBe('tic tac toe');
    [sharer, late].forEach((p) => p.base.close());
  });

  test('ban: a publisher we ban is dropped, blocklisted, and cannot re-enter our Library', async () => {
    const a = await spawn('a');
    const b = await spawn('b');
    a.base.start(); b.base.start();
    await link(a, b);
    await tick(40);
    const { dwapp_id } = await a.base.publishMeta({
      slug: 'spammy', name: 'spammy', head: { version_id: 'v1', content_addr: 'peerd://a/x', size: 1 },
    });
    await tick(60);
    expect(b.base.heardDwapps().some((r: any) => r.dwapp_id === dwapp_id)).toBe(true);
    b.base.ban(a.identity.did, 'spam');
    expect(b.base.heardDwapps().some((r: any) => r.dwapp_id === dwapp_id)).toBe(false);
    [a, b].forEach((p) => p.base.close());
  });
});
