import { describe, expect, test } from 'bun:test';
import { makeCoalescedStatePush } from '../../extension/background/state-push.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('coalesced state push', () => {
  test('collapses a synchronous burst into one snapshot build and delivery', async () => {
    let builds = 0;
    const delivered: number[] = [];
    const push = makeCoalescedStatePush({
      isConnected: () => true,
      build: () => ++builds,
      deliver: (state) => { delivered.push(state); },
    });

    await Promise.all([push(), push(), push()]);

    expect(builds).toBe(1);
    expect(delivered).toEqual([1]);
  });

  test('invalidates an in-flight snapshot and builds the newest projection once', async () => {
    const firstBuild = deferred();
    let builds = 0;
    const delivered: number[] = [];
    const push = makeCoalescedStatePush({
      isConnected: () => true,
      build: async () => {
        builds += 1;
        if (builds === 1) await firstBuild.promise;
        return builds;
      },
      deliver: (state) => { delivered.push(state); },
    });

    const first = push();
    await Promise.resolve();
    const second = push();
    firstBuild.resolve();
    await Promise.all([first, second]);

    expect(builds).toBe(2);
    expect(delivered).toEqual([2]);
  });

  test('does not strand a request queued while the prior drain settles', async () => {
    const delivery = deferred();
    const deliveryStarted = deferred();
    let builds = 0;
    const delivered: number[] = [];
    const push = makeCoalescedStatePush({
      isConnected: () => true,
      build: () => ++builds,
      deliver: async (state) => {
        delivered.push(state);
        deliveryStarted.resolve();
        await delivery.promise;
      },
    });

    const first = push();
    await deliveryStarted.promise;
    let late: Promise<void> | undefined;
    // Register after drain() is already awaiting this promise. Its continuation
    // runs first; this callback then requests a push in the old finalization gap.
    delivery.promise.then(() => { late = push(); });
    delivery.resolve();

    await first;
    await late;
    expect(builds).toBe(2);
    expect(delivered).toEqual([1, 2]);
  });

  test('does no storage work without a UI connection', async () => {
    let builds = 0;
    const push = makeCoalescedStatePush({
      isConnected: () => false,
      build: () => ++builds,
      deliver: () => { throw new Error('must not deliver'); },
    });

    await push();
    expect(builds).toBe(0);
  });

  test('contains delivery failures and recovers on the next request', async () => {
    const errors: string[] = [];
    let deliveries = 0;
    const push = makeCoalescedStatePush({
      isConnected: () => true,
      build: () => ({ ready: true }),
      deliver: () => {
        deliveries += 1;
        if (deliveries === 1) throw new Error('port closed');
      },
      onError: (error) => errors.push((error as Error).message),
    });

    await expect(push()).resolves.toBeUndefined();
    await expect(push()).resolves.toBeUndefined();
    expect(deliveries).toBe(2);
    expect(errors).toEqual(['port closed']);
  });
});
