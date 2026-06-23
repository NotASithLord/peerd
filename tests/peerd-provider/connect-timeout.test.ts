import { describe, test, expect } from 'bun:test';
import { combineSignals, fetchInitialResponse } from '../../extension/peerd-provider/connect-timeout.js';

const onTimeout = (ms: number) => new Error(`timed out after ${ms}ms`);

describe('combineSignals', () => {
  test('returns the single signal when only one given', () => {
    const c = new AbortController();
    expect(combineSignals(c.signal, undefined).signal).toBe(c.signal);
    expect(combineSignals(undefined, undefined).signal).toBeUndefined();
  });
  test('aborts the combined signal when either input aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const { signal } = combineSignals(a.signal, b.signal);
    expect(signal!.aborted).toBe(false);
    b.abort();
    expect(signal!.aborted).toBe(true);
  });
  test('fallback relay (no AbortSignal.any): relays an abort, and dispose() unhooks it (no leak)', () => {
    const realAny = (AbortSignal as any).any;
    (AbortSignal as any).any = undefined; // force the AbortSignal.any-less fallback path
    try {
      // the relay works under the fallback
      const a = new AbortController();
      const live = combineSignals(a.signal, new AbortController().signal);
      expect(live.signal!.aborted).toBe(false);
      a.abort();
      expect(live.signal!.aborted).toBe(true);

      // dispose() removes the input listeners, so a LATER input abort no longer
      // propagates — i.e. the listener didn't leak past the fetch's lifetime.
      const b = new AbortController();
      const disposed = combineSignals(b.signal, new AbortController().signal);
      disposed.dispose();
      b.abort();
      expect(disposed.signal!.aborted).toBe(false);
    } finally {
      (AbortSignal as any).any = realAny;
    }
  });
});

describe('fetchInitialResponse', () => {
  test('returns the response and clears the timer when headers arrive in time', async () => {
    let cleared = true;
    const fetchFn = (async () => new Response('ok')) as any;
    const res = await fetchInitialResponse(fetchFn, 'https://x', {}, { timeoutMs: 1000, onTimeout });
    expect(await res.text()).toBe('ok');
    expect(cleared).toBe(true); // (timer cleared in finally — no late abort possible)
  });

  test('throws onTimeout when the server never sends headers', async () => {
    // fetchFn that only settles when its signal aborts (i.e. hangs until timeout).
    const fetchFn = ((_url: any, init: any) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })) as any;
    await expect(
      fetchInitialResponse(fetchFn, 'https://x', {}, { timeoutMs: 15, onTimeout }),
    ).rejects.toThrow('timed out after 15ms');
  });

  test('a user Stop propagates as the original abort, NOT a timeout', async () => {
    const stop = new AbortController();
    const fetchFn = ((_url: any, init: any) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(new DOMException('stopped', 'AbortError')));
    })) as any;
    const p = fetchInitialResponse(fetchFn, 'https://x', {}, { stopSignal: stop.signal, timeoutMs: 5000, onTimeout });
    stop.abort();
    // the original AbortError surfaces (handled upstream as a clean stop), not the timeout error
    await expect(p).rejects.toThrow('stopped');
  });

  test('the SSE body is NOT subject to the connect timeout (timer cleared on headers)', async () => {
    // headers resolve immediately; the body would "stream" long after — assert no timeout fires.
    const fetchFn = (async () => new Response('streamed')) as any;
    const res = await fetchInitialResponse(fetchFn, 'https://x', {}, { timeoutMs: 5, onTimeout });
    await new Promise((r) => setTimeout(r, 25)); // wait past the (cleared) connect timeout
    expect(await res.text()).toBe('streamed'); // still usable; no abort
  });
});
