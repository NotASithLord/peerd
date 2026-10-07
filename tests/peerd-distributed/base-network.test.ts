import { publishedAppHead } from '../../extension/offscreen/published-app-head.js';
import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { createBaseNetwork } from '../../extension/peerd-distributed/base-network.js';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate: () => boolean, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await tick(10);
};

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

const spawn = async (label: string, options: Record<string, any> = {}) => {
  const identity = await generateIdentity();
  const mesh = createRoomMesh({ roomId: 'base', identity });
  const base = await createBaseNetwork({ identity, mesh, meta: () => ({ name: label }), ...options });
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
    await waitFor(() => peers.every((p) => p.base.presence.list().length >= 4));
    for (const p of peers) expect(p.base.presence.list().length).toBeGreaterThanOrEqual(4);
    for (const p of peers) p.base.close();
  });

  test('a sub-protocol broadcasts, direct-messages, and tracks its own members', async () => {
    const peers = await clique(4);
    const subs = peers.map((p) => p.base.joinSubProtocol('commons'));
    const gotMsg: Record<string, any[]> = {}; const gotDirect: Record<string, any[]> = {};
    subs.forEach((s, i) => { gotMsg[i] = []; gotDirect[i] = []; s.onMessage((m: any) => gotMsg[i].push(m.data)); s.onDirect((m: any) => gotDirect[i].push(m.data)); });
    await waitFor(() => subs.every((s) => s.peers().length >= 3));

    // membership: everyone sees the other 3 on "commons"
    for (const s of subs) expect(s.peers().length).toBeGreaterThanOrEqual(3);

    // broadcast from node0 reaches the other members
    await subs[0].broadcast({ hello: 'commons' });
    await waitFor(() => [1, 2, 3].every((i) => gotMsg[i]
      .some((message) => message.hello === 'commons')));
    for (let i = 1; i < 4; i++) expect(gotMsg[i]).toContainEqual({ hello: 'commons' });

    // a private direct message goes to exactly one member
    subs[0].send(peers[2].identity.did, { secret: 'for n2' });
    await waitFor(() => gotDirect[2].some((message) => message.secret === 'for n2'));
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
    await waitFor(() => [1, 2, 3].every((i) => heard[i]
      .some((a) => a.dwapp_id === dwapp_id)));
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
    await waitFor(() => late.base.heardDwapps()
      .some((a: any) => a.dwapp_id === dwapp_id));

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
    await waitFor(() => b.base.heardDwapps()
      .some((r: any) => r.dwapp_id === dwapp_id));
    expect(b.base.heardDwapps().some((r: any) => r.dwapp_id === dwapp_id)).toBe(true);
    b.base.ban(a.identity.did, 'spam');
    expect(b.base.heardDwapps().some((r: any) => r.dwapp_id === dwapp_id)).toBe(false);
    [a, b].forEach((p) => p.base.close());
  });
});


describe('provider reachability and leases', () => {
  test('dials a discovered provider through the peer supplying its referral', async () => {
    const publisher = await spawn('publisher');
    const broker = await spawn('broker');
    const calls: any[] = [];
    let reader: Awaited<ReturnType<typeof spawn>>;
    reader = await spawn('reader', { dial: async (contact: any) => {
      calls.push(contact);
      if (contact.did !== publisher.identity.did || contact.hints?.broker !== broker.identity.did) return false;
      await link(reader, publisher);
      return true;
    } });
    try {
      await link(publisher, broker);
      await link(reader, broker);
      const { uri } = await publisher.base.publishApp({ name: 'remote', entry: 'index.html', files: { 'index.html': 'hello' } });
      await publisher.base.announceProvider(uri);
      // Keep the provider out of FIND_NODE referrals: GET_PROVIDERS must itself
      // preserve the broker, rather than depending on incidental DHT dialing.
      broker.base.node.dht.routingTable.remove(publisher.identity.did);
      const result = await reader.base.fetchApp(uri, { timeoutMs: 500 });
      expect(result.manifest.publisher).toBe(publisher.identity.did);
      expect(calls.some((contact) => contact.did === publisher.identity.did && contact.hints?.broker === broker.identity.did)).toBe(true);
    } finally { publisher.base.close(); broker.base.close(); reader.base.close(); }
  });

  test('renews shared content before expiry and stops after unshare or close', async () => {
    let clock = 1000;
    const publisher = await spawn('publisher', { now: () => clock });
    const index = await spawn('index', { now: () => clock });
    try {
      await link(publisher, index);
      const { uri, hash } = await publisher.base.publishApp({ name: 'lease', entry: 'index.html', files: { 'index.html': 'hello' } });
      await publisher.base.announceProvider(uri);
      clock += 31 * 60_000;
      await publisher.base.refreshProviders();
      clock += 31 * 60_000;
      expect(await index.base.findProviders(uri)).toContain(publisher.identity.did);
      publisher.base.unserveContent(hash);
      await publisher.base.refreshProviders();
      clock += 61 * 60_000;
      expect(await index.base.findProviders(uri)).not.toContain(publisher.identity.did);
      publisher.base.close();
      await publisher.base.refreshProviders();
    } finally { publisher.base.close(); index.base.close(); }
  });
});

  test('retrying unavailable indexes cannot starve later shared apps', async () => {
    let clock = 1000;
    const publisher = await spawn('publisher', { now: () => clock });
    const attempted: string[] = [];
    publisher.base.node.dht.announceProvider = async (key: string) => {
      attempted.push(key);
      return { key, stored: 0 };
    };
    try {
      for (let i = 0; i < 9; i++) {
        publisher.base.node.content.publish({
          hash: i.toString(16).padStart(64, '0'),
          manifest: { publisher: publisher.identity.did, chunks: [] }, chunks: [],
        });
      }
      await publisher.base.refreshProviders();
      expect(new Set(attempted).size).toBe(8);
      clock += 30_000;
      await publisher.base.refreshProviders();
      expect(new Set(attempted).size).toBe(9);
    } finally { publisher.base.close(); }
  });

  test('unshare aborts an in-flight provider announcement', async () => {
    const publisher = await spawn('publisher');
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    let signal: AbortSignal | undefined;
    publisher.base.node.dht.announceProvider = async (key: string, _entry: unknown, opts: { signal: AbortSignal }) => {
      signal = opts.signal;
      started();
      await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { key, stored: 0 };
    };
    try {
      const { hash } = await publisher.base.publishApp({ name: 'revoke', entry: 'index.html', files: { 'index.html': 'hello' } });
      await pending;
      publisher.base.unserveContent(hash);
      expect(signal?.aborted).toBe(true);
      await publisher.base.refreshProviders();
    } finally { publisher.base.close(); }
  });

  test('close cancels every provider dial before another candidate starts', async () => {
    const contacts = await Promise.all(Array.from({ length: 8 }, () => generateIdentity()));
    const signals: AbortSignal[] = [];
    let started!: () => void;
    const dialing = new Promise<void>((resolve) => { started = resolve; });
    const reader = await spawn('reader', {
      dial: async (_contact: unknown, { signal }: { signal: AbortSignal }) => {
        signals.push(signal);
        if (signals.length === 3) started();
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        return false;
      },
    });
    reader.base.node.dht.findProviderContacts = async () => contacts;
    try {
      const result = reader.base.fetchApp(`peerd://${contacts[0].did}/${'0'.repeat(64)}`).catch((error: Error) => error);
      await dialing;
      reader.base.close();
      expect(await result).toBeInstanceOf(Error);
      expect(signals).toHaveLength(3);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally { reader.base.close(); }
  });

test('provider deadlines abort transports before reusing a dial slot', async () => {
  const contacts = await Promise.all(Array.from({ length: 8 }, () => generateIdentity()));
  let active = 0;
  let peak = 0;
  let attempts = 0;
  const reader = await spawn('reader', {
    dial: async (_contact: unknown, { signal }: { signal: AbortSignal }) => {
      attempts++;
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => { active--; resolve(); }, { once: true }));
      return false;
    },
  });
  reader.base.node.dht.findProviderContacts = async () => contacts;
  const original = globalThis.setTimeout;
  // Compress only the fixed provider deadline; the production cancellation
  // path, worker accounting and transport abort callbacks remain unchanged.
  globalThis.setTimeout = ((fn: (...args: any[]) => void, delay?: number, ...args: any[]) =>
    original(fn, delay === 5_000 ? 5 : delay, ...args)) as typeof setTimeout;
  try {
    await expect(reader.base.fetchApp(`peerd://${contacts[0].did}/${'0'.repeat(64)}`)).rejects.toThrow();
    expect(attempts).toBe(8);
    expect(peak).toBe(3);
    expect(active).toBe(0);
  } finally { globalThis.setTimeout = original; reader.base.close(); }
});

test('publication classifies exact snapshot bytes and reseeding preserves immutable version identity', async () => {
  const p = await spawn('classification');
  try {
    const options = { name: 'Not a filename guess', entry: 'index.html', created: 123,
      files: { 'index.html': '<h1>App</h1>', 'opaque.bin': new Uint8Array([0,97,115,109,1,0,0,0]) } };
    const first = await p.base.publishApp(options);
    expect(first.includesWasm).toBe(true);
    const signed = await p.base.publishMeta({slug:'classification',name:'Module App',seq:1,
      head:publishedAppHead({...first,size:first.packedBytes})});
    expect(signed.card.value.head).toMatchObject({version_id:first.hash,includes_wasm:true});
    expect(p.base.heardDwapps()[0]?.head.includes_wasm).toBe(true);
    const reseed = await p.base.publishApp({...options, expectedHash:first.hash});
    expect(reseed.hash).toBe(first.hash); expect(reseed.includesWasm).toBe(true);
    expect(publishedAppHead({...reseed,size:reseed.packedBytes})).toEqual(signed.card.value.head);
    const changed = {...options,files:{'index.html':'<h1>App</h1>','misleading.wasm':new Uint8Array([1,2,3])}};
    expect((await p.base.publishApp(changed)).includesWasm).toBe(false);
    await expect(p.base.publishApp({...changed, expectedHash:first.hash})).rejects.toThrow('changed');
  } finally { p.base.close(); }
});
