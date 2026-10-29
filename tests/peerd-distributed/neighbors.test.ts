import { expect, test } from 'bun:test';
import { createNeighborMaintenance, NEIGHBOR_CANDIDATES } from '../../extension/peerd-distributed/transport/neighbors.js';

const fixture = () => {
  let now = 0, next = 0; const tasks = new Map<number, () => void>();
  const timers = { setTimeout(fn: () => void) { tasks.set(++next, fn); return next; }, clearTimeout(id: number) { tasks.delete(id); } };
  return { timers, tasks, now: () => now, advance: () => { now += 20_000; for (const [id, fn] of [...tasks]) { tasks.delete(id); fn(); } } };
};

test('maintenance coalesces pressure, bounds candidates/work and cancels owned dials', async () => {
  const f = fixture(); const ac = new AbortController(); const signals: AbortSignal[] = [];
  const owner = createNeighborMaintenance({ initial: Array.from({ length: 100 }, (_, i) => `peer-${i}`),
    sample: async () => [], known: () => false, localCount: () => 0,
    connect: (_member, signal) => new Promise<void>((_resolve, reject) => { signals.push(signal); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }),
    signal: ac.signal, now: f.now, timers: f.timers, random: () => 0 });
  const started = owner.start(); for (let i = 0; i < 100; i++) owner.wake();
  expect(signals).toHaveLength(4); expect(owner.stats().candidates).toBe(NEIGHBOR_CANDIDATES); expect(f.tasks.size).toBe(0);
  owner.stop(); await started;
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(owner.stats()).toEqual({ candidates: 0, running: false, stopped: true }); expect(f.tasks.size).toBe(0);
});

test('late sample completion after retirement cannot dial, retain candidates or schedule another timer', async () => {
  const f = fixture(); const ac = new AbortController(); const reply = Promise.withResolvers<string[]>();
  let dialed = 0; let sampleSignal: AbortSignal | undefined;
  const owner = createNeighborMaintenance({ initial: [], sample: ({ signal }) => { sampleSignal = signal; return reply.promise; },
    known: () => false, localCount: () => 0, connect: async () => { dialed++; },
    signal: ac.signal, now: f.now, timers: f.timers, random: () => 0 });
  await owner.start(); f.advance();
  expect(sampleSignal).toBeDefined(); ac.abort(); reply.resolve(['late']);
  await Promise.resolve(); await Promise.resolve();
  expect(sampleSignal!.aborted).toBe(true); expect(dialed).toBe(0);
  expect(owner.stats()).toEqual({ candidates: 0, running: false, stopped: true }); expect(f.tasks.size).toBe(0);
});

test('failed early contacts do not crowd out untried sampled peers', async () => {
  const f = fixture(); const ac = new AbortController(); let clock = 0;
  const members = Array.from({ length: 12 }, (_, i) => `peer-${i}`);
  const contacted: string[] = []; const linked = new Set<string>();
  const owner = createNeighborMaintenance({ initial: members, sample: async () => members,
    known: member => linked.has(member), localCount: () => linked.size,
    connect: async member => {
      contacted.push(member);
      if (members.slice(0, 4).includes(member)) throw new Error('remote full');
      linked.add(member);
    }, signal: ac.signal, now: () => clock, timers: f.timers, random: () => 0 });
  try {
    await owner.start();
    expect(contacted).toEqual(members.slice(0, 4));
    clock = 20_000; // Early failures are eligible again; sample repeats their order.
    await owner.start();
    expect(contacted.slice(4)).toEqual(members.slice(4, 8));
    expect(linked.size).toBe(4);
  } finally { owner.stop(); }
  expect(f.tasks.size).toBe(0);
});
