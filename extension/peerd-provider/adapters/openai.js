// @ts-check
// OpenAI adapter.
//
// Direct BYOK access to OpenAI's own API (api.openai.com), distinct from
// reaching OpenAI models through the OpenRouter gateway: a user with an
// OpenAI key and no OpenRouter account gets first-class access, billed to
// their OpenAI account. The wire format is the reference OpenAI
// /chat/completions, so this adapter reuses to-openai.js / from-openai.js
// exactly like the OpenRouter one — it is the OpenRouter adapter minus the
// gateway-attribution headers and the gateway's per-model window quirks.
//
// The named model-egress authority owns the fixed destination, credential,
// authentication, and network policy. This adapter sees only the native body
// it semantically constructs and the resulting response stream.

import { toOpenAiBody } from '../format/to-openai.js';
import { fromOpenAiStream } from '../format/from-openai.js';
import { abortableSleep, openInitialResponseWithRetry } from '../connect-timeout.js';
import {
  ProviderError,
  ProviderHttpError,
  ProviderUsageLimitError,
} from '../errors.js';
import { isUsageLimitResponse, apiErrorMessage } from '../error-classify.js';

// Connect timeout for the response headers; the SSE body streams untimed.
const CONNECT_TIMEOUT_MS = 45_000;

// Default chat model. GPT-5.1 is OpenAI's strongest general model for
// agentic tool-calling as of the knowledge cutoff; the user picks their own
// in Settings. Kept conservative and current — a fresh OpenAI user gets a
// capable default without curating.
export const DEFAULT_MODEL = 'gpt-5.1';
// The web actor default — a fast, cheap model for the high-frequency
// page-driving actor (same intent as the other adapters' runner default).
export const DEFAULT_RUNNER_MODEL = 'gpt-5.1-mini';

const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60_000;

/**
 * @typedef {import('../types.js').InternalMessage} InternalMessage
 * @typedef {import('../format/from-anthropic.js').ProviderEvent} ProviderEvent
 * @typedef {import('../model-egress.js').ModelEgress} ModelEgress
 */

/**
 * Call OpenAI /chat/completions and stream events back. Mirrors the
 * Anthropic adapter's signature; `reasoning` is accepted but ignored (the
 * chat-completions endpoint has no Anthropic-style signed thinking blocks
 * to replay).
 *
 * @param {Object} args
 * @param {readonly InternalMessage[]} args.messages
 * @param {string} args.system
 * @param {string} [args.model]
 * @param {number} [args.maxTokens]
 * @param {ReadonlyArray<{ name: string, description: string, schema: object }>} [args.tools]
 * @param {ModelEgress} args.modelEgress
 * @param {AbortSignal} [args.signal]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [args._sleep]
 * @returns {AsyncGenerator<ProviderEvent>}
 */
export async function* callOpenAi(args) {
  const {
    messages, system,
    model = DEFAULT_MODEL,
    maxTokens,
    tools,
    modelEgress,
    signal,
    _sleep = abortableSleep,
  } = args;

  const body = toOpenAiBody({ model, system, messages, tools, maxTokens });

  for (let attempt = 1; ; attempt++) {
    const res = await openInitialResponseWithRetry(
      (requestSignal) => modelEgress.openInference({
        providerId: 'openai',
        modelId: model,
        nativeBody: body,
        signal: requestSignal,
      }), {
      stopSignal: signal,
      timeoutMs: CONNECT_TIMEOUT_MS,
      onTimeout: (ms) => new ProviderError('openai', `the API did not respond within ${ms / 1000}s — it may be unreachable or down. Try again.`),
      sleepFn: _sleep,
      },
    );
    if (res.ok) {
      if (!res.body) {
        throw new ProviderError('openai', 'response has no body (streaming requires it)');
      }
      yield* fromOpenAiStream(res.body, { provider: 'openai' });
      return;
    }
    // Non-2xx: read the body ONCE (drains the socket for reuse), then classify
    // before deciding to retry. OpenAI returns 429 with an
    // insufficient_quota code on a spent account (a HARD limit) vs a plain
    // rate-limit 429 (transient); isUsageLimitResponse tells them apart on
    // the body needle so only the transient one retries.
    let bodyText = '';
    try { bodyText = await res.text(); }
    catch { bodyText = ''; }
    if (isUsageLimitResponse(res.status, bodyText)) {
      throw new ProviderUsageLimitError('openai', {
        status: res.status,
        detail: apiErrorMessage(bodyText),
      });
    }
    const retryable = res.status === 429 || res.status === 500
      || res.status === 503 || res.status === 529;
    if (retryable && attempt <= MAX_RATE_LIMIT_RETRIES) {
      const waitMs = computeBackoffMs(res.headers, attempt);
      yield { type: 'rate-limit-pause', retryAfterMs: waitMs, attempt };
      await _sleep(waitMs, signal);
      continue;
    }
    throw new ProviderHttpError('openai', res.status, bodyText.slice(0, 1024) || '<no body>');
  }
}

/**
 * @param {Headers} headers
 * @param {number} attempt   1-indexed
 * @returns {number}         milliseconds to wait, clamped to MAX_BACKOFF_MS
 */
const computeBackoffMs = (headers, attempt) => {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000 + 250, MAX_BACKOFF_MS);
    }
  }
  return Math.min(DEFAULT_BACKOFF_MS * (2 ** (attempt - 1)), MAX_BACKOFF_MS);
};

export const _computeBackoffMsForTests = computeBackoffMs;

// Curated "popular" seed for the Settings model picker — a small set of
// current OpenAI ids shown before the user searches. Intersected with the
// live /v1/models catalog at render time, so an id a given account can't
// reach simply drops out (never a 404 in the chat picker).
export const OPENAI_POPULAR = Object.freeze([
  'gpt-5.1',
  'gpt-5.1-mini',
  'gpt-5',
  'gpt-5-mini',
  'o4-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4o',
  'gpt-4o-mini',
]);

/**
 * Adapter descriptor — the shape the provider registry stores.
 */
export const openaiAdapter = Object.freeze({
  name: 'openai',
  label: 'OpenAI',
  defaultModel: DEFAULT_MODEL,
  defaultRunnerModel: DEFAULT_RUNNER_MODEL,
  call: callOpenAi,
  // NO contextWindow (issue #173): /v1/models carries no context-length field,
  // so a live fetcher here could only ever return null — and the catalog's
  // miss-retries-next-turn cache turned that into a guaranteed-futile
  // /v1/models round-trip on EVERY turn. Absent, the registry falls back to
  // the static window table (the documented contract for adapters without it).
});
