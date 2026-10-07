import { expect, test } from 'bun:test';
import { createChannelClient, createContentResponder } from '../../extension/peerd-distributed/content/transfer.js';
import { createContentServiceBudget } from '../../extension/peerd-distributed/content/service-budget.js';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { joinRoom } from '../../extension/peerd-distributed/transport/rooms.js';
import { memoryPair, createBufferedChannel } from '../../extension/peerd-distributed/transport/channel.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { createOutgoingGovernor, createOutgoingWriter } from '../../extension/peerd-distributed/transport/outgoing.js';
import { buildSnapshotOffer, buildSyncPull, createSurfaceCollector } from '../../extension/peerd-distributed/self/sync.js';
import { createSyncSource } from '../../extension/peerd-distributed/self/host.js';
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test('content response timeout starts after queued send, while cancellation removes unsent requests', async () => {
  const originalSet = globalThis.setTimeout; const originalClear = globalThis.clearTimeout;
  let now = 0; let next = 0;
  const timers = new Map<number, { at: number; call: () => void }>();
  globalThis.setTimeout = ((call: () => void, delay: number) => { const id = ++next; timers.set(id, { at: now + delay, call }); return id; }) as any;
  globalThis.clearTimeout = ((id: number) => timers.delete(Number(id))) as any;
  const advance = (time: number) => {
    now += time;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.call(); }
  };
  let handler: any; let accept!: () => void; let sendSignal!: AbortSignal;
  const client = createChannelClient({
    setHandler: (h) => { handler = h; },
    send: (_msg, options) => { sendSignal = options!.signal!; return new Promise<void>((resolve, reject) => {
      accept = resolve;
      sendSignal.addEventListener('abort', () => reject(new Error('send aborted')), { once: true });
    }); },
  }, 10);
  try {
    let outcome: any;
    const first = client.manifest('first').then((v) => { outcome = v; }, (e) => { outcome = e; });
    advance(50); await flush();
    expect(outcome).toBeUndefined();
    accept(); await flush();
    advance(9); handler({ t: 'MANIFEST', hash: 'first', manifest: {} });
    await first;
    expect(outcome.t).toBe('MANIFEST');
    const ac = new AbortController();
    const cancelled = client.manifest('cancel', ac.signal).catch(e => e);
    ac.abort();
    expect((await cancelled).message).toContain('cancelled');
    expect(sendSignal.aborted).toBe(true);
    expect(timers.size).toBe(0);
  } finally { client.close(); globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});

test('content encoding admission is shared and happens before looking up or encoding a chunk', async () => {
  const budget = createContentServiceBudget({ total: 2, perLink: 1 });
  let reads = 0;
  const respond = createContentResponder({ budget, store: {
    getManifest: () => null, getChunk: () => { reads++; return new Uint8Array(64); },
  } });
  const owner = {}; let finishA!: () => void; let finishB!: () => void;
  const first = respond({ t: 'CHUNK_REQ', hash: 'a' }, () => new Promise<void>(r => { finishA = r; }), owner);
  await expect(respond({ t: 'CHUNK_REQ', hash: 'b' }, () => {}, owner)).rejects.toThrow('overloaded');
  expect(reads).toBe(1);
  const second = respond({ t: 'CHUNK_REQ', hash: 'c' }, () => new Promise<void>(r => { finishB = r; }), {});
  await expect(respond({ t: 'CHUNK_REQ', hash: 'd' }, () => {}, {})).rejects.toThrow('overloaded');
  expect(reads).toBe(2);
  finishA(); finishB(); await Promise.all([first, second]);
  expect(budget.stats()).toEqual({ active: 0, links: 0 });
});

test('replacing a link aborts its queued send without sending on or closing its replacement', async () => {
  const [identity, remote] = await Promise.all([generateIdentity(), generateIdentity()]);
  const mesh = createRoomMesh({ roomId: 'replace', identity });
  const [old, oldRemote] = memoryPair();
  let signal!: AbortSignal;
  old.send = async (_msg, options) => { signal = options!.signal!; await new Promise<void>((_r, reject) => {
    signal.addEventListener('abort', () => reject(new Error('retired')), { once: true });
  }); };
  mesh.addLink(old, remote.did);
  const pending = mesh.send(remote.did, { queued: true });
  const [fresh, freshRemote] = memoryPair(); let received: any;
  freshRemote.setHandler((msg) => { received = msg; });
  mesh.addLink(fresh, remote.did);
  expect(await pending).toBe(false);
  expect(signal.aborted).toBe(true);
  expect(mesh.hasLink(remote.did)).toBe(true);
  expect(await mesh.send(remote.did, { fresh: true })).toBe(true);
  expect(received).toEqual({ fresh: true });
  mesh.close(); oldRemote.close(); freshRemote.close();
});

test('self-sync source awaits bounded transport drain and completes a surface larger than its queue', async () => {
  const bytes = new Uint8Array(1024 * 1024); bytes.fill(71);
  const { manifest, payloads } = await buildSnapshotOffer({ surfaces: { memory: { bytes, version: 1, count: 1 } } });
  const entry = manifest.surfaces[0]!;
  const collector = createSurfaceCollector({ entry, snapshotId: manifest.snapshotId });
  const governor = createOutgoingGovernor({ nativeBytes: 100_000, linkBytes: 200_000, realmBytes: 300_000, reservedBytes: 16_000 });
  let completion: any; let peak = 0;
  const delivered: Promise<any>[] = [];
  class SlowChannel extends EventTarget {
    readyState = 'open'; bufferedAmount = 100_000; bufferedAmountLowThreshold = 0;
    send(encoded: string) {
      this.bufferedAmount += Buffer.byteLength(encoded);
      delivered.push(collector.accept(JSON.parse(encoded)).then((v) => { completion = v; }));
      // The native transport yields a task before drain; producers must not
      // build another full surface or overflow while the peer is slow.
      queueMicrotask(() => { this.bufferedAmount = 0; this.dispatchEvent(new Event('bufferedamountlow')); });
    }
  }
  const dc = new SlowChannel();
  const writer = createOutgoingWriter({ dc: dc as any, governor });
  const source = createSyncSource({ manifest, payloads, coordinator: { isSelfDevice: () => true },
    send: async (_did, frame) => { const sent = writer.send(frame); peak = Math.max(peak, governor.stats().bytes); await sent; },
  });
  try {
    const serving = source.onFrame('self-device', buildSyncPull({ snapshotId: manifest.snapshotId, surface: 'memory' }));
    // Start a deliberately stalled transport, then let it drain normally.
    dc.bufferedAmount = 0; dc.dispatchEvent(new Event('bufferedamountlow'));
    await serving; await Promise.all(delivered);
    expect(completion.state).toBe('complete');
    expect(completion.bytes).toEqual(bytes);
    expect(peak).toBeLessThanOrEqual(200_000);
    expect(delivered.length).toBeGreaterThan(10);
  } finally { writer.close(); }
});


test('cancelling a relay dial withdraws its queued broker offer without closing the broker link', async () => {
  const identity = await generateIdentity(); const broker = await generateIdentity();
  const governor = createOutgoingGovernor();
  class StalledChannel extends EventTarget {
    readyState = 'open'; bufferedAmount = 1_000_000; bufferedAmountLowThreshold = 0;
    sent: string[] = [];
    send(encoded: string) { this.sent.push(encoded); }
  }
  const dc = new StalledChannel();
  const writer = createOutgoingWriter({ dc: dc as any, governor });
  let queued!: () => void;
  const started = new Promise<void>((resolve) => { queued = resolve; });
  const brokerChannel = createBufferedChannel({ close: writer.close, send: (message, options) => {
    const sent = writer.send(message, options); queued(); return sent;
  } });
  const room = await joinRoom({ roomId: 'relay-cancel', identity, url: null, transport: {
    async connect(_peer: any, { signaling }: any) {
      await signaling.send({ type: 'offer', sdp: 'offer' });
      throw new Error('cancelled offer must never transmit');
    },
  } });
  room.mesh.addLink(brokerChannel, broker.did);
  const ac = new AbortController();
  const dial = room.dialVia(broker.did, 'target', { signal: ac.signal }).catch(error => error);
  try {
    await started;
    expect(governor.stats().frames).toBe(1);
    ac.abort(); await dial; await flush();
    expect(governor.stats().frames).toBe(0);
    dc.bufferedAmount = 0; dc.dispatchEvent(new Event('bufferedamountlow'));
    expect(dc.sent).toHaveLength(0);
    expect(room.mesh.hasLink(broker.did)).toBe(true);
  } finally { room.leave(); writer.close(); }
});

test('a blocked ping cannot delay healthy peers or accumulate duplicate liveness sends', async () => {
  const identity = await generateIdentity();
  let clock = 0;
  const mesh = createRoomMesh({ roomId: 'pings', identity, now: () => clock, pingIntervalMs: 3, idleTimeoutMs: 100_000 });
  const [slow, slowRemote] = memoryPair(); const [fast, fastRemote] = memoryPair();
  let slowSends = 0; let fastSends = 0; let healthyProgress!: () => void;
  const progressed = new Promise<void>((resolve) => { healthyProgress = resolve; });
  slow.send = async (_message, options) => {
    slowSends++;
    await new Promise<void>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new Error('closed')), { once: true }));
  };
  fast.send = async () => { if (++fastSends === 3) healthyProgress(); };
  mesh.addLink(slow, 'slow'); mesh.addLink(fast, 'fast');
  clock = 100;
  try {
    mesh.start(); await progressed;
    expect(slowSends).toBe(1);
    expect(fastSends).toBe(3);
  } finally { mesh.close(); slowRemote.close(); fastRemote.close(); }
});
