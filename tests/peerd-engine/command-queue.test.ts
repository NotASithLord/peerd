// createKeyedQueue — the pure core of per-VM command serialization.
//
// Pure values-in/values-out (tasks are injected thunks), so this is a
// Bun surface per CLAUDE.md. The browser-integration side (vm-client +
// tracker against the polyfill) lives in the in-browser suite.

import { describe, test, expect } from 'bun:test';
import { createKeyedQueue } from '../../extension/peerd-engine/command-queue.js';

type Deferred<T> = { promise: Promise<T>, resolve: (v: T) => void, reject: (e: unknown) => void };
const deferred = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createKeyedQueue', () => {
  test('runs tasks on one key strictly FIFO, one at a time', async () => {
    const q = createKeyedQueue();
    const started: string[] = [];
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const promises = gates.map((g, i) => q.enqueue('vm-a', () => {
      started.push(`t${i}`);
      return g.promise;
    }));

    await tick();
    expect(started).toEqual(['t0']);         // t1/t2 wait for t0 to settle
    expect(q.pendingCount('vm-a')).toBe(2);

    gates[0].resolve('r0');
    await tick();
    expect(started).toEqual(['t0', 't1']);

    gates[1].resolve('r1');
    await tick();
    expect(started).toEqual(['t0', 't1', 't2']);

    gates[2].resolve('r2');
    expect(await Promise.all(promises)).toEqual(['r0', 'r1', 'r2']);
    expect(q.pendingCount('vm-a')).toBe(0);
  });

  test('a rejected task settles its caller and still advances the lane', async () => {
    const q = createKeyedQueue();
    const first = q.enqueue('vm-a', () => Promise.reject(new Error('boom')));
    const second = q.enqueue('vm-a', () => Promise.resolve('fine'));
    await expect(first).rejects.toThrow('boom');
    expect(await second).toBe('fine');
  });

  test('different keys run concurrently', async () => {
    const q = createKeyedQueue();
    const started: string[] = [];
    const gateA = deferred<string>();
    const a = q.enqueue('vm-a', () => { started.push('a'); return gateA.promise; });
    const b = q.enqueue('vm-b', () => { started.push('b'); return Promise.resolve('b-done'); });

    await tick();
    // vm-b did not wait for vm-a's still-running task
    expect(started.sort()).toEqual(['a', 'b']);
    expect(await b).toBe('b-done');

    gateA.resolve('a-done');
    expect(await a).toBe('a-done');
  });

  test('interrupt rejects the in-flight task AND drains the queued ones', async () => {
    const q = createKeyedQueue();
    const gate = deferred<string>();
    const inflight = q.enqueue('vm-a', () => gate.promise);
    const queued1 = q.enqueue('vm-a', () => Promise.resolve('never-starts'));
    const queued2 = q.enqueue('vm-a', () => Promise.resolve('never-starts'));
    await tick();

    const n = q.interrupt('vm-a', new Error('tab closed'));
    expect(n).toBe(3);
    await expect(inflight).rejects.toThrow('tab closed');
    await expect(queued1).rejects.toThrow('tab closed');
    await expect(queued2).rejects.toThrow('tab closed');
    expect(q.pendingCount('vm-a')).toBe(0);

    // the orphaned underlying task settling later is dropped silently
    gate.resolve('too-late');
    await tick();
  });

  test('interrupt detaches the lane: new work starts without waiting for the orphan', async () => {
    const q = createKeyedQueue();
    const orphanGate = deferred<string>();
    const orphan = q.enqueue('vm-a', () => orphanGate.promise);
    await tick();
    q.interrupt('vm-a', new Error('tab closed'));
    await orphan.catch(() => {});

    let started = false;
    const fresh = q.enqueue('vm-a', () => { started = true; return Promise.resolve('fresh'); });
    await tick();
    expect(started).toBe(true);              // did NOT wait for orphanGate
    expect(await fresh).toBe('fresh');

    // the orphan settling afterwards must not disturb the live lane
    orphanGate.resolve('zombie');
    await tick();
    const after = await q.enqueue('vm-a', () => Promise.resolve('still-works'));
    expect(after).toBe('still-works');
  });

  test('interrupt on an idle/unknown key is a no-op returning 0', () => {
    const q = createKeyedQueue();
    expect(q.interrupt('vm-never-seen', new Error('x'))).toBe(0);
  });

  test('interrupt only touches its own key', async () => {
    const q = createKeyedQueue();
    const gateB = deferred<string>();
    const b = q.enqueue('vm-b', () => gateB.promise);
    await tick();
    q.interrupt('vm-a', new Error('tab closed'));
    gateB.resolve('b-untouched');
    expect(await b).toBe('b-untouched');
  });

  test('synchronous task throw is delivered as a rejection', async () => {
    const q = createKeyedQueue();
    const p = q.enqueue('vm-a', () => { throw new Error('sync-boom'); });
    await expect(p).rejects.toThrow('sync-boom');
    // lane still usable
    expect(await q.enqueue('vm-a', () => 'ok')).toBe('ok');
  });
});
