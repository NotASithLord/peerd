import { expect, test } from 'bun:test';
import { joinRoom } from '../../extension/peerd-distributed/transport/rooms.js';
import { createAdmissionGovernor } from '../../extension/peerd-distributed/transport/admission.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const fixture = (members: string[] = []) => {
  const sockets: FakeWS[] = [];
  class FakeWS {
    onmessage: any; onclose: any; onerror: any; readyState = 1;
    constructor() { sockets.push(this); queueMicrotask(() => this.receive({ t: 'room', self: 'self', members })); }
    receive(value: any) { this.onmessage?.({ data: JSON.stringify(value) }); }
    send() {}
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const calls: Array<{ signal: AbortSignal; close: () => void }> = [];
  let live = 0;
  let peak = 0;
  const stalled = ({ signal }: { signal: AbortSignal }) => {
    live++; peak = Math.max(peak, live);
    return new Promise<any>((_resolve, reject) => {
      const close = () => { live--; reject(new Error('closed')); };
      signal.addEventListener('abort', close, { once: true });
      calls.push({ signal, close });
    });
  };
  const transport = {
    connect(_peer: any, opts: any) { return stalled(opts); },
    async accept(opts: any) { return { channel: await stalled(opts) }; },
  };
  return { WebSocket: FakeWS, sockets, transport, calls, live: () => live, peak: () => peak };
};
const receiveOffer = (ws: any, from: string) => ws.receive({ t: 'signal', from, payload: { type: 'offer', sdp: 'offer' } });

test('real room admission bounds unsolicited offers across rooms and reserves outbound capacity', async () => {
  const admission = createAdmissionGovernor({ active: 4, perScope: 3, reservedOutbound: 1, queued: 4, queuedPerScope: 2 });
  const f = fixture();
  const identity = await generateIdentity();
  const a = await joinRoom({ roomId: 'a', identity, admission, WebSocket: f.WebSocket, transport: f.transport });
  const b = await joinRoom({ roomId: 'b', identity, admission, WebSocket: f.WebSocket, transport: f.transport });
  try {
    for (let n = 0; n < 1000; n++) receiveOffer(f.sockets[0], `attacker-${n}`);
    await flush();
    expect(f.live()).toBe(2);
    expect(admission.stats()).toEqual({ active: 2, inbound: 2, queued: 0 });
    receiveOffer(f.sockets[1], 'other-room');
    expect(admission.stats().active).toBe(3);
    const outbound = b.dialVia('broker', 'honest').catch((e) => e);
    expect(admission.stats()).toEqual({ active: 4, inbound: 3, queued: 0 });
    expect(f.live()).toBe(4);
    a.leave();
    expect(f.live()).toBe(2);
    b.leave(); await outbound; await flush();
    expect(admission.stats()).toEqual({ active: 0, inbound: 0, queued: 0 });
    expect(f.live()).toBe(0);
  } finally { a.leave(); b.leave(); }
});

test('large bootstrap roster and relay dials share bounded queued ownership, dedup and cancellation', async () => {
  const admission = createAdmissionGovernor({ active: 4, perScope: 2, reservedOutbound: 1, queued: 4, queuedPerScope: 2 });
  const f = fixture(Array.from({ length: 1000 }, (_, i) => `candidate-${i}`));
  const room = await joinRoom({ roomId: 'roster', identity: await generateIdentity(), admission,
    WebSocket: f.WebSocket, transport: f.transport, awaitInitialRendezvous: false });
  await flush();
  try {
    expect(admission.stats()).toEqual({ active: 2, inbound: 0, queued: 2 });
    expect(f.calls).toHaveLength(2);
    room.leave(); await flush();
    expect(admission.stats()).toEqual({ active: 0, inbound: 0, queued: 0 });
    expect(f.peak()).toBe(2);
    // A fresh scope can use every released slot; the closed scope retains none.
    const next = await joinRoom({ roomId: 'next', identity: await generateIdentity(), admission, url: null, transport: f.transport });
    try {
      const first = next.dialVia('broker', 'same').catch((e) => e);
      const duplicate = await next.dialVia('broker2', 'same').catch((e) => e);
      expect(duplicate.reason).toBe('duplicate');
      const ac = new AbortController(); ac.abort();
      expect((await next.dialVia('broker', 'aborted', { signal: ac.signal }).catch((e) => e)).reason).toBe('cancelled');
      expect(f.calls).toHaveLength(3);
      next.leave(); await first;
    } finally { next.leave(); }
  } finally { room.leave(); }
});

test('another room progresses while one room has a full queue; cancellation does not launch retired work', async () => {
  const admission = createAdmissionGovernor({ active: 4, perScope: 2, reservedOutbound: 1, queued: 4, queuedPerScope: 2 });
  const f = fixture(); const identity = await generateIdentity();
  const a = await joinRoom({ roomId: 'a', identity, admission, url: null, transport: f.transport });
  const b = await joinRoom({ roomId: 'b', identity, admission, url: null, transport: f.transport });
  const pending = Array.from({ length: 10 }, (_, n) => a.dialVia('broker', `a-${n}`).catch((e) => e));
  const other = b.dialVia('broker', 'b').catch((e) => e);
  expect(admission.stats()).toEqual({ active: 3, inbound: 0, queued: 2 });
  expect(f.calls).toHaveLength(3);
  a.leave();
  expect(f.calls).toHaveLength(3);
  expect(admission.stats()).toEqual({ active: 1, inbound: 0, queued: 0 });
  b.leave(); await Promise.all([...pending, other]);
});

test('signaling overflow aborts an admitted attempt before unbounded handoff accumulation', async () => {
  const admission = createAdmissionGovernor(); const f = fixture();
  const room = await joinRoom({ roomId: 'signal', identity: await generateIdentity(), admission, WebSocket: f.WebSocket, transport: f.transport });
  try {
    receiveOffer(f.sockets[0], 'sender');
    for (let n = 0; n < 100; n++) f.sockets[0].receive({ t: 'signal', from: 'sender', payload: { ice: { candidate: `candidate-${n}` } } });
    await flush();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.signal.aborted).toBe(true);
    expect(admission.stats().active).toBe(0);
    // UTF-8 byte ceiling also applies before an offer constructs any peer.
    f.sockets[0].receive({ t: 'signal', from: 'huge', payload: { type: 'offer', sdp: '🦀'.repeat(40000) } });
    expect(f.calls).toHaveLength(1);
  } finally { room.leave(); }
});

test('reservation includes HELLO and late channels cannot admit after shutdown', async () => {
  const admission = createAdmissionGovernor();
  const [local, remote] = memoryPair();
  let resolveLate!: (channel: any) => void;
  const transport = { connect: () => new Promise((resolve) => { resolveLate = resolve; }) };
  const room = await joinRoom({ roomId: 'hello', identity: await generateIdentity(), admission, url: null, transport });
  const pending = room.dialVia('broker', 'peer').catch((e) => e);
  resolveLate(local); await flush();
  expect(admission.stats().active).toBe(1); // connected, but remote has not proved identity
  room.leave(); await pending;
  expect(local.isClosed()).toBe(true);
  expect(admission.stats().active).toBe(0);
  remote.close();

  const lateRoom = await joinRoom({ roomId: 'late', identity: await generateIdentity(), admission, url: null, transport });
  const late = lateRoom.dialVia('broker', 'peer').catch((e) => e);
  lateRoom.leave(); await late;
  const [lateLocal, lateRemote] = memoryPair();
  resolveLate(lateLocal); await flush();
  expect(lateLocal.isClosed()).toBe(true);
  expect(lateRoom.peers()).toHaveLength(0);
  lateRemote.close();
});

test('relay offers pass the same admission gate and duplicate sessions cannot consume extra slots', async () => {
  const { createRoomMesh, CTRL } = await import('../../extension/peerd-distributed/transport/mesh.js');
  const admission = createAdmissionGovernor({ active: 4, perScope: 2, reservedOutbound: 1 });
  const f = fixture(); const identity = await generateIdentity(); const sender = await generateIdentity();
  const room = await joinRoom({ roomId: 'relay', identity, admission, url: null, transport: f.transport });
  const source = createRoomMesh({ roomId: 'relay', identity: sender });
  const [local, remote] = memoryPair(); room.mesh.addLink(local, sender.did);
  const offer = async (sid: string) => {
    let off = () => {};
    const delivered = new Promise<void>((resolve) => { off = room.mesh.onRelay(() => resolve()); });
    remote.send(await source.sign(0, CTRL.RELAY, { room: 'relay', to: identity.did, kind: 'offer', sid, payload: { type: 'offer', sdp: 'offer' } }));
    await delivered; off();
  };
  try {
    await offer('one');
    expect(f.calls).toHaveLength(1);
    expect(admission.stats()).toEqual({ active: 1, inbound: 1, queued: 0 });
    await offer('two'); // authenticated DID cannot multiply attempts with new session IDs
    expect(f.calls).toHaveLength(1);
    const outbound = room.dialVia(sender.did, 'other').catch((e) => e);
    expect(admission.stats()).toEqual({ active: 2, inbound: 1, queued: 0 });
    room.leave(); await outbound; await flush();
    expect(f.live()).toBe(0);
  } finally { room.leave(); source.close(); remote.close(); }
});

test('attempt deadline cancels transport and lets a queued candidate construct its peer', async () => {
  const admission = createAdmissionGovernor({ active: 2, perScope: 2, reservedOutbound: 1, timeoutMs: 100 });
  const f = fixture();
  const room = await joinRoom({ roomId: 'deadline', identity: await generateIdentity(), admission, url: null, transport: f.transport });
  try {
    const first = room.dialVia('broker', 'first').catch((e) => e);
    const second = room.dialVia('broker', 'second').catch((e) => e);
    const third = room.dialVia('broker', 'third').catch((e) => e);
    expect(f.calls).toHaveLength(2);
    expect((await first).reason).toBe('timed out');
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0]!.signal.aborted).toBe(true);
    room.leave(); await Promise.all([second, third]);
    expect(admission.stats()).toEqual({ active: 0, inbound: 0, queued: 0 });
  } finally { room.leave(); }
});
