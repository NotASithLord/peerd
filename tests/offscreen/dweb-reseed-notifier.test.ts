import { describe, expect, test } from 'bun:test';
import { createDwebReseedNotifier } from '../../extension/offscreen/dweb-reseed-notifier.js';

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('dweb reseed generation notification', () => {
  test('keeps retrying the live generation beyond the former finite ceiling', async () => {
    let calls = 0;
    const notice = { hostEpoch: 'host-epoch-0001', meshGeneration: 1 };
    const notifier = createDwebReseedNotifier({
      current: (candidate) => candidate === notice,
      send: async () => ({ ok: ++calls >= 7 }),
      retryDelaysMs: [0],
      attemptTimeoutMs: 100,
    });
    await expect(notifier.notify(notice)).resolves.toEqual({ ok: true });
    expect(calls).toBe(7);
  });

  test('retries a transient SW retirement refusal while the local host is still current', async () => {
    let calls = 0;
    const notice = { hostEpoch: 'host-epoch-starting', meshGeneration: 1 };
    const notifier = createDwebReseedNotifier({
      current: () => true,
      send: async () => (++calls === 1
        ? { ok: false, cancelled: true, error: 'dweb-generation-retired' }
        : { ok: true, seeded: 1 }),
      retryDelaysMs: [0],
      attemptTimeoutMs: 100,
    });

    await expect(notifier.notify(notice)).resolves.toEqual({ ok: true, seeded: 1 });
    expect(calls).toBe(2);
  });

  test('a transient generation notice cannot make install or status block its publication retry', async () => {
    let tail = Promise.resolve<unknown>(undefined);
    const publication = <T>(operation: () => Promise<T> | T) => {
      const result = tail.then(operation, operation);
      tail = result.then(() => undefined, () => undefined);
      return result;
    };
    let calls = 0;
    const notice = { hostEpoch: 'host-epoch-nonblocking', meshGeneration: 1 };
    const notifier = createDwebReseedNotifier({
      current: () => true,
      send: async () => publication(() => (++calls === 1
        ? { ok: false, cancelled: true, error: 'dweb-generation-retired' }
        : { ok: true, seeded: 1 })),
      retryDelaysMs: [20],
      attemptTimeoutMs: 100,
    });
    const recovery = notifier.notify(notice);
    while (calls === 0) await turn();

    await expect(Promise.all([
      publication(() => ({ ok: false, code: 'dweb-local-content-unavailable' })),
      publication(() => ({ ok: true, running: true })),
    ])).resolves.toEqual([
      { ok: false, code: 'dweb-local-content-unavailable' },
      { ok: true, running: true },
    ]);
    await expect(recovery).resolves.toEqual({ ok: true, seeded: 1 });
    expect(calls).toBe(2);
  });

  test('a completed partial pass does not retry forever or block unrelated work', async () => {
    let calls = 0;
    const notifier = createDwebReseedNotifier({
      current: () => true,
      send: async () => {
        calls += 1;
        return { ok: false, seeded: 2, failed: 1, error: 'dweb-reseed-partial' };
      },
      retryDelaysMs: [0],
      attemptTimeoutMs: 100,
    });
    await expect(notifier.notify({
      hostEpoch: 'host-epoch-partial', meshGeneration: 1,
    })).resolves.toEqual({
      ok: false, seeded: 2, failed: 1, error: 'dweb-reseed-partial',
    });
    expect(calls).toBe(1);
  });

  test('times out a hung attempt, aborts its signal, and recovers on retry', async () => {
    let calls = 0;
    let firstSignal: AbortSignal | null = null;
    const notice = { hostEpoch: 'host-epoch-0002', meshGeneration: 2 };
    const notifier = createDwebReseedNotifier({
      current: () => true,
      send: async (_candidate, { signal }) => {
        calls += 1;
        if (calls === 1) {
          firstSignal = signal;
          return new Promise(() => {});
        }
        return { ok: true };
      },
      retryDelaysMs: [0],
      attemptTimeoutMs: 2,
    });
    await expect(notifier.notify(notice)).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
    expect((firstSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  test('cancellation aborts a hung in-flight send and settles the retired loop', async () => {
    let signal: AbortSignal | null = null;
    const notice = { hostEpoch: 'host-epoch-0003', meshGeneration: 3 };
    const notifier = createDwebReseedNotifier({
      current: () => true,
      send: async (_candidate, options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
      retryDelaysMs: [1],
      attemptTimeoutMs: 1_000,
    });
    const result = notifier.notify(notice);
    for (let attempt = 0; attempt < 5 && !signal; attempt += 1) await Promise.resolve();
    notifier.cancel();
    await expect(result).resolves.toMatchObject({ ok: false, cancelled: true });
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
  });

  test('generation replacement aborts the predecessor and acknowledges only the successor', async () => {
    const oldNotice = { hostEpoch: 'host-epoch-0004', meshGeneration: 1 };
    const nextNotice = { hostEpoch: 'host-epoch-0004', meshGeneration: 2 };
    let current = oldNotice;
    let oldSignal: AbortSignal | null = null;
    const notifier = createDwebReseedNotifier({
      current: (notice) => notice === current,
      send: async (notice, { signal }) => {
        if (notice === oldNotice) {
          oldSignal = signal;
          return new Promise(() => {});
        }
        return { ok: true, generation: notice.meshGeneration };
      },
      retryDelaysMs: [0],
      attemptTimeoutMs: 1_000,
    });
    const oldResult = notifier.notify(oldNotice);
    for (let attempt = 0; attempt < 5 && !oldSignal; attempt += 1) await Promise.resolve();
    current = nextNotice;
    const nextResult = notifier.notify(nextNotice);
    await expect(oldResult).resolves.toMatchObject({ ok: false, cancelled: true });
    await expect(nextResult).resolves.toEqual({ ok: true, generation: 2 });
    expect((oldSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  test('cancellation during backoff prevents another attempt', async () => {
    let calls = 0;
    const notice = { hostEpoch: 'host-epoch-0005', meshGeneration: 1 };
    const notifier = createDwebReseedNotifier({
      current: () => true,
      send: async () => { calls += 1; return { ok: false }; },
      retryDelaysMs: [1_000],
      attemptTimeoutMs: 100,
    });
    const result = notifier.notify(notice);
    while (calls === 0) await turn();
    notifier.cancel();
    await expect(result).resolves.toMatchObject({ ok: false, cancelled: true });
    expect(calls).toBe(1);
  });
});
