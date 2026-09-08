import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { createLibrary } from '../../extension/peerd-distributed/apps/library.js';
import { createDiscovery } from '../../extension/peerd-distributed/apps/discovery.js';
import { buildMeta } from '../../extension/peerd-distributed/apps/meta.js';
import { createDwebRollbackGuard } from '../../extension/background/dweb-rollback-guard.js';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate: () => boolean, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await tick(10);
};
const head = (n = 1) => ({ version_id: `v${n}`, content_addr: 'peerd://p/h', size: 10 });

const spawn = async (over: any = {}) => {
  const identity = await generateIdentity();
  const rawMesh = createRoomMesh({ roomId: 'base', identity });
  let failSign = false;
  let failSend = false;
  const mesh = over.failSign === true || over.failSend === true ? Object.freeze({
    ...rawMesh,
    sign: (channel: number, type: number, body: any) => failSign
      ? Promise.reject(new Error('transport lost after local commit'))
      : rawMesh.sign(channel, type, body),
    send: (did: string, envelope: any) => failSend
      ? false : rawMesh.send(did, envelope),
  }) : rawMesh;
  const blocked = new Set<string>();
  const library = createLibrary({ isBlocked: (d: string) => blocked.has(d) });
  const discovery = createDiscovery({
    mesh, identity, library,
    isBlocked: (d: string) => blocked.has(d),
    block: (d: string) => blocked.add(d),
    ...(over.admitMeta ? { admitMeta: over.admitMeta } : {}),
  });
  return {
    identity, mesh, library, discovery, blocked,
    failSign: () => { failSign = true; },
    failSend: () => { failSend = true; },
  };
};

const link = async (a: any, b: any) => {
  const [ca, cb] = memoryPair();
  await Promise.all([
    createSession({ channel: ca, identity: a.identity }),
    createSession({ channel: cb, identity: b.identity }),
  ]);
  a.mesh.addLink(ca, b.identity.did);
  b.mesh.addLink(cb, a.identity.did);
};

const ownCard = (n: any, slug: string, seq = 1) =>
  buildMeta({ slug, name: slug, seq, head: head(seq) }, n.identity);

describe('dwapp discovery — sovereign subscription plane', () => {
  test('a late joiner gets the snapshot on connect (default-subscribe)', async () => {
    const sharer = await spawn();
    await sharer.discovery.announce(await ownCard(sharer, 'tictactoe'));

    const joiner = await spawn();
    expect(joiner.library.size()).toBe(0);
    await link(sharer, joiner);          // onPeer → both auto-subscribe → snapshots flow
    await waitFor(() => joiner.library.rows()
      .some((r: any) => r.name === 'tictactoe'));

    expect(joiner.library.rows().some((r: any) => r.name === 'tictactoe')).toBe(true);
    [sharer, joiner].forEach((p) => p.discovery.close());
  });

  test('a new announce streams live to existing subscribers', async () => {
    const a = await spawn();
    const b = await spawn();
    await link(a, b);
    await tick();                        // subscriptions established
    await a.discovery.announce(await ownCard(a, 'chess'));
    await waitFor(() => b.library.rows().some((r: any) => r.name === 'chess'));
    expect(b.library.rows().some((r: any) => r.name === 'chess')).toBe(true);
    [a, b].forEach((p) => p.discovery.close());
  });

  test('a failed subscriber forward cannot undo a locally committed announcement', async () => {
    const a = await spawn({ failSign: true });
    const b = await spawn();
    await link(a, b);
    await waitFor(() => a.discovery.subscriberCount() === 1);
    a.failSign();
    const result = await a.discovery.announce(await ownCard(a, 'committed'));
    expect(result).toMatchObject({ fresh: true, propagated: false });
    expect(a.library.rows().some((row: any) => row.name === 'committed')).toBe(true);
    [a, b].forEach((peer) => peer.discovery.close());
  });

  test('a false mesh send is a propagation failure and a repeated announce retries it', async () => {
    const a = await spawn({ failSend: true });
    const b = await spawn();
    await link(a, b);
    await waitFor(() => a.discovery.subscriberCount() === 1);
    const card = await ownCard(a, 'retry-forward');
    a.failSend();
    const first = await a.discovery.announce(card);
    const second = await a.discovery.announce(card);
    expect(first).toMatchObject({ fresh: true, propagated: false });
    expect(second).toMatchObject({ fresh: false, propagated: false });
    expect(a.library.rows().some((row: any) => row.name === 'retry-forward')).toBe(true);
    [a, b].forEach((peer) => peer.discovery.close());
  });

  test('cards relay transitively over consented edges (A → B → C)', async () => {
    const a = await spawn();
    const b = await spawn();
    const c = await spawn();
    await link(a, b);
    await link(b, c);
    await tick();
    await a.discovery.announce(await ownCard(a, 'snake'));
    await waitFor(() => c.library.rows().some((r: any) => r.name === 'snake'));
    expect(c.library.rows().some((r: any) => r.name === 'snake')).toBe(true);
    [a, b, c].forEach((p) => p.discovery.close());
  });

  test('unsubscribe stops the stream', async () => {
    const a = await spawn();
    const b = await spawn();
    await link(a, b);
    await waitFor(() => a.discovery.subscriberCount() === 1);
    await b.discovery.unsubscribeFrom(a.identity.did); // B tells A: stop sending
    await waitFor(() => a.discovery.subscriberCount() === 0);
    await a.discovery.announce(await ownCard(a, 'pong'));
    expect(b.library.rows().some((r: any) => r.name === 'pong')).toBe(false);
    [a, b].forEach((p) => p.discovery.close());
  });

  test('discovery OFF means nothing is received — sovereign by default', async () => {
    const a = await spawn();
    const b = await spawn();
    b.discovery.setEnabled(false);       // "I don't want to see shit"
    await a.discovery.announce(await ownCard(a, 'breakout'));
    await link(a, b);
    await tick();
    // b never subscribed to a, so a never serves b a snapshot or items
    expect(b.library.size()).toBe(0);
    [a, b].forEach((p) => p.discovery.close());
  });

  test('a banned publisher is purged, blocklisted, and not re-ingested', async () => {
    const a = await spawn();
    const b = await spawn();
    await link(a, b);
    await tick();
    await a.discovery.announce(await ownCard(a, 'roulette'));
    await waitFor(() => b.library.size() === 1);
    expect(b.library.size()).toBe(1);
    b.discovery.ban(a.identity.did, 'spam');
    expect(b.library.size()).toBe(0);                 // purged
    expect(b.blocked.has(a.identity.did)).toBe(true); // blocklisted
    // a re-announce can't get back in (blocklist-gated ingest)
    expect(await b.discovery.ingest(await ownCard(a, 'roulette', 2))).toBe(false);
    [a, b].forEach((p) => p.discovery.close());
  });

  test('an offscreen restart cannot make a replayed lower sequence fresh', async () => {
    const values = new Map<string, any>();
    const kv = {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: any) => { values.set(key, structuredClone(value)); },
    };
    const publisher = await spawn();
    const current = await ownCard(publisher, 'durable', 9);
    const older = await ownCard(publisher, 'durable', 8);

    const firstGuard = createDwebRollbackGuard({ kv });
    const firstHost = await spawn({
      admitMeta: async (candidate: any) => (await firstGuard.admit(candidate)).accepted === true,
    });
    expect(await firstHost.discovery.ingest(current)).toBe(true);
    firstHost.discovery.close(); // offscreen cache is gone

    // Both the offscreen host and SW closure restart. The durable kv mark is the
    // only remaining state, and it must reject the older signed card.
    const restartedGuard = createDwebRollbackGuard({ kv });
    const restartedHost = await spawn({
      admitMeta: async (candidate: any) => (await restartedGuard.admit(candidate)).accepted === true,
    });
    expect(await restartedHost.discovery.ingest(older)).toBe(false);
    expect(restartedHost.library.size()).toBe(0);
    expect(await restartedHost.discovery.ingest(current)).toBe(true);
    expect(restartedHost.library.rows()[0]).toMatchObject({ seq: 9, head: head(9) });

    [publisher, restartedHost].forEach((p) => p.discovery.close());
  });
});
