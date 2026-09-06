// @ts-check
// OpenRouter adapter.
//
// OpenRouter is an OpenAI-compatible gateway to hundreds of models
// (Anthropic, OpenAI, Google, Mistral, Llama, …) behind ONE key and ONE
// endpoint. That makes it the highest-leverage second provider: shipping
// it gives peerd vendor-agnostic model access without a per-vendor
// adapter each. The wire format is OpenAI /chat/completions, so this
// adapter reuses to-openai.js / from-openai.js.
//
// The named model-egress authority injects only fixed provider operations;
// endpoints, credentials, and authentication policy never enter this module.

import { toOpenAiBody } from '../format/to-openai.js';
import { fromOpenAiStream } from '../format/from-openai.js';
import { readModelWindow } from '../model-window.js';
import { abortableSleep, openInitialResponseWithRetry } from '../connect-timeout.js';
import {
  ProviderError,
  ProviderHttpError,
  ProviderUsageLimitError,
} from '../errors.js';
import { isUsageLimitResponse, apiErrorMessage } from '../error-classify.js';
import { normalizeOpenRouterModels } from '../semantic-metadata.js';
export { OPENROUTER_POPULAR } from '../semantic-metadata.js';
// Connect timeout for the response headers; the SSE body streams untimed.
const CONNECT_TIMEOUT_MS = 45_000;

// Default model id. OpenRouter model ids are `vendor/model`; the user
// picks their own in Settings. GLM-5.1 is the strongest OPEN-WEIGHTS model
// for agentic tool-calling on OpenRouter as of mid-2026 (#1 on the BFCL/
// Tau-Bench tool-use leaderboard, ahead of proprietary models) — exactly the
// profile a browser agent harness wants for its default. Reliable JSON
// tool-call emission matters more here than raw coding throughput. Runner-up
// open picks: moonshotai/kimi-k2.6, minimax/minimax-m2 (see MODEL_CATALOG).
export const DEFAULT_MODEL = 'z-ai/glm-5.1';

// why: the web actor default — Haiku reached via OpenRouter's gateway. Same
// intent as Anthropic's DEFAULT_RUNNER_MODEL: a fast cheap model for the
// high-frequency page-driving actor. If the user's OpenRouter account can't
// reach Anthropic, the actor falls back to the inherited chat model.
export const DEFAULT_RUNNER_MODEL = 'anthropic/claude-haiku-4.5';

const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60_000;

/**
 * @typedef {import('../types.js').InternalMessage} InternalMessage
 * @typedef {import('../format/from-anthropic.js').ProviderEvent} ProviderEvent
 * @typedef {import('../model-egress.js').ModelEgress} ModelEgress
 */

/**
 * Call OpenRouter /chat/completions and stream events back. Mirrors the
 * Anthropic adapter's signature; `reasoning` is accepted but ignored
 * (OpenRouter has no Anthropic-style signed thinking blocks to replay).
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
export async function* callOpenRouter(args) {
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

  // why two retry layers: connection-drop retry (TypeError rejections, up to
  // 3 total attempts) rides inside this HTTP loop — orthogonal failure modes;
  // a network drop never produces a Response for the status logic below.
  for (let attempt = 1; ; attempt++) {
    const res = await openInitialResponseWithRetry(
      (requestSignal) => modelEgress.openInference({
        providerId: 'openrouter',
        modelId: model,
        nativeBody: body,
        signal: requestSignal,
      }), {
      stopSignal: signal,
      timeoutMs: CONNECT_TIMEOUT_MS,
      onTimeout: (ms) => new ProviderError('openrouter', `the API did not respond within ${ms / 1000}s — it may be unreachable or down. Try again.`),
      sleepFn: _sleep,
      },
    );
    if (res.ok) {
      if (!res.body) {
        throw new ProviderError('openrouter', 'response has no body (streaming requires it)');
      }
      yield* fromOpenAiStream(res.body);
      return;
    }
    // Non-2xx: read the body ONCE (drains the socket for reuse), then classify
    // before deciding to retry. why: OpenRouter returns 402 when the account
    // is out of credit and 429 for transient throttling — only the latter is
    // worth retrying. A hard limit fails fast and explicit (see anthropic.js).
    let bodyText = '';
    try { bodyText = await res.text(); }
    catch { bodyText = ''; }
    if (isUsageLimitResponse(res.status, bodyText)) {
      throw new ProviderUsageLimitError('openrouter', {
        status: res.status,
        detail: apiErrorMessage(bodyText),
      });
    }
    // why include 500: OpenRouter is a gateway proxying upstream providers, so
    // a transient upstream blip commonly surfaces as a one-off 500 (api_error).
    // The Anthropic adapter already retries 500 for the same reason (anthropic.js)
    // — without it here, a single transient 500 killed the whole turn even though
    // an immediate retry almost always succeeds. The hard-limit fast-fail above
    // (isUsageLimitResponse) already caught a 500 carrying a billing needle.
    const retryable = res.status === 429 || res.status === 500
      || res.status === 503 || res.status === 529;
    if (retryable && attempt <= MAX_RATE_LIMIT_RETRIES) {
      const waitMs = computeBackoffMs(res.headers, attempt);
      yield { type: 'rate-limit-pause', retryAfterMs: waitMs, attempt };
      await _sleep(waitMs, signal);
      continue;
    }
    throw new ProviderHttpError('openrouter', res.status, bodyText.slice(0, 1024) || '<no body>');
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

// Abort-aware sleep lives in connect-timeout.js (abortableSleep) — shared
// with the connection-drop retry so there is exactly one implementation.

export const _computeBackoffMsForTests = computeBackoffMs;

/**
 * Live model inventory from GET /api/v1/models — the whole gateway catalog,
 * id-sorted. Powers the Settings curation picker (and doubles as the key
 * verification probe: a 200 with models means the key authenticates). Throws
 * the adapter's typed errors on failure so callers surface a legible message.
 *
 * Note this is NOT wired as the adapter's `listModels` descriptor hook: that
 * hook means "the live inventory IS the chat catalog" (Ollama), but for
 * OpenRouter the chat catalog is the user's CURATED subset, not all ~300
 * models. So this is a plain export the chassis calls for the picker only.
 *
 * @param {Object} deps
 * @param {ModelEgress} deps.modelEgress
 * @param {AbortSignal} [deps.signal]
 * @returns {Promise<Array<{ model: string, label: string, contextLength: number,
 *   promptPrice: number, completionPrice: number }>>}
 */
export const listOpenRouterModels = async ({ modelEgress, signal } = /** @type {any} */ ({})) => {
  const res = await modelEgress.readModelInventory({ providerId: 'openrouter', signal });
  if (!res.ok) {
    // A 401/403 here is exactly the "bad/insufficient key" signal the
    // Settings auto-verify wants to surface; the status rides the error.
    let excerpt = '';
    try { excerpt = (await res.text()).slice(0, 1024); }
    catch { excerpt = '<no body>'; }
    throw new ProviderHttpError('openrouter', res.status, excerpt);
  }
  return normalizeOpenRouterModels(await res.json());
};

/**
 * Fetch the live context window for a model from OpenRouter's models
 * endpoint (`context_length`, falling back to `top_provider.context_length`).
 * Best-effort: returns null on any non-OK / unparseable / missing-entry
 * path so the caller falls back to the static table. Never throws.
 *
 * @param {Object} args
 * @param {string} args.model
 * @param {ModelEgress} args.modelEgress
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<number | null>}
 */
export const fetchOpenRouterContextWindow = async ({ model, modelEgress, signal }) => {
  if (typeof model !== 'string' || !model) return null;
  return readModelWindow({
    readResponse: (requestSignal) => modelEgress.readModelContext({
      providerId: 'openrouter',
      modelId: model,
      signal: requestSignal,
    }),
    extract: (body) => {
      /** @type {any[] | null} */
      const list = Array.isArray(body?.data) ? body.data : null;
      if (!list) return null;
      const entry = list.find((m) => m?.id === model);
      if (!entry) return null;
      // why the SMALLER: top-level context_length is the model's nominal
      // max across providers; top_provider.context_length is the window the
      // routed provider actually SERVES, which can be smaller. For a trim
      // trigger whose job is to avoid overflow, the conservative (served)
      // window is the safe one.
      const candidates = [entry.context_length, entry.top_provider?.context_length]
        .filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
      return candidates.length ? Math.min(...candidates) : null;
    },
    signal,
  });
};

/**
 * Adapter descriptor — the shape the provider registry stores.
 */
export const openrouterAdapter = Object.freeze({
  name: 'openrouter',
  label: 'OpenRouter',
  defaultModel: DEFAULT_MODEL,
  defaultRunnerModel: DEFAULT_RUNNER_MODEL,
  call: callOpenRouter,
  // live per-model window for the trim trigger (providerModelContextWindow).
  contextWindow: fetchOpenRouterContextWindow,
});
