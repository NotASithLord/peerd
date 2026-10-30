import { expect, test } from 'bun:test';
import { createEventLoopObservation } from '../../scripts/cdp/dweb-event-loop-evidence.mjs';

const fixture = () => {
  let time = 0, sequence = 0;
  const tasks = new Map<number, { fn: () => void; delay: number }>();
  const observation = createEventLoopObservation({ now: () => time, timers: {
    setTimeout(fn: () => void, delay: number) { tasks.set(++sequence, { fn, delay }); return sequence; },
    clearTimeout(id: number) { tasks.delete(id); },
  } });
  const fireAt = (at: number) => {
    time = at;
    const [id, task] = [...tasks][0]!;
    tasks.delete(id);
    task.fn();
  };
  return { observation, tasks, fireAt };
};

test('renderer lateness records a stall once and does not schedule a catch-up burst', () => {
  const f = fixture();
  try {
    f.fireAt(100);
    f.fireAt(550); // Expected at200: one350ms stall.
    const result = f.observation.snapshot();
    expect(result.samples).toBe(2);
    expect(result.totalDelayMs).toBe(350);
    expect(result.maxDelayMs).toBe(350);
    expect(result.buckets.reduce((a, b) => a + b, 0)).toBe(2);
    expect(f.tasks.size).toBe(1);
    expect([...f.tasks.values()][0]!.delay).toBe(100);
    f.fireAt(650);
    expect(f.observation.snapshot().totalDelayMs).toBe(350);
  } finally { f.observation.stop(); }
  expect(f.tasks.size).toBe(0);
});

test('histogram storage is fixed, includes long stalls and returns detached snapshots', () => {
  const f = fixture();
  try {
    for (let index = 1; index <= 10000; index++) f.fireAt(index * 100);
    f.fireAt(1100000);
    const result = f.observation.snapshot();
    expect(result.samples).toBe(10001);
    expect(result.buckets.length).toBe(16);
    expect(result.buckets.at(-1)).toBe(1);
    expect(result.maxDelayMs).toBe(99900);
    result.buckets.fill(0); result.upperBoundsMs.fill(0);
    expect(f.observation.snapshot().buckets.reduce((a, b) => a + b, 0)).toBe(10001);
    expect(f.observation.snapshot().upperBoundsMs[0]).toBe(1);
  } finally { f.observation.stop(); }
});

test('stop retires the timer and an already queued callback cannot restart observation', () => {
  const f = fixture();
  const queued = [...f.tasks.values()][0]!.fn;
  f.observation.stop(); queued(); f.observation.stop();
  expect(f.tasks.size).toBe(0);
  expect(f.observation.snapshot().stopped).toBe(true);
  expect(f.observation.snapshot().samples).toBe(0);
});
