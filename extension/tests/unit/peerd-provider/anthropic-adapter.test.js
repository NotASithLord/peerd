// @ts-check
// Anthropic adapter — 429/529/500/503 retry-after backoff path.
//
// Production-path streaming (success → SSE events) is already covered
// indirectly through from-anthropic.test.js + the agent-loop tests.
// What's NOT covered without these: the retry loop, header parsing,
// non-retryable error pass-through.

import { describe, it, expect } from '../../framework.js';
import {
  callAnthropic,
  _computeBackoffMsForTests,
} from '/peerd-provider/adapters/anthropic.js';
import { ProviderHttpError } from '/peerd-provider/errors.js';

/** @typedef {import('/peerd-provider/types.js').InternalMessage} InternalMessage */
/** @typedef {import('/peerd-provider/format/from-anthropic.js').ProviderEvent} ProviderEvent */
/** @typedef {Extract<ProviderEvent, { type: 'rate-limit-pause' }>} RateLimitPause */
/** @typedef {Parameters<typeof callAnthropic>[0]} CallAnthropicArgs */

// The retry path only reads .ok/.status/.headers/.body/.text off the
// response, so these minimal mocks stand in for the full Response the
// safeFetch contract returns — cast to Response so TS treats them so.
/**
 * @param {number} status
 * @param {Record<string, string>} [headers]
 * @param {string} [bodyText]
 * @returns {Response}
 */
const stubResponse = (status, headers = {}, bodyText = '') => /** @type {Response} */ (/** @type {unknown} */ ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  body: undefined,
  text: async () => bodyText,
}));

/**
 * @param {ReadonlyArray<{ event: string, data: unknown }>} [events]
 * @returns {Response}
 */
const okStreamingResponse = (events = []) => {
  // Minimal SSE body that ends cleanly with message_stop. The retry
  // tests only need to confirm we *exit* the retry loop on 200; the
  // stream content itself is the from-anthropic test's concern.
  const lines = events.map(e =>
    `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines));
      controller.close();
    },
  });
  return /** @type {Response} */ (/** @type {unknown} */ ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body,
    text: async () => '',
  }));
};

/**
 * @param {Partial<CallAnthropicArgs>} [overrides]
 * @returns {CallAnthropicArgs}
 */
const baseArgs = (overrides = {}) => ({
  /** @type {InternalMessage[]} */
  messages: [{ role: 'user', content: 'hi', id: 'u', when: 0 }],
  system: 'sys',
  getSecret: async () => 'sk-test',
  // Tests pass their own safeFetch via overrides.
  safeFetch: async () => { throw new Error('safeFetch not set'); },
  _sleep: async () => {},  // no-op so tests run instantly
  ...overrides,
});

/** @param {AsyncGenerator<ProviderEvent>} gen */
const drain = async (gen) => {
  /** @type {ProviderEvent[]} */
  const events = [];
  for await (const ev of gen) events.push(ev);
  return events;
};

describe('callAnthropic — transient-status retry path', () => {
  it('retries on 429 and emits a rate-limit-pause event before each retry', async () => {
    let calls = 0;
    const safeFetch = async () => {
      calls++;
      if (calls === 1) {
        return stubResponse(429, { 'retry-after': '0' }, '{"error":"rate_limit"}');
      }
      return okStreamingResponse([
        { event: 'message_stop', data: { type: 'message_stop' } },
      ]);
    };
    const events = await drain(callAnthropic(baseArgs({ safeFetch })));
    expect(calls).toBe(2);
    expect(events[0].type).toBe('rate-limit-pause');
    const pause = /** @type {RateLimitPause} */ (events[0]);
    expect(pause.attempt).toBe(1);
    expect(pause.retryAfterMs).toBe(250);  // 0s + 250ms jitter
  });

  it('retries on 529 (overloaded) just like 429', async () => {
    let calls = 0;
    const safeFetch = async () => {
      calls++;
      if (calls === 1) return stubResponse(529, { 'retry-after': '0' });
      return okStreamingResponse();
    };
    const events = await drain(callAnthropic(baseArgs({ safeFetch })));
    expect(calls).toBe(2);
    expect(events[0].type).toBe('rate-limit-pause');
  });

  it('retries on transient 500 (api_error) and 503 instead of killing the turn', async () => {
    for (const status of [500, 503]) {
      let calls = 0;
      const safeFetch = async () => {
        calls++;
        if (calls === 1) return stubResponse(status, {}, '{"error":{"type":"api_error"}}');
        return okStreamingResponse();
      };
      const events = await drain(callAnthropic(baseArgs({ safeFetch })));
      expect(calls).toBe(2);
      // No rate-limit headers on a 500 — falls through to the
      // exponential default (2s on attempt 1).
      expect(events[0].type).toBe('rate-limit-pause');
      expect(/** @type {RateLimitPause} */ (events[0]).retryAfterMs).toBe(2000);
    }
  });

  it('does NOT retry on a non-retryable status (400, 401, 403)', async () => {
    for (const status of [400, 401, 403]) {
      let calls = 0;
      const safeFetch = async () => {
        calls++;
        return stubResponse(status, {}, 'bad');
      };
      /** @type {unknown} */
      let thrown;
      try { await drain(callAnthropic(baseArgs({ safeFetch }))); }
      catch (e) { thrown = e; }
      expect(calls).toBe(1);
      expect(thrown instanceof ProviderHttpError).toBe(true);
      expect(/** @type {ProviderHttpError} */ (thrown).status).toBe(status);
    }
  });

  it('throws ProviderHttpError after exhausting retries', async () => {
    let calls = 0;
    const safeFetch = async () => {
      calls++;
      return stubResponse(429, { 'retry-after': '0' }, '{"err":"persistent"}');
    };
    /** @type {ProviderEvent[]} */
    const events = [];
    /** @type {unknown} */
    let thrown;
    try {
      for await (const ev of callAnthropic(baseArgs({ safeFetch }))) {
        events.push(ev);
      }
    } catch (e) { thrown = e; }
    // 1 initial attempt + 3 retries = 4 total calls, 3 pause events.
    expect(calls).toBe(4);
    expect(events.filter(e => e.type === 'rate-limit-pause').length).toBe(3);
    expect(thrown instanceof ProviderHttpError).toBe(true);
    expect(/** @type {ProviderHttpError} */ (thrown).status).toBe(429);
  });

  it('attempt counter increments across retries', async () => {
    let calls = 0;
    const safeFetch = async () => {
      calls++;
      if (calls <= 2) return stubResponse(429, { 'retry-after': '0' });
      return okStreamingResponse();
    };
    const events = await drain(callAnthropic(baseArgs({ safeFetch })));
    const pauses = /** @type {RateLimitPause[]} */ (
      events.filter(e => e.type === 'rate-limit-pause'));
    expect(pauses.length).toBe(2);
    expect(pauses[0].attempt).toBe(1);
    expect(pauses[1].attempt).toBe(2);
  });

  it('aborts cleanly when the signal fires during the sleep', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const safeFetch = async () => {
      calls++;
      return stubResponse(429, { 'retry-after': '60' });
    };
    // _sleep that observes the abort — same shape as the real one.
    /**
     * @param {number} ms
     * @param {AbortSignal} [signal]
     * @returns {Promise<void>}
     */
    const _sleep = (ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      // Schedule the abort to fire on the same microtask cycle.
      queueMicrotask(() => {
        ctrl.abort();
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
    /** @type {{ name?: string } | undefined} */
    let thrown;
    try {
      await drain(callAnthropic(baseArgs({
        safeFetch, _sleep, signal: ctrl.signal,
      })));
    } catch (e) { thrown = /** @type {{ name?: string }} */ (e); }
    expect(calls).toBe(1);
    expect(thrown?.name).toBe('AbortError');
  });
});

describe('computeBackoffMs — header parsing', () => {
  /** @param {Record<string, string>} headers */
  const make = (headers) => new Headers(headers);

  it('prefers retry-after (in seconds) with a small jitter', () => {
    const ms = _computeBackoffMsForTests(make({ 'retry-after': '5' }), 1);
    expect(ms).toBe(5250);
  });

  it('falls back to anthropic-ratelimit-input-tokens-reset when retry-after is absent', () => {
    const future = new Date(Date.now() + 3000).toISOString();
    const ms = _computeBackoffMsForTests(
      make({ 'anthropic-ratelimit-input-tokens-reset': future }), 1,
    );
    // Should be roughly 3000ms + 250 jitter, allowing a little slack
    // for the few microseconds between Date.now()s.
    expect(ms > 2900 && ms < 3500).toBe(true);
  });

  it('falls back to exponential default when no headers given', () => {
    expect(_computeBackoffMsForTests(make({}), 1)).toBe(2000);
    expect(_computeBackoffMsForTests(make({}), 2)).toBe(4000);
    expect(_computeBackoffMsForTests(make({}), 3)).toBe(8000);
  });

  it('clamps absurd retry-after values to the cap', () => {
    const ms = _computeBackoffMsForTests(make({ 'retry-after': '9999' }), 1);
    expect(ms).toBe(60_000);
  });

  it('ignores a past anthropic-ratelimit reset timestamp and falls through to exponential', () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    const ms = _computeBackoffMsForTests(
      make({ 'anthropic-ratelimit-input-tokens-reset': past }), 1,
    );
    expect(ms).toBe(2000);
  });

  it('ignores a malformed retry-after and falls through', () => {
    const ms = _computeBackoffMsForTests(make({ 'retry-after': 'soon' }), 2);
    expect(ms).toBe(4000);
  });
});
