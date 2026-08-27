import { describe, expect, test } from 'bun:test';
import { createDwebReseedNotifier } from '../../extension/offscreen/dweb-reseed-notifier.js';

describe('dweb reseed generation notification', () => {
  test('retries a current generation only after failed acknowledgements', async () => {
    const waits: Array<() => void> = [];
    let calls = 0;
    const notice = { hostEpoch: 'host-epoch-0001', meshGeneration: 1 };
    const notifier = createDwebReseedNotifier({
      current: (candidate) => candidate === notice,
      send: async () => ({ ok: ++calls >= 3 }),
      retryDelaysMs: [1, 2],
      setTimeoutFn: ((callback: () => void) => {
        waits.push(callback);
        return waits.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
    });
    const result = notifier.notify(notice);
    const releaseNextWait = async () => {
      for (let turn = 0; turn < 5 && waits.length === 0; turn += 1) await Promise.resolve();
      const release = waits.shift();
      expect(release).toBeFunction();
      release?.();
    };
    await Promise.resolve();
    expect(calls).toBe(1);
    await releaseNextWait();
    for (let turn = 0; turn < 5 && calls < 2; turn += 1) await Promise.resolve();
    expect(calls).toBe(2);
    await releaseNextWait();
    expect(await result).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  test('cancellation retires the generation before another publication attempt', async () => {
    const waits: Array<() => void> = [];
    let calls = 0;
    const notice = { hostEpoch: 'host-epoch-0002', meshGeneration: 2 };
    const notifier = createDwebReseedNotifier({
      current: () => true,
      send: async () => { calls += 1; return { ok: false }; },
      retryDelaysMs: [1],
      setTimeoutFn: ((callback: () => void) => {
        waits.push(callback);
        return waits.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutFn: (() => {}) as typeof clearTimeout,
    });
    const result = notifier.notify(notice);
    await Promise.resolve();
    notifier.cancel();
    expect(await result).toMatchObject({ ok: false, cancelled: true });
    expect(calls).toBe(1);
  });

  test('a permanently failed generation stops at the finite attempt ceiling', async () => {
    let calls = 0;
    const notifier = createDwebReseedNotifier({
      current: () => true,
      send: async () => { calls += 1; return { ok: false, error: 'still-unavailable' }; },
      retryDelaysMs: [0, 0],
    });
    await expect(notifier.notify({
      hostEpoch: 'host-epoch-0003', meshGeneration: 3,
    })).resolves.toEqual({ ok: false, error: 'still-unavailable' });
    expect(calls).toBe(3);
  });
});
