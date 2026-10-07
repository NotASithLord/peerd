import { expect, test } from 'bun:test';
import { openRendezvous } from '../../extension/peerd-distributed/transport/signaling-client.js';
import { PUBLIC_ROOM, SPARSE_PUBLIC_PROFILE, INTRODUCTION_LIMIT, SAMPLE_INTERVAL_MS } from '../../extension/peerd-distributed/transport/rendezvous-profile.js';

const fixture = () => {
  let now = 0, next = 0;
  const tasks = new Map<number, { at: number; fn: () => void; interval?: number }>();
  const timers = {
    setTimeout(fn: () => void, ms: number) { const id = ++next; tasks.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id: number) { tasks.delete(id); },
    setInterval(fn: () => void, ms: number) { const id = ++next; tasks.set(id, { at: now + ms, fn, interval: ms }); return id; },
    clearInterval(id: number) { tasks.delete(id); },
  };
  const sockets: FakeWS[] = [];
  class FakeWS {
    onmessage: any; onclose: any; onerror: any; readyState = 1; sent: any[] = [];
    constructor(public url: string) { sockets.push(this); }
    receive(message: any) { this.onmessage?.({ data: JSON.stringify(message) }); }
    send(message: string) { this.sent.push(JSON.parse(message)); }
    close() { if (this.readyState !== 3) { this.readyState = 3; this.onclose?.(); } }
  }
  const advance = (ms: number) => {
    now += ms;
    for (const [id, task] of [...tasks]) if (task.at <= now && tasks.has(id)) {
      if (task.interval) task.at = now + task.interval; else tasks.delete(id);
      task.fn();
    }
  };
  const open = (opts: any = {}) => openRendezvous({ url: 'ws://test', room: PUBLIC_ROOM,
    profile: SPARSE_PUBLIC_PROFILE, WebSocket: FakeWS, now: () => now, timers, ...opts });
  const ack = { t: 'room', self: 'self', members: ['peer'], profile: SPARSE_PUBLIC_PROFILE,
    sampleLimit: INTRODUCTION_LIMIT, sampleIntervalMs: SAMPLE_INTERVAL_MS };
  return { sockets, open, advance, tasks, ack };
};

test('negotiation is explicit, private/website profiles stay off, old server falls back without sampling', async () => {
  for (const opts of [{}, { profile: undefined }, { room: 'private' }, { kind: 'website' }]) {
    const f = fixture(); const joining = f.open(opts); const ws = f.sockets[0]!;
    expect(ws.url.includes('profile=')).toBe(Object.keys(opts).length === 0);
    ws.receive({ t: 'room', self: 's', members: [] });
    const session = await joining;
    expect(session.profile).toBeNull();
    await expect(session.sample()).rejects.toThrow('unavailable');
    session.close(); expect(f.tasks.size).toBe(0);
  }
});

test('one correlated sample, cooldown, deadlines and cancellation remain bounded', async () => {
  const f = fixture(); const joining = f.open(); const ws = f.sockets[0]!;
  ws.receive(f.ack); const session = await joining;
  await expect(session.sample()).rejects.toThrow('cooldown');
  f.advance(SAMPLE_INTERVAL_MS);
  const request = session.sample(); const id = ws.sent.at(-1).requestId;
  await expect(session.sample()).rejects.toThrow('already pending');
  ws.receive({ t: 'sample', requestId: 'unrelated', members: ['bad'] });
  ws.receive({ t: 'sample', requestId: id, members: ['new'] });
  expect(await request).toEqual(['new']);
  ws.receive(f.ack); // duplicate confirmation must not start another keepalive
  expect(f.tasks.size).toBe(1);
  f.advance(SAMPLE_INTERVAL_MS);
  const ac = new AbortController(); const cancelled = session.sample({ signal: ac.signal });
  const cancelId = ws.sent.at(-1).requestId; ac.abort();
  await expect(cancelled).rejects.toThrow('cancelled');
  ws.receive({ t: 'sample', requestId: cancelId, members: ['late'] });
  f.advance(SAMPLE_INTERVAL_MS);
  const timeout = session.sample(); f.advance(20_000);
  await expect(timeout).rejects.toThrow('timed out');
  const closing = session.sample(); session.close();
  await expect(closing).rejects.toThrow('closed');
  expect(f.tasks.size).toBe(0);
});

test('malformed negotiation and matching malformed samples fail closed', async () => {
  for (const patch of [{ members: ['self'] }, { members: ['dup', 'dup'] }, { members: new Array(17).fill('p') }, { members: Array.from({ length: 1000 }, (_, i) => `p${i}`) },
    { sampleLimit: 1000 }, { sampleIntervalMs: 1 }, { profile: 'future' }, { self: '' }]) {
    const f = fixture(); const promise = f.open(); f.sockets[0]!.receive({ ...f.ack, ...patch });
    await expect(promise).rejects.toThrow('invalid room'); expect(f.tasks.size).toBe(0);
  }
  const f = fixture(); const joining = f.open(); const ws = f.sockets[0]!;
  ws.receive(f.ack); const session = await joining; f.advance(SAMPLE_INTERVAL_MS);
  const pending = session.sample(); ws.receive({ t: 'sample', requestId: ws.sent.at(-1).requestId, members: ['x', 'x'] });
  await expect(pending).rejects.toThrow('invalid sample'); expect(ws.readyState).toBe(3); expect(f.tasks.size).toBe(0);
});

test('abort before join and oversized server response release every retained timer', async () => {
  const f = fixture(); const ac = new AbortController(); const promise = f.open({ signal: ac.signal }); ac.abort();
  await expect(promise).rejects.toThrow('cancelled'); expect(f.tasks.size).toBe(0);
  f.sockets[0]!.receive(f.ack); expect(f.tasks.size).toBe(0);
  const g = fixture(); const oversized = g.open(); g.sockets[0]!.receive({ t: 'room', self: 's', members: ['😀'.repeat(20_000)] });
  await expect(oversized).rejects.toThrow('oversized'); expect(g.tasks.size).toBe(0);
});


test('binary bounds precede decoding and subscriber exceptions cannot retain shutdown callbacks', async () => {
  const original = TextDecoder.prototype.decode;
  let decoded = 0;
  TextDecoder.prototype.decode = function (...args: Parameters<typeof original>) { decoded++; return original.apply(this, args); };
  try {
    for (const data of [new ArrayBuffer(65 * 1024), new Uint8Array(65 * 1024), new Blob(['abc']), {}]) {
      const f = fixture(); const joining = f.open(); f.sockets[0]!.onmessage({ data });
      await expect(joining).rejects.toThrow('unsupported or oversized');
      expect(f.tasks.size).toBe(0);
    }
    expect(decoded).toBe(0);
  } finally { TextDecoder.prototype.decode = original; }
  const f = fixture(); const joining = f.open(); const ws = f.sockets[0]!; ws.receive(f.ack);
  const session = await joining; let calls = 0;
  session.on('closed', () => { calls++; throw new Error('subscriber'); });
  expect(() => ws.close()).toThrow('subscriber');
  expect(calls).toBe(1); expect(f.tasks.size).toBe(0);
  ws.onclose(); ws.receive(f.ack); expect(calls).toBe(1); expect(f.tasks.size).toBe(0);
});
