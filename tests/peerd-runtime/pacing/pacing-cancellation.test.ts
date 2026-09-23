import { describe, expect, test } from 'bun:test';
import { createOriginPacingStore } from '../../../extension/peerd-runtime/pacing/origin-pacing-store.js';
import { makeWebFetch } from '../../../extension/peerd-egress/fetch/web-fetch.js';

const ORIGIN = 'https://paced.example';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('pacing cancellation at asynchronous boundaries', () => {
  test('a Request owns the signal used for its paced wait', async () => {
    const controller = new AbortController();
    const request = new Request(ORIGIN, { signal: controller.signal });
    const entered = deferred<void>();
    const release = deferred<void>();
    let received: AbortSignal | undefined;
    let fetched = false;
    const fetch = makeWebFetch({
      getDenylist: () => [], matchDenylist: () => false,
      fetchFn: (async () => { fetched = true; return new Response('unexpected'); }) as unknown as typeof globalThis.fetch,
      pace: {
        reserve: async (_origin, opts) => {
          received = opts.signal;
          entered.resolve();
          await release.promise;
          opts.signal?.throwIfAborted();
          return { outcome: 'go', waitedMs: 0 };
        },
        observe: async () => {}, isWriteMethod: () => false, canonicalOrigin: (origin) => origin,
      },
    });
    const result = fetch(request).catch((error) => error);
    await entered.promise;
    controller.abort();
    release.resolve();
    expect((await result).name).toBe('AbortError');
    expect(received).toBe(request.signal);
    expect(fetched).toBe(false);
  });

  test('a grant cannot send a request canceled while the grant settled', async () => {
    const controller = new AbortController();
    let fetched = false;
    const fetch = makeWebFetch({
      getDenylist: () => [], matchDenylist: () => false,
      fetchFn: (async () => { fetched = true; return new Response('unexpected'); }) as unknown as typeof globalThis.fetch,
      pace: {
        reserve: async () => { controller.abort(); return { outcome: 'go', waitedMs: 0 }; },
        observe: async () => {}, isWriteMethod: () => false, canonicalOrigin: (origin) => origin,
      },
    });
    await expect(fetch(ORIGIN, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetched).toBe(false);
  });

  test('Stop during cold hydration refuses even an origin without a saved rule', async () => {
    const loaded = deferred<undefined>();
    const s = createOriginPacingStore({ kv: { get: () => loaded.promise, set: async () => {} } });
    const controller = new AbortController();
    const result = s.reserve(ORIGIN, { isWrite: true, signal: controller.signal }).catch((error) => error);
    controller.abort();
    loaded.resolve(undefined);
    expect((await result).name).toBe('AbortError');
  });

  test('a queued caller rechecks Stop when it acquires an origin lane', async () => {
    let now = 1_700_000_000_000;
    const entered = deferred<void>();
    const release = deferred<void>();
    const s = createOriginPacingStore({
      kv: { get: async () => undefined, set: async () => {} }, now: () => now,
      sleep: async (ms) => { entered.resolve(); await release.promise; now += ms; },
    });
    await s.observe({ origin: ORIGIN, responseAtMs: now, status: 429, retryAfter: '1' });
    const first = s.reserve(ORIGIN, { isWrite: false });
    await entered.promise;
    const controller = new AbortController();
    const queued = s.reserve(ORIGIN, { isWrite: false, signal: controller.signal }).catch((error) => error);
    // Let the second caller pass hydration and park behind the occupied lane.
    await Promise.resolve();
    controller.abort();
    release.resolve();
    await first;
    expect((await queued).name).toBe('AbortError');
  });

  test('a queued write fails closed if persistence becomes unreadable while it waits', async () => {
    let now = 1_700_000_000_000;
    let failSave = false;
    const entered = deferred<void>();
    const release = deferred<void>();
    const s = createOriginPacingStore({
      kv: { get: async () => undefined, set: async () => { if (failSave) throw new Error('disk unavailable'); } },
      now: () => now,
      sleep: async (ms) => { entered.resolve(); await release.promise; now += ms; },
    });
    await s.observe({ origin: ORIGIN, responseAtMs: now, status: 429, retryAfter: '1' });
    const first = s.reserve(ORIGIN, { isWrite: false });
    await entered.promise;
    const queued = s.reserve(ORIGIN, { isWrite: true }).catch((error) => error);
    await Promise.resolve();
    failSave = true;
    await expect(s.observe({ origin: ORIGIN, responseAtMs: now, status: 429, retryAfter: '1' })).rejects.toThrow('disk unavailable');
    release.resolve();
    await first;
    expect(await queued).toMatchObject({ outcome: 'unavailable', origin: ORIGIN });
  });
});
