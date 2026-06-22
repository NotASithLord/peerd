// Connection-drop retry — decision table + retrying fetch wrapper.
//
// Owner request: "bake in model retries if a connection drops when you
// try to send a message, just 3 times max" — read conservatively as
// 3 TOTAL attempts (initial + up to 2 retries). These tests pin that
// reading, the retry-only-on-TypeError rule, and every deliberate
// non-retry case (user abort, connect timeout, HTTP responses). All
// timing goes through the injected sleepFn, so nothing waits real time.

import { describe, test, expect } from 'bun:test';
import {
  MAX_CONNECT_ATTEMPTS,
  CONNECT_RETRY_BACKOFF_MS,
  decideConnectRetry,
  fetchInitialResponseWithRetry,
  abortableSleep,
} from '../../extension/peerd-provider/connect-timeout.js';
import { callOpenRouter } from '../../extension/peerd-provider/adapters/openrouter.js';

const networkError = () => new TypeError('Failed to fetch');
const abortError = () => new DOMException('Aborted', 'AbortError');
const onTimeout = (ms: number) => new Error(`connect timeout after ${ms}ms`);

/** sleepFn that records waits and never actually sleeps. */
const recordingSleep = (waits: number[]) => async (ms: number) => { waits.push(ms); };

describe('decideConnectRetry — decision table', () => {
  test('retries a network TypeError with the 500ms → 1500ms ladder', () => {
    expect(decideConnectRetry({ error: networkError(), attempt: 1 }))
      .toEqual({ retry: true, waitMs: 500 });
    expect(decideConnectRetry({ error: networkError(), attempt: 2 }))
      .toEqual({ retry: true, waitMs: 1500 });
  });

  test('"just 3 times max" = 3 TOTAL attempts: no retry after the third try', () => {
    expect(MAX_CONNECT_ATTEMPTS).toBe(3);
    expect(decideConnectRetry({ error: networkError(), attempt: 3 }))
      .toEqual({ retry: false });
    expect(decideConnectRetry({ error: networkError(), attempt: 4 }))
      .toEqual({ retry: false });
  });

  test('never retries a user abort', () => {
    expect(decideConnectRetry({ error: abortError(), attempt: 1 }))
      .toEqual({ retry: false });
    // Paranoia path: even a TypeError is not retried once the stop
    // signal has fired — an abort surfacing in a weird shape must not
    // trigger another network call.
    expect(decideConnectRetry({ error: networkError(), attempt: 1, stopAborted: true }))
      .toEqual({ retry: false });
  });

  test('never retries non-network errors (timeouts, egress denials, provider errors)', () => {
    for (const error of [
      new Error('connect timeout after 45000ms'), // onTimeout product
      new RangeError('nope'),
      'a string, even',
      undefined,
    ]) {
      expect(decideConnectRetry({ error, attempt: 1 })).toEqual({ retry: false });
    }
  });

  test('respects a caller-supplied maxAttempts (Ollama passes 2)', () => {
    expect(decideConnectRetry({ error: networkError(), attempt: 1, maxAttempts: 2 }))
      .toEqual({ retry: true, waitMs: 500 });
    expect(decideConnectRetry({ error: networkError(), attempt: 2, maxAttempts: 2 }))
      .toEqual({ retry: false });
  });

  test('clamps the wait to the last ladder entry when maxAttempts exceeds the ladder', () => {
    const last = CONNECT_RETRY_BACKOFF_MS[CONNECT_RETRY_BACKOFF_MS.length - 1];
    expect(decideConnectRetry({ error: networkError(), attempt: 3, maxAttempts: 5 }))
      .toEqual({ retry: true, waitMs: last });
    expect(decideConnectRetry({ error: networkError(), attempt: 4, maxAttempts: 5 }))
      .toEqual({ retry: true, waitMs: last });
  });
});

describe('fetchInitialResponseWithRetry', () => {
  test('recovers when the connection drop heals: 2 failures → success on attempt 3', async () => {
    const waits: number[] = [];
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (calls < 3) throw networkError();
      return new Response('ok');
    }) as any;
    const res = await fetchInitialResponseWithRetry(fetchFn, 'https://x', {}, {
      timeoutMs: 1000, onTimeout, sleepFn: recordingSleep(waits),
    });
    expect(await res.text()).toBe('ok');
    expect(calls).toBe(3);
    expect(waits).toEqual([500, 1500]);
  });

  test('a dead connection surfaces the original TypeError after exactly 3 attempts', async () => {
    const waits: number[] = [];
    let calls = 0;
    const fetchFn = (async () => { calls++; throw networkError(); }) as any;
    let thrown: any;
    try {
      await fetchInitialResponseWithRetry(fetchFn, 'https://x', {}, {
        timeoutMs: 1000, onTimeout, sleepFn: recordingSleep(waits),
      });
    } catch (e) { thrown = e; }
    expect(calls).toBe(3);
    expect(waits).toEqual([500, 1500]);
    expect(thrown).toBeInstanceOf(TypeError);
  });

  test('a user abort is NOT retried — rethrown after a single attempt', async () => {
    const waits: number[] = [];
    let calls = 0;
    const fetchFn = (async () => { calls++; throw abortError(); }) as any;
    let thrown: any;
    try {
      await fetchInitialResponseWithRetry(fetchFn, 'https://x', {}, {
        timeoutMs: 1000, onTimeout, sleepFn: recordingSleep(waits),
      });
    } catch (e) { thrown = e; }
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
    expect(thrown?.name).toBe('AbortError');
  });

  test('an already-aborted stop signal short-circuits without any network call', async () => {
    const stop = new AbortController();
    stop.abort();
    let calls = 0;
    const fetchFn = (async () => { calls++; return new Response('ok'); }) as any;
    let thrown: any;
    try {
      await fetchInitialResponseWithRetry(fetchFn, 'https://x', {}, {
        stopSignal: stop.signal, timeoutMs: 1000, onTimeout, sleepFn: recordingSleep([]),
      });
    } catch (e) { thrown = e; }
    expect(calls).toBe(0);
    expect(thrown?.name).toBe('AbortError');
  });

  test('a Stop during the backoff sleep unwinds immediately — no further attempt', async () => {
    const stop = new AbortController();
    let calls = 0;
    const fetchFn = (async () => { calls++; throw networkError(); }) as any;
    // Real abortableSleep + a Stop fired while the 500ms backoff is pending.
    // why a macrotask (not queueMicrotask): the abort must land DURING the
    // sleep — a microtask would fire while the fetch rejection is still
    // propagating, exercising the stop-aborted guard instead (which rethrows
    // the original error rather than retrying; also correct, but not this
    // test's subject).
    const p = fetchInitialResponseWithRetry(fetchFn, 'https://x', {}, {
      stopSignal: stop.signal, timeoutMs: 1000, onTimeout,
    });
    setTimeout(() => stop.abort(), 5);
    let thrown: any;
    try { await p; } catch (e) { thrown = e; }
    expect(calls).toBe(1);
    expect(thrown?.name).toBe('AbortError');
  });

  test('HTTP error responses are returned, not retried (status logic lives in the adapters)', async () => {
    let calls = 0;
    const fetchFn = (async () => { calls++; return new Response('overloaded', { status: 529 }); }) as any;
    const res = await fetchInitialResponseWithRetry(fetchFn, 'https://x', {}, {
      timeoutMs: 1000, onTimeout, sleepFn: recordingSleep([]),
    });
    expect(calls).toBe(1);
    expect(res.status).toBe(529);
  });

  test('a connect TIMEOUT is not retried — it already burned its full waiting budget', async () => {
    let calls = 0;
    // Hangs until the connect timer aborts it.
    const fetchFn = ((_url: any, init: any) => new Promise((_res, rej) => {
      calls++;
      init.signal.addEventListener('abort', () => rej(abortError()));
    })) as any;
    let thrown: any;
    try {
      await fetchInitialResponseWithRetry(fetchFn, 'https://x', {}, {
        timeoutMs: 10, onTimeout, sleepFn: recordingSleep([]),
      });
    } catch (e) { thrown = e; }
    expect(calls).toBe(1);
    expect(thrown?.message).toBe('connect timeout after 10ms');
  });
});

describe('abortableSleep', () => {
  test('resolves after the wait', async () => {
    await abortableSleep(1); // just: does not hang or throw
  });

  test('rejects with AbortError when the signal fires mid-sleep', async () => {
    const ctl = new AbortController();
    const p = abortableSleep(10_000, ctl.signal);
    ctl.abort();
    let thrown: any;
    try { await p; } catch (e) { thrown = e; }
    expect(thrown?.name).toBe('AbortError');
  });

  test('rejects immediately when the signal is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    let thrown: any;
    try { await abortableSleep(10_000, ctl.signal); } catch (e) { thrown = e; }
    expect(thrown?.name).toBe('AbortError');
  });
});

describe('callOpenRouter — connection-drop wiring', () => {
  const okStreamingResponse = () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    return { ok: true, status: 200, headers: new Headers(), body, text: async () => '' };
  };

  test('recovers from a single dropped connection', async () => {
    let calls = 0;
    const safeFetch = async () => {
      calls++;
      if (calls === 1) throw networkError();
      return okStreamingResponse();
    };
    const events: any[] = [];
    for await (const ev of callOpenRouter({
      messages: [{ role: 'user', content: 'hi', id: 'u', when: 0 }],
      system: 'sys',
      getSecret: async () => 'sk-or',
      safeFetch,
      _sleep: async () => {},
    } as any)) events.push(ev);
    expect(calls).toBe(2);
    expect(events.at(-1).type).toBe('message-stop');
  });

  test('persistent drop surfaces the TypeError after 3 total attempts', async () => {
    let calls = 0;
    const safeFetch = async () => { calls++; throw networkError(); };
    let thrown: any;
    try {
      for await (const _ of callOpenRouter({
        messages: [{ role: 'user', content: 'hi', id: 'u', when: 0 }],
        system: 'sys',
        getSecret: async () => 'sk-or',
        safeFetch,
        _sleep: async () => {},
      } as any)) { /* drain */ }
    } catch (e) { thrown = e; }
    expect(calls).toBe(3);
    expect(thrown).toBeInstanceOf(TypeError);
  });
});
