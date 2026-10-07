import { expect, test } from 'bun:test';
import { createSyncWindow, WINDOW } from '../../extension/peerd-distributed/gossip/sync-window.js';
import { createSyncWork } from '../../extension/peerd-distributed/gossip/sync-work.js';

const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const entry = (index = 0) => ({ v: 1, ch: 4, typ: 0, sig: `sig${index}`, body: { topic: 'feed', data: 'x'.repeat(80) } });
const fixture = (options: { accept?: (entries: any[], current: () => boolean) => Promise<boolean>, capable?: boolean } = {}) => {
  const work = createSyncWork();
  let channel = { maxFrameBytes: () => 400 };
  const sent: any[] = [];
  const audits: any[] = [];
  let timerId = 0;
  const timers = new Map<number, { fn: () => void, delay: number }>();
  const clock = {
    setTimeout(fn: () => void, delay: number) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const window = createSyncWindow({ work, peer: (did) => did === 'neighbor' ? { channel } : null,
    supports: () => options.capable !== false, retained: () => true, history: () => [entry(1), entry(2), entry(3)],
    validHaves: (haves) => Array.isArray(haves) && haves.length <= 512,
    validInner: (inner, topic) => inner?.ch === 4 && inner.typ === 0 && inner.body?.topic === topic,
    accept: async (entries, _topic, _via, current) => options.accept ? options.accept(entries, current) : current(),
    sign: async (typ, body) => ({ typ, body }), send: async (_did, env) => { sent.push(env); return true; },
    timers: clock, audit: (type, detail) => audits.push({ type, ...detail }),
  });
  return { window, work, sent, timers, audits, owner: () => channel,
    request: (topic = 'feed', id = crypto.randomUUID()) => {
      window.receive('neighbor', { typ: WINDOW.REQ, body: { id, topic, haves: [] } }); return id;
    },
    ack(frame: any, changes: any = {}, did = 'neighbor') {
      window.receive(did, { typ: WINDOW.ACK, body: { id: frame.body.id, topic: frame.body.topic, seq: frame.body.seq, ...changes } });
    },
    replace() { channel = { maxFrameBytes: () => 400 }; window.retire(); work.retire(); },
    expire() { [...timers.values()].sort((a, b) => a.delay - b.delay)[0]?.fn(); },
    close() { window.close(); work.close(); },
  };
};

test('only the exact issued page ACK progresses an exchange and waiting ACKs hold no work slots', async () => {
  const f = fixture();
  f.request(); f.request('second');
  await flush();
  const first = f.sent.find(frame => frame.typ === WINDOW.PAGE && frame.body.topic === 'feed');
  expect(first).toBeDefined();
  expect(f.sent.filter(frame => frame.typ === WINDOW.PAGE && frame.body.topic === 'feed')).toHaveLength(1);
  let unrelated = 0;
  await Promise.all([f.work.run(f.owner(), () => true, async () => { unrelated++; }), f.work.run(f.owner(), () => true, async () => { unrelated++; })]);
  expect(unrelated).toBe(2);
  f.ack(first, { seq: 99 }); f.ack(first, { id: crypto.randomUUID() }); f.ack(first, { topic: 'wrong' }); f.ack(first, {}, 'other');
  await flush();
  expect(f.sent.filter(frame => frame.typ === WINDOW.PAGE && frame.body.topic === 'feed')).toHaveLength(1);
  f.ack(first);
  await flush();
  const count = f.sent.filter(frame => frame.typ === WINDOW.PAGE && frame.body.topic === 'feed').length;
  expect(count).toBe(2);
  f.ack(first); // duplicate old ACK cannot release the new page.
  await flush();
  expect(f.sent.filter(frame => frame.typ === WINDOW.PAGE && frame.body.topic === 'feed')).toHaveLength(count);
  f.close(); expect(f.timers.size).toBe(0);
});

test('exchange ownership is bounded per direction and an expired or replaced carrier cannot resume', async () => {
  const f = fixture();
  f.window.request('neighbor', 'first', []); f.window.request('neighbor', 'second', []); f.window.request('neighbor', 'third', []);
  f.request('feed'); f.request('other'); f.request('third');
  await flush();
  expect(f.window.stats()).toEqual({ send: 2, receive: 2 });
  expect(f.audits.filter(row => row.type === 'sync_window_overloaded')).toHaveLength(2);
  f.expire();
  expect(f.audits.some(row => row.reason === 'progress-timeout')).toBe(true);
  const old = f.sent.find(frame => frame.typ === WINDOW.PAGE);
  f.replace(); expect(f.window.stats()).toEqual({ send: 0, receive: 0 });
  const before = f.sent.length;
  f.ack(old); await flush(); expect(f.sent).toHaveLength(before);
  expect(f.timers.size).toBe(0);
  f.close();
});

test('receiver counts entries across pages and does not ACK a page beyond the aggregate budget', async () => {
  const f = fixture();
  f.window.request('neighbor', 'feed', []); await flush();
  const request = f.sent.find(frame => frame.typ === WINDOW.REQ);
  const page = (seq: number, count: number) => ({ typ: WINDOW.PAGE,
    body: { topic: 'feed', id: request.body.id, seq, done: false, envs: Array.from({ length: count }, (_, i) => entry(i)) } });
  f.window.receive('neighbor', page(0, 128)); await flush();
  expect(f.sent.filter(frame => frame.typ === WINDOW.ACK)).toHaveLength(1);
  f.window.receive('neighbor', page(1, 129)); await flush();
  expect(f.sent.filter(frame => frame.typ === WINDOW.ACK)).toHaveLength(1);
  expect(f.window.stats().receive).toBe(0);
  expect(f.audits.some(row => row.reason === 'page-budget')).toBe(true);
  f.close();
});

test('timeout during verification prevents late retention and ACK without releasing pending crypto early', async () => {
  const blocked = gate();
  let retained = 0;
  const f = fixture({ accept: async (_entries, current) => { await blocked.promise; if (current()) retained++; return current(); } });
  f.window.request('neighbor', 'feed', []); await flush();
  const request = f.sent.find(frame => frame.typ === WINDOW.REQ);
  f.window.receive('neighbor', { typ: WINDOW.PAGE, body: { topic: 'feed', id: request.body.id, seq: 0, done: true, envs: [entry()] } });
  await flush(); f.expire(); blocked.resolve(); await flush();
  expect(retained).toBe(0);
  expect(f.sent.filter(frame => frame.typ === WINDOW.ACK)).toHaveLength(0);
  expect(f.window.stats().receive).toBe(0); expect(f.timers.size).toBe(0);
  f.close();
});

test('unnegotiated peers and unsolicited PAGE frames cannot allocate exchanges or trigger work', async () => {
  const f = fixture({ capable: false });
  f.window.request('neighbor', 'feed', []); f.request();
  f.window.receive('neighbor', { typ: WINDOW.PAGE, body: { topic: 'feed', id: crypto.randomUUID(), seq: 0, done: true, envs: [entry()] } });
  await flush(); expect(f.sent).toEqual([]); expect(f.window.stats()).toEqual({ send: 0, receive: 0 });
  expect(f.timers.size).toBe(0); f.close();
});

test('queued exchange timeout releases pending quota while unrelated crypto remains active', async () => {
  const f = fixture();
  const blocked = gate();
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < 8; i++) jobs.push(f.work.run({}, () => true, async () => blocked.promise)!);
  await flush();
  f.window.request('neighbor', 'feed', []);
  for (let i = 0; i < 55; i++) jobs.push(f.work.run({}, () => true, async () => {})!);
  expect(f.work.run({}, () => true, async () => {})).toBeNull();
  f.expire();
  const admitted = f.work.run({}, () => true, async () => {});
  expect(admitted).not.toBeNull();
  blocked.resolve();
  await Promise.all([...jobs, admitted]);
  expect(f.sent).toEqual([]);
  f.close();
});
