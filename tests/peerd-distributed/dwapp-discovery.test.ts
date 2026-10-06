import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { createLibrary } from '../../extension/peerd-distributed/apps/library.js';
import { createDiscovery, DISCOVERY } from '../../extension/peerd-distributed/apps/discovery.js';
import { buildMeta, metaDwappId } from '../../extension/peerd-distributed/apps/meta.js';
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
  const library = createLibrary({ isBlocked: (d: string) => blocked.has(d), ...(over.now ? { now: over.now } : {}) });
  const discovery = createDiscovery({
    mesh, identity, library,
    isBlocked: (d: string) => blocked.has(d),
    block: (d: string) => blocked.add(d),
    ...(over.now ? { now: over.now } : {}),
    ...(over.caps ? { caps: over.caps } : {}),
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

  test('disabled discovery refuses reconciliation and unsolicited signed cards', async () => {
    const a = await spawn();
    const b = await spawn();
    await link(a, b);
    await waitFor(() => a.discovery.subscriberCount() === 1);
    b.discovery.setEnabled(false);
    b.discovery.subscribeAll(); // the production host calls this periodically
    expect(await b.discovery.subscribeTo(a.identity.did)).toBe(false);
    await waitFor(() => a.discovery.subscriberCount() === 0);
    const item = await ownCard(a, 'unsolicited');
    for (const typ of [DISCOVERY.ITEM, DISCOVERY.SNAPSHOT]) {
      a.mesh.send(b.identity.did, await a.mesh.sign(DISCOVERY.CH, typ,
        typ === DISCOVERY.ITEM ? { item } : { items: [item] }));
    }
    await tick();
    expect(b.library.size()).toBe(0);
    expect(a.discovery.subscriberCount()).toBe(0);
    // Pausing globally does not permanently opt out of every neighbor.
    b.discovery.setEnabled(true);
    await waitFor(() => a.discovery.subscriberCount() === 1);
    await a.discovery.announce(item);
    await waitFor(() => b.library.size() === 1);
    expect(b.library.size()).toBe(1);
    [a, b].forEach((p) => { p.discovery.close(); p.mesh.close(); });
  });

  test('an individual unsubscribe survives reconcile and reconnect until explicitly restored', async () => {
    const a = await spawn();
    const b = await spawn();
    await link(a, b);
    await waitFor(() => a.discovery.subscriberCount() === 1);
    await b.discovery.unsubscribeFrom(a.identity.did);
    b.discovery.subscribeAll();
    b.mesh.removeLink(a.identity.did);
    await link(a, b);
    b.discovery.subscribeAll();
    await tick();
    expect(a.discovery.subscriberCount()).toBe(0);
    const item = await ownCard(a, 'after-opt-out');
    a.mesh.send(b.identity.did, await a.mesh.sign(DISCOVERY.CH, DISCOVERY.ITEM, { item }));
    await tick();
    expect(b.library.size()).toBe(0);
    await b.discovery.subscribeTo(a.identity.did);
    await waitFor(() => a.discovery.subscriberCount() === 1);
    await a.discovery.announce(item);
    await waitFor(() => b.library.size() === 1);
    expect(b.library.size()).toBe(1);
    [a, b].forEach((p) => { p.discovery.close(); p.mesh.close(); });
  });

  test('revocation fences an in-flight durable admission across disable and re-enable', async () => {
    let entered = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const a = await spawn();
    const b = await spawn({ admitMeta: async () => { entered = true; await pending; return true; } });
    await link(a, b);
    await waitFor(() => a.discovery.subscriberCount() === 1);
    const item = await ownCard(a, 'revoked-in-flight');
    a.mesh.send(b.identity.did, await a.mesh.sign(DISCOVERY.CH, DISCOVERY.ITEM, { item }));
    await waitFor(() => entered);
    expect(entered).toBe(true);
    b.discovery.setEnabled(false);
    b.discovery.setEnabled(true);
    release();
    await tick();
    expect(b.library.size()).toBe(0);
    a.mesh.send(b.identity.did, await a.mesh.sign(DISCOVERY.CH, DISCOVERY.ITEM, { item }));
    await waitFor(() => b.library.size() === 1);
    expect(b.library.size()).toBe(1);
    [a, b].forEach((p) => { p.discovery.close(); p.mesh.close(); });
  });

  test('a banned neighbor cannot launder another publisher card after reconnect', async () => {
    const a = await spawn();
    const b = await spawn();
    const publisher = await spawn();
    await link(a, b);
    await waitFor(() => a.discovery.subscriberCount() === 1);
    b.discovery.ban(a.identity.did);
    await link(a, b);
    b.discovery.subscribeAll();
    expect(await b.discovery.subscribeTo(a.identity.did)).toBe(false);
    const item = await ownCard(publisher, 'forwarded');
    a.mesh.send(b.identity.did, await a.mesh.sign(DISCOVERY.CH, DISCOVERY.ITEM, { item }));
    await tick();
    expect(b.library.size()).toBe(0);
    expect(a.discovery.subscriberCount()).toBe(0);
    [a, b, publisher].forEach((p) => { p.discovery.close(); p.mesh.close(); });
  });

  test('retired links remove subscriber state and a closed discovery cannot resume', async () => {
    const a = await spawn();
    const b = await spawn();
    await link(a, b);
    await waitFor(() => a.discovery.subscriberCount() === 1);
    b.mesh.removeLink(a.identity.did);
    expect(a.discovery.subscriberCount()).toBe(0);
    expect(b.discovery.subscriberCount()).toBe(0);
    b.discovery.close();
    b.discovery.setEnabled(true);
    expect(await b.discovery.subscribeTo(a.identity.did)).toBe(false);
    expect(await b.discovery.ingest(await ownCard(a, 'after-close'))).toBe(false);
    a.discovery.close(); a.mesh.close(); b.mesh.close();
  });

  test('revoking while a subscription is signing prevents the delayed send', async () => {
    let finish!: () => void;
    const signing = new Promise<void>((resolve) => { finish = resolve; });
    const sent: number[] = [];
    const mesh = {
      peers: () => [{ did: 'neighbor' }],
      onPeer: () => () => {},
      onEnvelope: () => () => {},
      sign: async (_ch: number, typ: number) => {
        if (typ === DISCOVERY.SUB) await signing;
        return { typ };
      },
      send: (_did: string, env: { typ: number }) => { sent.push(env.typ); return true; },
    };
    const discovery = createDiscovery({ mesh, identity: { did: 'self' }, library: createLibrary() });
    const subscribe = discovery.subscribeTo('neighbor');
    discovery.setEnabled(false);
    finish();
    expect(await subscribe).toBe(false);
    expect(sent).not.toContain(DISCOVERY.SUB);
    discovery.close();
  });

  test('replayed snapshot prefixes cannot starve unseen cards in the next budget window', async () => {
    let now = 1_000;
    const a = await spawn();
    const b = await spawn({ now: () => now });
    for (let i = 0; i < 100; i++) await a.discovery.announce(await ownCard(a, `catalog-${i}`));
    await link(a, b);
    await waitFor(() => b.library.size() === 60);
    expect(b.library.size()).toBe(60);
    // Same window still has a hard ceiling despite repeated snapshots.
    b.discovery.subscribeAll();
    await tick();
    expect(b.library.size()).toBe(60);
    now += 61_000;
    b.discovery.subscribeAll();
    await waitFor(() => b.library.size() === 100);
    expect(b.library.size()).toBe(100);
    [a, b].forEach((p) => { p.discovery.close(); p.mesh.close(); });
  });

  test('cursor pages converge past the old snapshot ceiling without lifting receive quotas', async () => {
    let time = 0;
    const source = await spawn({ now: () => time });
    const sink = await spawn({ now: () => time });
    for (let i = 0; i < 275; i += 1) {
      await source.discovery.announce(await ownCard(source, `catalog-${i}`));
    }
    await link(source, sink);
    await waitFor(() => sink.library.size() === 60);
    expect(sink.library.size()).toBe(60);
    // Same-window reconciliation cannot burn through the new-card allowance.
    sink.discovery.subscribeAll(); await tick();
    expect(sink.library.size()).toBe(60);
    for (let page = 2; page <= 5; page += 1) {
      time += 60_000;
      sink.discovery.subscribeAll();
      const expected = Math.min(275, page * 60);
      await waitFor(() => sink.library.size() === expected);
      expect(sink.library.size()).toBe(expected);
    }
    expect(sink.library.rows().map((row: any) => row.name).sort())
      .toEqual(source.library.rows().map((row: any) => row.name).sort());
    source.discovery.close(); sink.discovery.close();
    source.mesh.close(); sink.mesh.close();
  });

  test('an unsolicited page cannot advance a subscribed catalog cursor', async () => {
    const source = await spawn();
    const sink = await spawn();
    await link(source, sink); await tick();
    const card = await ownCard(source, 'unsolicited-page');
    source.mesh.send(sink.identity.did, await source.mesh.sign(DISCOVERY.CH, DISCOVERY.SNAPSHOT, {
      items: [card], page: { id: 'never-requested', after: '', next: 'f'.repeat(64) },
    }));
    await tick();
    expect(sink.library.size()).toBe(0);
    // A subsequent legitimate live publication is unaffected.
    await source.discovery.announce(card);
    await waitFor(() => sink.library.size() === 1);
    expect(sink.library.size()).toBe(1);
    source.discovery.close(); sink.discovery.close();
    source.mesh.close(); sink.mesh.close();
  });

  test('malformed correlated pages cannot skip catalog entries', async () => {
    const publisher = await spawn();
    const cards = await Promise.all(['page-a', 'page-b'].map((slug) => ownCard(publisher, slug)));
    const keyed = await Promise.all(cards.map(async (card) => ({ card, id: await metaDwappId(card) })));
    keyed.sort((a, b) => a.id.localeCompare(b.id));
    const ordered = keyed.map(({ card }) => card);
    const cases = [
      { items: undefined, next: keyed[1]!.id },
      { items: {}, next: keyed[1]!.id },
      { items: [...ordered, ordered[0]], next: keyed[1]!.id },
      { items: [], next: keyed[1]!.id },
      { items: [...ordered].reverse(), next: keyed[0]!.id },
      { items: ordered, next: 'f'.repeat(64) },
    ];
    for (const malformed of cases) {
      let receive: any;
      const sent: any[] = [];
      const mesh = {
        peers: () => [], onPeer: () => () => {},
        onEnvelope: (callback: any) => { receive = callback; return () => {}; },
        sign: async (ch: number, typ: number, body: any) => ({ ch, typ, body }),
        send: (_did: string, env: any) => { sent.push(env); return true; },
      };
      const library = createLibrary();
      const discovery = createDiscovery({ mesh, identity: { did: 'self' }, library,
        caps: { snapshotMax: 2 } });
      await discovery.subscribeTo('remote');
      const first = sent.at(-1).body;
      await receive({ via: 'remote', env: { from: 'remote', ch: DISCOVERY.CH,
        typ: DISCOVERY.SNAPSHOT, body: { items: malformed.items,
          page: { id: first.id, after: first.after, next: malformed.next } } } });
      expect(library.size()).toBe(0);
      await discovery.subscribeTo('remote');
      const retry = sent.at(-1).body;
      expect(retry.after).toBe('');
      expect(retry.id).not.toBe(first.id);
      await receive({ via: 'remote', env: { from: 'remote', ch: DISCOVERY.CH,
        typ: DISCOVERY.SNAPSHOT, body: { items: ordered,
          page: { id: retry.id, after: retry.after, next: null } } } });
      expect(library.size()).toBe(2);
      discovery.close();
    }
    publisher.discovery.close(); publisher.mesh.close();
  });

  test('duplicate-only snapshots still have a bounded processing rate', async () => {
    let handled = 0;
    const mesh = {
      peers: () => [{ did: 'remote' }],
      sign: async (_ch: number, _typ: number, body: any) => ({ body }),
      send: () => true,
      onPeer: () => () => {},
      onEnvelope: (callback: any) => { receive = callback; return () => {}; },
    };
    let receive: any;
    const library = createLibrary();
    const discovery = createDiscovery({ mesh, identity: { did: 'local' }, library,
      caps: { snapshotsPerMin: 2 } });
    await discovery.subscribeTo('remote');
    const items = new Proxy([], { get(target, key, receiver) {
      if (key === 'slice') handled += 1;
      return Reflect.get(target, key, receiver);
    } });
    for (let i = 0; i < 10; i += 1) {
      await receive({ via: 'remote', env: { ch: DISCOVERY.CH, typ: DISCOVERY.SNAPSHOT,
        from: 'remote', body: { items } } });
    }
    expect(handled).toBe(2);
    discovery.close();
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
