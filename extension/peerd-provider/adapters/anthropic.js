// @ts-check
// Anthropic adapter.
//
// Glues together the format helpers (pure) with the IO shell (fetch,
// secret lookup, error mapping). The adapter's `call` is an async
// generator yielding internal ProviderEvent values.
//
// Dependency injection (architecture.md §2.1): the adapter takes
// `safeFetch` and `getSecret` from its caller — it does NOT import
// peerd-egress. This is enforced at the type level (caller passes
// concrete functions) and at the architectural level (provider is
// Layer 1, egress is Layer 1, and Layer 1 modules don't import each
// other).

import { toAnthropicBody } from '../format/to-anthropic.js';
import { fromAnthropicStream } from '../format/from-anthropic.js';
import { fetchModelWindow } from '../model-window.js';
import { abortableSleep, fetchInitialResponseWithRetry } from '../connect-timeout.js';
import {
  ProviderError,
  ProviderHttpError,
  ProviderKeyMissingError,
  ProviderUsageLimitError,
} from '../errors.js';
import { isUsageLimitResponse, apiErrorMessage } from '../error-classify.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
// why: the Models API (same host, already allowlisted) reports the live
// context window per model id (`max_input_tokens`, GA since 2026-03) — the
// authoritative source for the trim trigger, since a model's window can
// change without an id change and a static table drifts.
const MODELS_ENDPOINT = 'https://api.anthropic.com/v1/models';
const API_VERSION = '2023-06-01';
const VAULT_SECRET_NAME = 'anthropic_api_key';
// Connect timeout: how long to wait for the API's response HEADERS before
// giving up. Generous — headers arrive fast even when token generation is slow,
// so this only fires when the server is truly unresponsive. The body stream is
// NOT subject to it (see connect-timeout.js).
const CONNECT_TIMEOUT_MS = 45_000;

// Transient-error backoff. Anthropic returns 429 for token-per-minute
// exhaustion, 529 when the service is overloaded, and 500/503 for
// transient server faults (api_error / brief unavailability). All
// four are retryable — the right move is to wait and try again.
// Without this, a single screenshot-heavy turn (Gmail sweep, docs
// scrape) trips the input-tokens-per-minute limit — or a one-off
// api_error blip — and the whole turn ends with a user-facing error,
// even though the next attempt would have succeeded.
const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 2000;
// Cap on per-retry wait so a misbehaving server can't pin us for
// minutes. 60s is long enough to ride out Anthropic's per-minute
// token bucket, which is the only real backoff signal we expect.
const MAX_BACKOFF_MS = 60_000;

// V1 default. Side panel will eventually let the user pick; the model
// id can be overridden per-call via `args.model`. Sonnet 4.6 is the V1
// default for cost reasons — chat is fine on Sonnet and users won't
// pay Opus rates by surprise.
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

// why: the browser-runner (the disposable subagent behind do/get/check —
// the "page-reader") is a narrow, high-frequency, latency-sensitive job. It
// gets its OWN default: the latest Haiku, fast and cheap, reached with the
// same Anthropic key. So out of the box page reads ride Haiku while chat
// keeps Sonnet — instead of the runner inheriting (and re-paying) the chat
// model. Overridable via the Page-reader model setting; runRunner falls back
// to the inherited chat model when the runner blows its step budget.
export const DEFAULT_RUNNER_MODEL = 'claude-haiku-4-5';

/**
 * @typedef {import('../types.js').InternalMessage} InternalMessage
 * @typedef {import('../format/from-anthropic.js').ProviderEvent} ProviderEvent
 */

/**
 * Call Anthropic /v1/messages and stream events back.
 *
 * @param {Object} args
 * @param {readonly InternalMessage[]} args.messages
 * @param {string} args.system
 * @param {string} [args.model]                          defaults to DEFAULT_MODEL
 * @param {number} [args.maxTokens]
 * @param {ReadonlyArray<{ name: string, description: string, schema: object }>} [args.tools]
 *   Tool descriptors the model may call. Optional; if omitted or
 *   empty, the model receives no tools and responds with text only.
 * @param {{ enabled?: boolean, budgetTokens?: number, effort?: 'low'|'medium'|'high'|'xhigh'|'max' }} [args.reasoning]
 *   Extended-thinking control. When enabled, the model streams a
 *   reasoning block before its answer (surfaced as reasoning-* events).
 * @param {AbortSignal} [args.signal]
 *   User-driven cancellation (Stop button / new message mid-stream).
 *   Flows into fetch — cuts the SSE socket — and into the retry sleep,
 *   so an abort during a backoff wait unwinds immediately.
 * @param {(name: string) => Promise<string | null>} args.getSecret
 * @param {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} args.safeFetch
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [args._sleep]
 *   Test seam: overrides the real setTimeout-based sleep so unit tests
 *   for the retry paths (429 backoff AND connection-drop) don't wait
 *   real time. Production callers leave it undefined.
 * @returns {AsyncGenerator<ProviderEvent>}
 */
export async function* callAnthropic(args) {
  const {
    messages, system,
    model = DEFAULT_MODEL,
    maxTokens,
    tools,
    reasoning,
    getSecret, safeFetch,
    signal,
    _sleep = abortableSleep,
  } = args;

  const apiKey = await getSecret(VAULT_SECRET_NAME);
  if (!apiKey) throw new ProviderKeyMissingError('anthropic');

  const body = toAnthropicBody({ model, system, messages, tools, maxTokens, reasoning });
  const requestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      // Anthropic blocks browser-origin requests by default and
      // requires this header as an explicit ack that the caller knows
      // the API key is exposed to client-side code. peerd is built
      // exactly for this model — the key lives encrypted in the
      // vault, the SW handles requests, and the user understands
      // they're shipping their own credentials. We acknowledge.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    // AbortSignal flows through to native fetch — when the user clicks
    // Stop or sends a new message mid-stream, the SSE body stream is
    // cut and the SW reclaims its socket promptly.
    signal,
  };

  // safeFetch enforces the egress allowlist. The endpoint is on the
  // hardcoded list (peerd-egress/fetch/allowlist.js), so this always
  // gets through unless the user has somehow rebuilt the extension.
  // Retry loop: 429 (token-bucket exhausted), 529 (overloaded), and
  // the transient server faults 500 (api_error) / 503 are retryable.
  // Everything else falls through to the throw path immediately.
  // why two retry layers: connection-drop retry (TypeError rejections,
  // up to 3 total attempts — fetchInitialResponseWithRetry) rides INSIDE
  // this HTTP loop. They are orthogonal failure modes: a network drop
  // never produces a Response, so it never reaches the status-code logic
  // below, and an HTTP error never re-enters the connect retry.
  for (let attempt = 1; ; attempt++) {
    const res = await fetchInitialResponseWithRetry(safeFetch, ENDPOINT, requestInit, {
      stopSignal: signal,
      timeoutMs: CONNECT_TIMEOUT_MS,
      onTimeout: (ms) => new ProviderError('anthropic', `the API did not respond within ${ms / 1000}s — it may be unreachable or down. Try again.`),
      sleepFn: _sleep,
    });
    if (res.ok) {
      if (!res.body) {
        throw new ProviderError('anthropic', 'response has no body (streaming requires it)');
      }
      yield* fromAnthropicStream(res.body);
      return;
    }
    // Non-2xx: read the body ONCE (this also drains the socket for reuse)
    // so we can both classify the failure and carry a legible excerpt — no
    // double read across the retry / throw branches.
    let bodyText = '';
    try { bodyText = await res.text(); }
    catch { bodyText = ''; }
    // why: a HARD account limit (out of credit / over a spend or usage cap;
    // HTTP 402) is NOT transient — retrying just burns the budget and then
    // surfaces a misleading "throttled, try again". Fail fast and explicit so
    // the chat names the real cause. DISTINCT from a per-minute 429, which
    // carries no billing/credit/quota signal and still rides the retry below.
    if (isUsageLimitResponse(res.status, bodyText)) {
      throw new ProviderUsageLimitError('anthropic', {
        status: res.status,
        detail: apiErrorMessage(bodyText),
      });
    }
    // why: 500/503 join 429/529 — a one-off api_error used to kill the
    // whole turn even though an immediate-ish retry almost always
    // succeeds. Same backoff machinery; computeBackoffMs falls through
    // to the exponential default when no rate-limit headers are present.
    const retryable = res.status === 429 || res.status === 529
      || res.status === 500 || res.status === 503;
    if (retryable && attempt <= MAX_RATE_LIMIT_RETRIES) {
      const waitMs = computeBackoffMs(res.headers, attempt);
      yield {
        type: 'rate-limit-pause',
        retryAfterMs: waitMs,
        attempt,
      };
      await _sleep(waitMs, signal);
      continue;
    }
    // 1KB excerpt is enough for Anthropic's structured error responses.
    throw new ProviderHttpError('anthropic', res.status, bodyText.slice(0, 1024) || '<no body>');
  }
}

/**
 * Pick a wait duration from response headers, in priority order:
 *   1. `retry-after` — seconds (Anthropic's documented signal on 429)
 *   2. `anthropic-ratelimit-input-tokens-reset` — ISO timestamp of
 *      the input-token bucket refill, the relevant constraint for
 *      most peerd workloads (heavy tool results push input tokens)
 *   3. Exponential default: 2s, 4s, 8s
 *
 * @param {Headers} headers
 * @param {number} attempt   1-indexed
 * @returns {number}         milliseconds to wait, clamped to MAX_BACKOFF_MS
 */
const computeBackoffMs = (headers, attempt) => {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      // Add a small jitter so synchronized clients don't all retry at
      // the exact same second. 250-750ms is well below human notice.
      return Math.min(secs * 1000 + 250, MAX_BACKOFF_MS);
    }
  }
  const reset = headers.get('anthropic-ratelimit-input-tokens-reset');
  if (reset) {
    const resetAt = Date.parse(reset);
    if (Number.isFinite(resetAt)) {
      const delta = resetAt - Date.now();
      if (delta > 0) return Math.min(delta + 250, MAX_BACKOFF_MS);
    }
  }
  // Exponential fallback: 2s, 4s, 8s.
  return Math.min(DEFAULT_BACKOFF_MS * (2 ** (attempt - 1)), MAX_BACKOFF_MS);
};

// Abort-aware sleep lives in connect-timeout.js (abortableSleep) — shared
// with the connection-drop retry so there is exactly one implementation.

// why: test-only re-export. The retry path needs unit coverage on
// header parsing without going through the full callAnthropic generator
// — this is the cheapest way to do that without restructuring.
export const _computeBackoffMsForTests = computeBackoffMs;

/**
 * Fetch the live context window (`max_input_tokens`) for a model from the
 * Anthropic Models API. Best-effort: returns null on a missing key, a
 * non-OK response, an unparseable body, or a field that isn't a positive
 * number — the caller falls back to the static table. Never throws.
 *
 * Same DI contract as `call`: `getSecret` + `safeFetch` are injected.
 *
 * @param {Object} args
 * @param {string} args.model                          model id (e.g. 'claude-opus-4-8')
 * @param {(name: string) => Promise<string | null>} args.getSecret
 * @param {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} args.safeFetch
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<number | null>}
 */
export const fetchAnthropicContextWindow = async ({ model, getSecret, safeFetch, signal }) => {
  if (typeof model !== 'string' || !model) return null;
  let apiKey;
  try { apiKey = await getSecret(VAULT_SECRET_NAME); }
  catch { return null; }
  if (!apiKey) return null;
  return fetchModelWindow({
    safeFetch,
    url: `${MODELS_ENDPOINT}/${encodeURIComponent(model)}`,
    init: {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    },
    // max_input_tokens IS the input/context budget the trim trigger cares
    // about (output cap is a separate `max_tokens` field) — the right
    // quantity, not just the nominal total.
    extract: (body) => body?.max_input_tokens,
    signal,
  });
};

/**
 * Adapter descriptor — the shape the provider registry stores. Static
 * data only; the live `call` reference is the function above.
 */
export const anthropicAdapter = Object.freeze({
  name: 'anthropic',
  label: 'Anthropic',
  endpoint: ENDPOINT,
  defaultModel: DEFAULT_MODEL,
  defaultRunnerModel: DEFAULT_RUNNER_MODEL,
  vaultSecretName: VAULT_SECRET_NAME,
  call: callAnthropic,
  // why: the registry's providerModelContextWindow uses this when present to
  // get the live window for the trim trigger; adapters without it fall back
  // to the static table. Native Anthropic exposes it via the Models API.
  contextWindow: fetchAnthropicContextWindow,
});
