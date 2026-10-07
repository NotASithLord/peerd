import { expect, test } from 'bun:test';
import { signalingStep, initialSignalingState } from '../../extension/peerd-distributed/transport/signaling.js';
import { SPARSE_PUBLIC_PROFILE, PUBLIC_ROOM } from '../../extension/peerd-distributed/transport/rendezvous-profile.js';
import { joinRoom } from '../../extension/peerd-distributed/transport/rooms.js';
import { createAdmissionGovernor } from '../../extension/peerd-distributed/transport/admission.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { createPeerNode } from '../../extension/peerd-distributed/peer-node.js';

const deadline = async <T>(promise: Promise<T>, stage: string, ms = 10_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`fixture ${stage} deadline`)), ms); })]); }
  finally { clearTimeout(timer!); }
};

// Real reducer/client/room/admission/HELLO/mesh. Only socket dispatch and the
// native ICE carrier are replaced. Each browser owns its own governor.
const fixture = () => {
  let now = Date.now(), next = 0, seed = 42, nextTimer = 0, online = true, legacyServer = false, sampleRequests = 0;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  const peaks = { active: 0, queued: 0, timers: 0, carriers: 0 };
  let liveCarriers = 0;
  let teardown: null | { carriers: number; pending: number; timers: number; sockets: number; admission: ReturnType<ReturnType<typeof createAdmissionGovernor>['stats']>[] } = null;
  const tasks = new Map<number, { at: number; fn: () => void; interval?: number }>();
  const timers = {
    setTimeout(fn: () => void, ms: number) { const id = ++nextTimer; tasks.set(id, { at: now + ms, fn }); peaks.timers = Math.max(peaks.timers, tasks.size); return id; },
    clearTimeout(id: number) { tasks.delete(id); },
    setInterval(fn: () => void, ms: number) { const id = ++nextTimer; tasks.set(id, { at: now + ms, fn, interval: ms }); peaks.timers = Math.max(peaks.timers, tasks.size); return id; },
    clearInterval(id: number) { tasks.delete(id); },
  };
  const sockets = new Map<string, Socket>();
  const offerTrace = new Map<string, any>();
  let holdOffers = false; const held: any[] = [];
  let state = initialSignalingState();
  const step = (event: any) => {
    if (event.t === 'sample') sampleRequests++;
    const result = signalingStep(state, legacyServer && event.t === 'join' ? { ...event, profile: undefined } : event, { now, random }); state = result.state;
    for (const action of result.actions) {
      const ws = sockets.get(action.connId);
      if (action.t === 'send') queueMicrotask(() => {
        if (action.msg?.payload?.type === 'offer') offerTrace.set(action.msg.payload.sdp, { target: ws?.owner, stats: ws ? governors[ws.owner]?.stats() : null });
        ws?.receive(action.msg);
        if (ws) observe(governors[ws.owner]);
      }); else ws?.close();
    }
  };
  class Socket {
    onmessage: any; onclose: any; onerror: any; readyState = 1; id = `member-${++next}`; owner = governors.length - 1;
    constructor(url: string) {
      if (!online) { queueMicrotask(() => this.close()); return; }
      sockets.set(this.id, this); const u = new URL(url);
      queueMicrotask(() => step({ t: 'join', connId: this.id, key: u.searchParams.get('key'), profile: u.searchParams.get('profile') }));
    }
    receive(message: any) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) }); }
    send(raw: string) {
      if (this.readyState !== 1) return;
      const event = { ...JSON.parse(raw), connId: this.id };
      if (holdOffers && event.t === 'signal' && event.payload?.type === 'offer') held.push(event); else step(event);
    }
    close() { if (this.readyState !== 1) return; this.readyState = 3; sockets.delete(this.id); step({ t: 'leave', connId: this.id }); this.onclose?.(); }
  }
  const pending = new Map<string, ReturnType<typeof memoryPair>[number]>();
  const carriers = new Set<ReturnType<typeof memoryPair>[number]>();
  // Samples at native construction and socket delivery; mutation-by-mutation
  // governor ceilings are proved separately by admission unit tests.
  const observe = (governor: ReturnType<typeof createAdmissionGovernor> | undefined) => {
    if (!governor) return;
    const stats = governor.stats(); peaks.active = Math.max(peaks.active, stats.active); peaks.queued = Math.max(peaks.queued, stats.queued);
  };
  const makeTransport = (governor: ReturnType<typeof createAdmissionGovernor>) => ({
    async connect(_peer: any, { signaling, signal }: any) {
      observe(governor);
      const [local, remote] = memoryPair(); carriers.add(local); carriers.add(remote);
      liveCarriers += 2; peaks.carriers = Math.max(peaks.carriers, liveCarriers);
      local.onClose(() => { liveCarriers--; }); remote.onClose(() => { liveCarriers--; });
      const id = `offer-${++next}`; pending.set(id, remote);
      const cleanup = () => { pending.delete(id); local.close(); remote.close(); };
      signal.addEventListener('abort', cleanup, { once: true });
      await signaling.send({ type: 'offer', sdp: id });
      // The accepted carrier survives reservation cleanup; abort still closes
      // abandoned offers. Real transport owns equivalent pre-admission cleanup.
      local.onClose(() => { signal.removeEventListener('abort', cleanup); pending.delete(id); });
      signaling.onRemote((m: any) => { if (m.type === 'answer') signal.removeEventListener('abort', cleanup); });
      return local;
    },
    async accept({ offer, signaling }: any) {
      observe(governor);
      const channel = pending.get(offer.sdp); if (!channel) throw new Error('unknown offer');
      pending.delete(offer.sdp); await signaling.send({ type: 'answer', sdp: offer.sdp });
      return { channel: Promise.resolve(channel) };
    },
  });
  const rooms: Awaited<ReturnType<typeof joinRoom>>[] = [];
  const governors: ReturnType<typeof createAdmissionGovernor>[] = [];
  const nodes: Awaited<ReturnType<typeof createPeerNode>>[] = [];
  const add = async () => {
    const identity = await generateIdentity(); const admission = createAdmissionGovernor({ timers }); governors.push(admission);
    const owner = governors.length - 1;
    class OwnedSocket extends Socket { constructor(url: string) { super(url); this.owner = owner; } }
    const room = await joinRoom({ identity, roomId: PUBLIC_ROOM, profile: SPARSE_PUBLIC_PROFILE, url: 'ws://fixture',
      awaitInitialRendezvous: false, WebSocket: OwnedSocket, transport: makeTransport(admission), admission, now: () => now, random, timers });
    room.mesh.stop(); // explicit churn below; wall-clock liveness has its own tests
    rooms.push(room);
    if (room.rendezvous() !== 'up') {
      const up = Promise.withResolvers<void>();
      const off = room.onStatus(({ rendezvous }) => { if (rendezvous === 'up') up.resolve(); });
      try { await deadline(up.promise, 'join acknowledgment'); } finally { off(); }
    }
    await advance(0);
    const node = await createPeerNode({ identity, mesh: room.mesh, now: () => now }); nodes.push(node);
    return room;
  };
  const tick = (ms: number) => {
    now += ms;
    for (const [id, task] of [...tasks]) if (task.at <= now && tasks.has(id)) {
      if (task.interval) task.at = now + task.interval; else tasks.delete(id);
      task.fn();
    }
  };
  const advance = async (ms: number) => {
    tick(ms);
    const deadline = Date.now() + 3_000;
    await new Promise<void>(resolve => setImmediate(resolve));
    while (governors.some(g => g.stats().active || g.stats().queued)) {
      const stats = governors.map(g => g.stats());
      // Unaccepted offers legitimately remain until protocol deadlines. Wait
      // only for accepted-channel crypto to settle; tests advance the real
      // injected deadlines separately and assert those old offers retire.
      if (pending.size > 0 && stats.every(s => !s.inbound && !s.queued)
        && stats.reduce((n, s) => n + s.active, 0) === pending.size) break;
      if (Date.now() > deadline) throw new Error(`fixture admission did not settle ${JSON.stringify(stats)} pending:${JSON.stringify([...pending.keys()].map(key => ({ key, ...offerTrace.get(key) })))}`);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  const outage = () => { online = false; for (const ws of [...sockets.values()]) ws.close(); };
  return { add, rooms, nodes, governors, tasks, pending, sockets, advance, outage,
    holdOffers: () => { holdOffers = true; }, held,
    releaseOffers: () => { holdOffers = false; for (const event of held.splice(0)) step(event); },
    liveCarriers: () => liveCarriers, observedPeaks: peaks, teardown: () => teardown,
    samples: () => sampleRequests,
    restore: () => { online = true; }, restoreLegacy: () => { online = true; legacyServer = true; }, membership: () => state.rooms[PUBLIC_ROOM]?.length ?? 0,
    close() {
      try { for (const room of rooms) room.leave(); for (const node of nodes) node.close(); }
      finally {
        // Capture production ownership before fallback cleanup. The safety net
        // must not make a leaked carrier look like successful room teardown.
        teardown = { carriers: liveCarriers, pending: pending.size, timers: tasks.size, sockets: sockets.size,
          admission: governors.map(governor => governor.stats()) };
        for (const channel of carriers) channel.close();
      }
    } };
};

const assertTeardown = (f: ReturnType<typeof fixture>) => {
  const receipt = f.teardown();
  expect(receipt).not.toBeNull();
  expect(receipt).toMatchObject({ carriers: 0, pending: 0, timers: 0, sockets: 0 });
  for (const admission of receipt!.admission) expect(admission).toEqual({ active: 0, inbound: 0, queued: 0 });
};

test('17 clients bootstrap through negotiated production paths, heal churn and exchange multi-hop application traffic', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 17; index++) await f.add();
    await f.advance(0);
    expect(f.membership()).toBe(17);
    for (const room of f.rooms) { expect(room.peers().length).toBeGreaterThan(0); expect(room.peers().length).toBeLessThanOrEqual(16); }
    const source = f.nodes[0]!;
    expect(f.nodes.some(n => n !== source && !source.mesh.hasLink(n.did))).toBe(true);
    const received = new Set<string>(); const all = Promise.withResolvers<void>();
    for (const node of f.nodes.slice(1)) node.gossip.subscribe('sparse-test', () => { received.add(node.did); if (received.size === 16) all.resolve(); });
    source.gossip.subscribe('sparse-test', () => {});
    await source.gossip.publish('sparse-test', { through: 'real mesh' });
    await deadline(all.promise, 'multi-hop delivery');
    expect(received.size).toBe(16);
    const isolated = f.rooms[16]!;
    for (const peer of isolated.peers()) isolated.mesh.removeLink(peer.did);
    await f.advance(20_000);
    expect(isolated.peers().length).toBeGreaterThan(0);
    const unanswered = [...f.pending.keys()];
    await f.advance(15_000);
    for (const offer of unanswered) expect(f.pending.has(offer)).toBe(false);
    f.outage();
    const survivors = f.rooms.reduce((sum, room) => sum + room.peers().length, 0);
    expect(survivors).toBeGreaterThan(0);
    f.restore(); await f.advance(30_000);
    expect(f.membership()).toBe(17);
    for (const room of f.rooms) expect(room.peers().length).toBeLessThanOrEqual(16);
    for (const governor of f.governors) { expect(governor.stats().active).toBeLessThanOrEqual(8); expect(governor.stats().queued).toBeLessThanOrEqual(64); }
  } finally { f.close(); }
  assertTeardown(f);
  expect(f.tasks.size).toBe(0); expect(f.sockets.size).toBe(0); expect(f.pending.size).toBe(0);
  for (const governor of f.governors) expect(governor.stats()).toEqual({ active: 0, inbound: 0, queued: 0 });
}, 15_000);


test('simultaneous resampling resolves crossing offers while preserving both local exploration owners', async () => {
  const f = fixture();
  try {
    const a = await f.add(); const b = await f.add();
    await f.advance(0);
    expect(a.peers()).toHaveLength(1); expect(b.peers()).toHaveLength(1);
    a.mesh.removeLink(b.did);
    await f.advance(0); // settle peer-loss maintenance before advancing its timer
    f.holdOffers();
    await f.advance(20_000);
    expect(f.held).toHaveLength(2); // explicit transport barrier, no timing guess
    f.releaseOffers(); await f.advance(0);
    expect(a.peers().map(peer => peer.did)).toEqual([b.did]);
    expect(b.peers().map(peer => peer.did)).toEqual([a.did]);
    expect(a.mesh.locallySelectedCount()).toBe(1); expect(b.mesh.locallySelectedCount()).toBe(1);
    expect(f.liveCarriers()).toBe(2); expect(f.pending.size).toBe(0);
  } finally { f.close(); }
  assertTeardown(f);
  expect(f.tasks.size).toBe(0);
});


test('old-server reconnect disables sampling but preserves established public reservations', async () => {
  const f = fixture(); const extra: ReturnType<typeof memoryPair>[] = [];
  try {
    const a = await f.add(); await f.add(); await f.advance(0);
    f.outage(); f.restoreLegacy(); await f.advance(30_000);
    expect(f.membership()).toBe(2); expect(a.rendezvous()).toBe('up');
    const inbound = a.peers().length - a.mesh.locallySelectedCount();
    for (let index = inbound; index < 14; index++) {
      const pair = memoryPair(); extra.push(pair); expect(a.mesh.addLink(pair[0], (await generateIdentity()).did)).toBe(true);
    }
    const overflow = memoryPair(); extra.push(overflow);
    expect(a.mesh.addLink(overflow[0], (await generateIdentity()).did)).toBe(false);
    await f.advance(0);
    expect(a.peers().length).toBeLessThanOrEqual(16);
    const sampled = f.samples(); await f.advance(20_000); expect(f.samples()).toBe(sampled);
  } finally { f.close(); for (const pair of extra) for (const channel of pair) channel.close(); }
  assertTeardown(f);
  expect(f.tasks.size).toBe(0);
});


for (const count of [100, 1000]) test(`${count} clients use production bootstrap, bounded resources and recover from churn/outage`, async () => {
  const f = fixture(); const started = performance.now();
  const bounds = () => {
    for (const room of f.rooms) expect(room.peers().length).toBeLessThanOrEqual(16);
    expect(f.observedPeaks.active).toBeLessThanOrEqual(8); expect(f.observedPeaks.queued).toBeLessThanOrEqual(64);
    // Per room:20 governor entries +4 HELLO timers +join/keepalive/maintenance.
    expect(f.observedPeaks.timers).toBeLessThanOrEqual(count * 27);
    // Established ends plus both fake carrier halves for in-flight outbound.
    expect(f.observedPeaks.carriers).toBeLessThanOrEqual(count * 24);
  };
  const deliver = async (topic: string) => {
    const received = new Set<string>(); const all = Promise.withResolvers<void>();
    const off = f.nodes.slice(1).map(node => node.gossip.subscribe(topic, () => { received.add(node.did); if (received.size === count - 1) all.resolve(); }));
    off.push(f.nodes[0]!.gossip.subscribe(topic, () => {}));
    try { await f.nodes[0]!.gossip.publish(topic, { count }); await deadline(all.promise, 'scaled multi-hop delivery', 20_000); }
    finally { for (const unsubscribe of off) unsubscribe(); }
    expect(received.size).toBe(count - 1);
  };
  try {
    for (let index = 0; index < count; index++) await f.add();
    expect(f.membership()).toBe(count);
    for (let round = 0; round < 6 && f.rooms.some(room => room.peers().length === 0); round++) await f.advance(20_000);
    for (const room of f.rooms) expect(room.peers().length).toBeGreaterThan(0);
    bounds(); await deliver('scale-initial');
    const isolated = f.rooms[count - 1]!;
    for (const peer of isolated.peers()) isolated.mesh.removeLink(peer.did);
    await f.advance(0); await f.advance(20_000);
    for (let round = 0; round < 5 && !isolated.peers().length; round++) await f.advance(20_000);
    expect(isolated.peers().length).toBeGreaterThan(0); bounds();
    f.outage(); expect(f.rooms.some(room => room.peers().length > 0)).toBe(true);
    f.restore(); await f.advance(30_000);
    expect(f.membership()).toBe(count); bounds(); await deliver('scale-recovered');
    console.log(`sparse production path: ${count} clients, ${Math.round(performance.now() - started)}ms, observed peaks ${JSON.stringify(f.observedPeaks)}`);
  } finally { f.close(); }
  assertTeardown(f);
  expect(f.tasks.size).toBe(0); expect(f.pending.size).toBe(0); expect(f.sockets.size).toBe(0); expect(f.liveCarriers()).toBe(0);
  for (const governor of f.governors) expect(governor.stats()).toEqual({ active: 0, inbound: 0, queued: 0 });
}, 60_000);
