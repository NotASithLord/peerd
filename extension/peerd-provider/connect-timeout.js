// @ts-check
// Connect-timeout + connection-drop retry for streaming provider calls.
//
// A model call can hang forever if the server never sends response HEADERS.
// fetch() resolves on headers — BEFORE the SSE body — so we guard ONLY the
// initial response with a timeout and CLEAR it the moment headers arrive. The
// (potentially long, healthy) token stream then flows UNTIMED. Composes with the
// caller's Stop signal so the user can still abort mid-call.
//
// The same seam also hosts the connection-drop retry (owner request: "bake in
// model retries if a connection drops when you try to send a message, just 3
// times max"): when the initial fetch REJECTS at the network level — fetch
// surfaces connection reset/refused/DNS blips as a bare TypeError — the call
// is retried with a short backoff. See fetchInitialResponseWithRetry below
// for the exact semantics and the deliberate non-retry cases.
//
// Pure-ish: fetchFn + signals + sleep injected, so it's unit-testable.

/**
 * The injected fetch — the egress-gated `safeFetch` the adapters thread through.
 * A structural subset of the platform `fetch` (it takes the same args and
 * resolves a Response), declared here so the connect helpers don't demand the
 * full `typeof fetch` overload set.
 * @typedef {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} SafeFetch
 */

/**
 * Combine 1–2 abort signals into one. Pure.
 * @param {AbortSignal} [a]
 * @param {AbortSignal} [b]
 * @returns {AbortSignal | undefined}
 */
export const combineSignals = (a, b) => {
  // Typed predicate (runtime-identical to filter(Boolean) for these never-
  // falsy-when-present values) so TS narrows the result to AbortSignal[] for
  // AbortSignal.any / the fallback loop below.
  const signals = [a, b].filter(/** @returns {s is AbortSignal} */ (s) => s !== undefined);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(signals);
  }
  // Fallback relay for runtimes without AbortSignal.any.
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctl.abort(s.reason); break; }
    s.addEventListener('abort', () => ctl.abort(s.reason), { once: true });
  }
  return ctl.signal;
};

/**
 * Fetch the INITIAL response with a connect timeout. Returns the Response (its
 * headers); the caller streams `res.body` untimed. The connect timer is cleared
 * as soon as headers arrive (or the fetch throws), so it can never abort a
 * healthy in-progress stream.
 *
 * On timeout (and only when it wasn't the caller's Stop), throws whatever
 * `onTimeout(timeoutMs)` returns — a typed, legible error so the turn fails
 * clearly instead of hanging.
 *
 * @param {SafeFetch} fetchFn
 * @param {string|URL|Request} url
 * @param {RequestInit} init
 * @param {{ stopSignal?: AbortSignal, timeoutMs: number, onTimeout: (ms:number)=>Error }} opts
 * @returns {Promise<Response>}
 */
export const fetchInitialResponse = async (fetchFn, url, init, { stopSignal, timeoutMs, onTimeout }) => {
  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: combineSignals(stopSignal, timeoutCtl.signal) });
  } catch (e) {
    // The connect timer fired (no headers in time) and it wasn't the user's Stop.
    if (timeoutCtl.signal.aborted && !(stopSignal && stopSignal.aborted)) throw onTimeout(timeoutMs);
    throw e; // user Stop (AbortError, handled upstream as a clean stop) or other network error
  } finally {
    clearTimeout(timer); // headers arrived or threw → stop guarding; the SSE body streams untimed
  }
};

// why 3: the owner asked for "just 3 times max". Read conservatively as
// 3 TOTAL attempts — the initial try plus up to 2 retries — so a flaky
// network gets two more chances but a dead one fails legibly in ~2s of
// added wait, not minutes. (The alternative reading, initial + 3 retries,
// would mean 4 network calls — more than "3 times".)
export const MAX_CONNECT_ATTEMPTS = 3;
// why a short fixed ladder, no jitter: a dropped connection either heals in
// well under a second (Wi-Fi blip, VPN re-handshake) or it doesn't; and unlike
// the adapters' rate-limit backoff there is no synchronized-client herd to
// de-correlate — each browser retries its own private failure. waitMs is
// indexed by the attempt that just failed: 500ms after attempt 1, 1500ms
// after attempt 2.
export const CONNECT_RETRY_BACKOFF_MS = Object.freeze([500, 1500]);

/**
 * Promise sleep that respects an AbortSignal. Rejects with AbortError when
 * the signal fires, so a user Stop during a retry backoff unwinds immediately
 * — the agent loop already treats AbortError as a clean stop. Shared by the
 * retry helper here and by the adapters' rate-limit backoff loops.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export const abortableSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new DOMException('Aborted', 'AbortError'));
    return;
  }
  const t = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(t);
    reject(new DOMException('Aborted', 'AbortError'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/**
 * Decide whether a failed initial fetch should be retried, and how long to
 * wait first. Pure — values in, values out — so Bun pins the decision table
 * without timers or fetch stubs.
 *
 * Retry ONLY fetch's network-level failure mode: a bare TypeError
 * ("Failed to fetch" — connection reset/refused, DNS, TLS). Never retried:
 *   - user aborts: AbortError is a DOMException, and `stopAborted` is checked
 *     first for paranoia in case an abort surfaces in another shape;
 *   - typed connect-timeout errors from onTimeout — they already burned a
 *     full timeoutMs budget; tripling that would hide a down server;
 *   - egress denials / provider errors — deterministic, retry can't help;
 *   - HTTP error responses — fetch RESOLVED, so they never reach this
 *     function; the adapters' status-code retry loops own those.
 *
 * @param {{ error: unknown, attempt: number, maxAttempts?: number, stopAborted?: boolean }} args
 *   `attempt` is 1-indexed: the number of tries made so far, including the
 *   one that just failed.
 * @returns {{ retry: false } | { retry: true, waitMs: number }}
 */
export const decideConnectRetry = ({ error, attempt, maxAttempts = MAX_CONNECT_ATTEMPTS, stopAborted = false }) => {
  if (stopAborted) return { retry: false };
  if (!(error instanceof TypeError)) return { retry: false };
  if (attempt >= maxAttempts) return { retry: false };
  // Clamp to the last ladder entry so a caller-supplied maxAttempts larger
  // than the ladder still gets a sane wait instead of undefined.
  const waitMs = CONNECT_RETRY_BACKOFF_MS[Math.min(attempt, CONNECT_RETRY_BACKOFF_MS.length) - 1];
  return { retry: true, waitMs };
};

/**
 * fetchInitialResponse with connection-drop retry. Same contract — returns
 * the Response whose headers arrived; the caller streams `res.body` untimed —
 * but a network-level rejection (TypeError) of the INITIAL fetch is retried
 * up to maxAttempts total tries with a short backoff.
 *
 * Scope boundary (deliberate): this only ever re-sends when fetch REJECTED,
 * i.e. before response headers existed and before any stream bytes were
 * consumed, so a retry can never duplicate model output. A connection that
 * dies MID-STREAM (after partial events were yielded downstream) is NOT
 * retried here — blindly re-sending would replay text/tool deltas the agent
 * loop already consumed; the loop's stopReason === 'incomplete' path surfaces
 * those drops legibly instead.
 *
 * @param {SafeFetch} fetchFn
 * @param {string|URL|Request} url
 * @param {RequestInit} init
 * @param {{ stopSignal?: AbortSignal, timeoutMs: number, onTimeout: (ms:number)=>Error,
 *           maxAttempts?: number,
 *           sleepFn?: (ms:number, signal?:AbortSignal)=>Promise<void> }} opts
 *   `sleepFn` is a test seam (adapters thread their `_sleep` through) so unit
 *   tests exercise the retry path without real timers.
 * @returns {Promise<Response>}
 */
export const fetchInitialResponseWithRetry = async (fetchFn, url, init, opts) => {
  const {
    stopSignal, timeoutMs, onTimeout,
    maxAttempts = MAX_CONNECT_ATTEMPTS,
    sleepFn = abortableSleep,
  } = opts;
  for (let attempt = 1; ; attempt++) {
    // why: re-check the stop signal before every attempt. The backoff sleep
    // rejects on abort, but a Stop that lands between microtasks (or before
    // the first try) must not trigger another network call.
    if (stopSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await fetchInitialResponse(fetchFn, url, init, { stopSignal, timeoutMs, onTimeout });
    } catch (e) {
      const verdict = decideConnectRetry({
        error: e,
        attempt,
        maxAttempts,
        // Checked again AFTER the attempt: some runtimes surface an abort of
        // an in-flight fetch in non-AbortError shapes; the signal is truth.
        stopAborted: !!(stopSignal && stopSignal.aborted),
      });
      if (!verdict.retry) throw e;
      await sleepFn(verdict.waitMs, stopSignal); // AbortError on Stop → unwinds here
    }
  }
};
