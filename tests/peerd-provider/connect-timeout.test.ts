import { describe, test, expect } from 'bun:test';
import { combineSignals, fetchInitialResponse } from '../../extension/peerd-provider/connect-timeout.js';

const onTimeout = (ms: number) => new Error(`timed out after ${ms}ms`);

describe('combineSignals', () => {
  test('returns the single signal when only one given', () => {
    const c = new AbortController();
    expect(combineSignals(c.signal, undefined)).toBe(c.signal);
    expect(combineSignals(undefined, undefined)).toBeUndefined();
  });
  test('aborts the combined signal when either input aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineSignals(a.signal, b.signal)!;
    expect(combined.aborted).toBe(false);
    b.abort();
    expect(combined.aborted).toBe(true);
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
