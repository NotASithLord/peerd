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
// Same DI contract as the Anthropic adapter: `safeFetch` + `getSecret`
// are injected; this module never imports peerd-egress.

import { toOpenAiBody } from '../format/to-openai.js';
import { fromOpenAiStream } from '../format/from-openai.js';
import { fetchModelWindow } from '../model-window.js';
import { abortableSleep, fetchInitialResponseWithRetry } from '../connect-timeout.js';
import {
  ProviderError,
  ProviderHttpError,
  ProviderKeyMissingError,
  ProviderUsageLimitError,
} from '../errors.js';
import { isUsageLimitResponse, apiErrorMessage } from '../error-classify.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
// The public models endpoint (same host, already allowlisted). Two readers:
// the Settings model-curation picker (listOpenRouterModels — the live catalog
// of every model the gateway exposes; public, but we send a key when present
// so a provisioning-scoped key sees its own list), and the trim trigger's
// live window lookup (`context_length` per model).
const MODELS_ENDPOINT = 'https://openrouter.ai/api/v1/models';
const VAULT_SECRET_NAME = 'openrouter_api_key';
// Connect timeout for the response headers; the SSE body streams untimed.
const CONNECT_TIMEOUT_MS = 45_000;

// Default model id. OpenRouter model ids are `vendor/model`; the user
// picks their own in Settings. gpt-4o-mini is a stable, cheap, tool-use-
// capable default that won't surprise anyone on cost.
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';

// why: the page-reader (do/get/check) runner default — Haiku reached via
// OpenRouter's gateway. Same intent as Anthropic's DEFAULT_RUNNER_MODEL: a
// fast cheap model for the high-frequency runner. If the user's OpenRouter
// account can't reach Anthropic, runRunner falls back to the inherited chat
// model on failure — so this degrades gracefully rather than hard-failing.
export const DEFAULT_RUNNER_MODEL = 'anthropic/claude-haiku-4.5';

const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60_000;

/**
 * @typedef {import('../types.js').InternalMessage} InternalMessage
 * @typedef {import('../format/from-anthropic.js').ProviderEvent} ProviderEvent
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
 * @param {(name: string) => Promise<string | null>} args.getSecret
 * @param {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} args.safeFetch
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
    getSecret, safeFetch,
    signal,
    _sleep = abortableSleep,
  } = args;

  const apiKey = await getSecret(VAULT_SECRET_NAME);
  if (!apiKey) throw new ProviderKeyMissingError('openrouter');

  const body = toOpenAiBody({ model, system, messages, tools, maxTokens });
  const requestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
      // why: OpenRouter attributes usage to an app by HTTP-Referer (the
      // app's URL — the ranking key) + X-Title (display name), with
      // X-OpenRouter-Categories placing it on the right leaderboard. Every
      // user's BYOK request carries the same referer, so it all rolls up to
      // one "peerd.ai" app entry on openrouter.ai/apps.
      'http-referer': 'https://peerd.ai',
      'x-title': 'peerd.ai',
      'x-openrouter-categories': 'personal-agent',
    },
    body: JSON.stringify(body),
    signal,
  };

  // why two retry layers: connection-drop retry (TypeError rejections, up to
  // 3 total attempts) rides inside this HTTP loop — orthogonal failure modes;
  // a network drop never produces a Response for the status logic below.
  for (let attempt = 1; ; attempt++) {
    const res = await fetchInitialResponseWithRetry(safeFetch, ENDPOINT, requestInit, {
      stopSignal: signal,
      timeoutMs: CONNECT_TIMEOUT_MS,
      onTimeout: (ms) => new ProviderError('openrouter', `the API did not respond within ${ms / 1000}s — it may be unreachable or down. Try again.`),
      sleepFn: _sleep,
    });
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
    const retryable = res.status === 429 || res.status === 503 || res.status === 529;
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

// Curated "popular" seed — the default set the Settings model picker shows
// BEFORE the user searches the full live catalog. why a curated list and not
// a live "top N": OpenRouter's /models endpoint carries no popularity rank, so
// "top 20" needs a concrete source. These ids are intersected with the live
// catalog at render time, so any that a given account can't reach simply drop
// out (never a 404 in the chat picker). Maintained by hand — see DECISIONS.
export const OPENROUTER_POPULAR = Object.freeze([
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/o4-mini',
  'anthropic/claude-3.7-sonnet',
  'anthropic/claude-3.5-sonnet',
  'anthropic/claude-3.5-haiku',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'google/gemini-2.0-flash-001',
  'meta-llama/llama-3.3-70b-instruct',
  'meta-llama/llama-3.1-8b-instruct',
  'deepseek/deepseek-chat',
  'deepseek/deepseek-r1',
  'mistralai/mistral-large',
  'mistralai/mistral-nemo',
  'qwen/qwen-2.5-72b-instruct',
  'x-ai/grok-2',
  'x-ai/grok-beta',
  'cohere/command-r-plus',
  'nousresearch/hermes-3-llama-3.1-70b',
]);

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
 * @param {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} deps.safeFetch
 * @param {(name: string) => Promise<string | null>} [deps.getSecret]
 * @param {AbortSignal} [deps.signal]
 * @returns {Promise<Array<{ model: string, label: string, contextLength: number,
 *   promptPrice: number, completionPrice: number }>>}
 */
export const listOpenRouterModels = async ({ safeFetch, getSecret, signal } = /** @type {any} */ ({})) => {
  /** @type {Record<string, string>} */
  const headers = {
    'http-referer': 'https://peerd.ai',
    'x-title': 'peerd.ai',
    'x-openrouter-categories': 'personal-agent',
  };
  // why: send the key when we have one (some accounts get a scoped list), but
  // don't require it — /models is public, so the picker can preview models
  // before a key is even saved.
  let apiKey = null;
  if (typeof getSecret === 'function') {
    try { apiKey = await getSecret(VAULT_SECRET_NAME); } catch { apiKey = null; }
  }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await safeFetch(MODELS_ENDPOINT, { method: 'GET', headers, signal });
  if (!res.ok) {
    // A 401/403 here is exactly the "bad/insufficient key" signal the
    // Settings auto-verify wants to surface; the status rides the error.
    let excerpt = '';
    try { excerpt = (await res.text()).slice(0, 1024); }
    catch { excerpt = '<no body>'; }
    throw new ProviderHttpError('openrouter', res.status, excerpt);
  }
  const data = await res.json();
  // why any[]: /models JSON is provider-shaped + runtime-validated below, not
  // a contract we own a type for.
  /** @type {any[]} */
  const models = Array.isArray(data?.data) ? data.data : [];
  return models
    .filter((entry) => typeof entry?.id === 'string' && entry.id.length > 0)
    .map((entry) => ({
      model: entry.id,
      label: typeof entry.name === 'string' && entry.name.length ? entry.name : entry.id,
      contextLength: Number(entry?.context_length) || 0,
      promptPrice: Number(entry?.pricing?.prompt) || 0,
      completionPrice: Number(entry?.pricing?.completion) || 0,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
};

/**
 * Fetch the live context window for a model from OpenRouter's models
 * endpoint (`context_length`, falling back to `top_provider.context_length`).
 * Best-effort: returns null on any non-OK / unparseable / missing-entry
 * path so the caller falls back to the static table. Never throws.
 *
 * The key is optional for this public endpoint but sent when present (same
 * attribution headers as `call`). Same DI contract: `safeFetch` injected.
 *
 * @param {Object} args
 * @param {string} args.model
 * @param {(name: string) => Promise<string | null>} [args.getSecret]
 * @param {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} args.safeFetch
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<number | null>}
 */
export const fetchOpenRouterContextWindow = async ({ model, getSecret, safeFetch, signal }) => {
  if (typeof model !== 'string' || !model) return null;
  let apiKey = null;
  try { apiKey = getSecret ? await getSecret(VAULT_SECRET_NAME) : null; }
  catch { apiKey = null; }
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json' };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
    headers['http-referer'] = 'https://peerd.ai';
    headers['x-title'] = 'peerd.ai';
    headers['x-openrouter-categories'] = 'personal-agent';
  }
  return fetchModelWindow({
    safeFetch,
    url: MODELS_ENDPOINT,
    init: { method: 'GET', headers },
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
  endpoint: ENDPOINT,
  defaultModel: DEFAULT_MODEL,
  defaultRunnerModel: DEFAULT_RUNNER_MODEL,
  vaultSecretName: VAULT_SECRET_NAME,
  call: callOpenRouter,
  // live per-model window for the trim trigger (providerModelContextWindow).
  contextWindow: fetchOpenRouterContextWindow,
});
