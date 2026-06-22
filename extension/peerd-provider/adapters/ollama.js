// @ts-check
// Ollama adapter — native local inference.
//
// Ollama serves an OpenAI-compatible /v1/chat/completions (SSE streaming,
// tool calls included) on http://localhost:11434, so this adapter reuses
// the same to-openai.js / from-openai.js format layer the OpenRouter
// adapter does. What's DIFFERENT about local inference:
//
//   - KEYLESS. There is no API key; `keyless: true` on the descriptor
//     tells the chassis to skip vault checks instead of storing a fake
//     secret. callOllama never calls getSecret.
//   - LIVE MODEL INVENTORY. The available models are whatever the user
//     has pulled — a static catalog would lie. listOllamaModels reads
//     GET /api/tags so the model picker shows the real local inventory.
//   - LEGIBLE FAILURE. The most common failure mode by far is "the
//     daemon isn't running": fetch rejects with a bare TypeError. That
//     maps to OllamaNotRunningError so the user sees the one-command fix
//     instead of "Failed to fetch".
//
// Same DI contract as the other adapters: `safeFetch` is injected; this
// module never imports peerd-egress. (localhost:11434 is on the
// hardcoded egress allowlist — see peerd-egress/fetch/allowlist.js.)

import { toOpenAiBody } from '../format/to-openai.js';
import { fromOpenAiStream } from '../format/from-openai.js';
import { fetchModelWindow } from '../model-window.js';
import { abortableSleep, fetchInitialResponseWithRetry } from '../connect-timeout.js';
import {
  ProviderError,
  ProviderHttpError,
  OllamaNotRunningError,
} from '../errors.js';

const ORIGIN = 'http://localhost:11434';
const ENDPOINT = `${ORIGIN}/v1/chat/completions`;
const TAGS_ENDPOINT = `${ORIGIN}/api/tags`;
const SHOW_ENDPOINT = `${ORIGIN}/api/show`;

// why 120s (vs the 45s the cloud adapters use): Ollama sends response
// headers only after the model is LOADED into memory — a cold start on a
// 14B-class model from a slow disk can take well over a minute. The
// timeout exists to catch a hung daemon, not to race a healthy load.
const CONNECT_TIMEOUT_MS = 120_000;

// Default model id. Only used before the live /api/tags inventory is
// available (e.g. a custom Settings entry on a fresh install). Kept in
// the same family as the recommendation tiers (ollama-recommend.js):
// tool-capable, mid-size, runs on most 16GB machines.
export const DEFAULT_MODEL = 'qwen3:8b';

/**
 * @typedef {import('../types.js').InternalMessage} InternalMessage
 * @typedef {import('../format/from-anthropic.js').ProviderEvent} ProviderEvent
 */

/**
 * Call the local Ollama daemon and stream events back. Mirrors the
 * OpenRouter adapter's signature; `getSecret` and `reasoning` are
 * accepted but ignored (keyless; no signed thinking blocks).
 *
 * @param {Object} args
 * @param {readonly InternalMessage[]} args.messages
 * @param {string} args.system
 * @param {string} [args.model]
 * @param {number} [args.maxTokens]
 * @param {ReadonlyArray<{ name: string, description: string, schema: object }>} [args.tools]
 * @param {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} args.safeFetch
 * @param {AbortSignal} [args.signal]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [args._sleep]
 *   Test seam for the connection-drop retry backoff — same contract as the
 *   other adapters' _sleep. Production callers leave it undefined.
 * @returns {AsyncGenerator<ProviderEvent>}
 */
export async function* callOllama(args) {
  const {
    messages, system,
    model = DEFAULT_MODEL,
    maxTokens,
    tools,
    safeFetch,
    signal,
    _sleep = abortableSleep,
  } = args;

  const body = toOpenAiBody({ model, system, messages, tools, maxTokens });
  const requestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  };

  let res;
  try {
    res = await fetchInitialResponseWithRetry(safeFetch, ENDPOINT, requestInit, {
      stopSignal: signal,
      timeoutMs: CONNECT_TIMEOUT_MS,
      onTimeout: (ms) => new ProviderError('ollama', `no response within ${ms / 1000}s — the daemon may be hung, or the model is still loading. Try again.`),
      // why 2 total attempts here (not the shared default of 3): on
      // localhost a TypeError almost always means the daemon isn't running,
      // and a daemon that isn't running won't appear during a backoff — the
      // legible OllamaNotRunningError below IS the feature. One retry covers
      // a genuine transient drop at +500ms; more would only delay the
      // one-command fix message.
      maxAttempts: 2,
      sleepFn: _sleep,
    });
  } catch (e) {
    // fetch rejects with a bare TypeError on connection-refused — the
    // "daemon not running" case (after the single connect retry above gave
    // up). Everything else (AbortError from Stop, EgressDeniedError, our
    // own typed errors) passes through untouched.
    if (e instanceof TypeError) throw new OllamaNotRunningError();
    throw e;
  }

  if (!res.ok) {
    let excerpt = '';
    try { excerpt = (await res.text()).slice(0, 1024); }
    catch { excerpt = '<no body>'; }
    // 404 from /v1/chat/completions means the model isn't pulled — name
    // the fix, the same legibility rule as the not-running case.
    if (res.status === 404) {
      throw new ProviderError('ollama', `model '${model}' isn’t available locally — run \`ollama pull ${model}\` first.`);
    }
    throw new ProviderHttpError('ollama', res.status, excerpt);
  }
  if (!res.body) {
    throw new ProviderError('ollama', 'response has no body (streaming requires it)');
  }
  yield* fromOpenAiStream(res.body, { provider: 'ollama' });
}

/**
 * Live local model inventory from GET /api/tags. Returns the models the
 * user has actually pulled, name-sorted, so pickers reflect reality.
 *
 * @param {Object} deps
 * @param {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} deps.safeFetch
 * @param {AbortSignal} [deps.signal]
 * @returns {Promise<Array<{ model: string, label: string, sizeBytes: number }>>}
 */
export const listOllamaModels = async ({ safeFetch, signal }) => {
  let res;
  try {
    res = await safeFetch(TAGS_ENDPOINT, { method: 'GET', signal });
  } catch (e) {
    if (e instanceof TypeError) throw new OllamaNotRunningError();
    throw e;
  }
  if (!res.ok) {
    let excerpt = '';
    try { excerpt = (await res.text()).slice(0, 1024); }
    catch { excerpt = '<no body>'; }
    throw new ProviderHttpError('ollama', res.status, excerpt);
  }
  const data = await res.json();
  // why any[]: /api/tags JSON is provider-shaped + runtime-validated below
  // (the typeof guard), not a contract we own a type for.
  /** @type {any[]} */
  const models = Array.isArray(data?.models) ? data.models : [];
  return models
    .filter((m) => typeof m?.name === 'string' && m.name.length > 0)
    .map((m) => ({
      model: m.name,
      label: m.name,
      sizeBytes: Number(m.size) || 0,
    }))
    .sort((a, b) => a.model.localeCompare(b.model));
};

/**
 * Live context window for an Ollama model via POST /api/show.
 *
 * why num_ctx FIRST: the trim trigger needs the window the model will
 * ACTUALLY run with for peerd's requests, not the model's theoretical max.
 * Ollama loads a model at its configured `num_ctx` (Modelfile/parameters),
 * defaulting low (commonly 4096) when unset — and peerd's adapter doesn't
 * override it. So a configured `num_ctx` (from `parameters`) is the honest
 * usable window; we report it when present. Absent that, we fall back to
 * the model's architecture `*.context_length` (its capability ceiling) —
 * better than the static nominal, though it can over-state if the daemon's
 * runtime default num_ctx is lower and unconfigured. (A future enhancement
 * is for callOllama to SET num_ctx to the resolved window so used == known.)
 *
 * Best-effort: returns null on any failure → caller uses the static table.
 *
 * @param {Object} args
 * @param {string} args.model
 * @param {(resource: string | URL | Request, init?: RequestInit) => Promise<Response>} args.safeFetch
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<number | null>}
 */
export const fetchOllamaContextWindow = async ({ model, safeFetch, signal }) => {
  if (typeof model !== 'string' || !model) return null;
  return fetchModelWindow({
    safeFetch,
    url: SHOW_ENDPOINT,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    },
    extract: (body) => {
      // 1) Configured num_ctx from the parameters blob (the effective
      //    window). Format is one "name value" per line; num_ctx may be
      //    quoted. why the LAST match: parameter blobs can carry overrides,
      //    and Ollama applies last-wins — taking the first would report a
      //    superseded (often smaller) value and over-trim.
      if (typeof body?.parameters === 'string') {
        const matches = [...body.parameters.matchAll(/(?:^|\n)\s*num_ctx\s+"?(\d+)"?/g)];
        if (matches.length > 0) return Number(matches[matches.length - 1][1]);
      }
      // 2) Model architecture context_length (capability ceiling).
      const info = body?.model_info;
      if (info && typeof info === 'object') {
        for (const [key, value] of Object.entries(info)) {
          if (key.endsWith('.context_length') && typeof value === 'number') return value;
        }
      }
      return null;
    },
    signal,
  });
};

/**
 * Adapter descriptor — the shape the provider registry stores.
 * `keyless: true` + `vaultSecretName: null` mark local inference: the
 * chassis skips key checks rather than storing a placeholder secret.
 * `listModels` marks a live inventory source (vs a static catalog).
 */
export const ollamaAdapter = Object.freeze({
  name: 'ollama',
  label: 'Ollama (local)',
  endpoint: ENDPOINT,
  defaultModel: DEFAULT_MODEL,
  // why: Ollama has no separate fast/cheap tier the way the cloud gateways
  // do — the runner rides the same local model as chat. Set it explicitly
  // (rather than leaving it undefined) so every adapter carries a runner
  // default; the resolver treats "same as chat" as the correct local posture.
  defaultRunnerModel: DEFAULT_MODEL,
  vaultSecretName: null,
  keyless: true,
  call: callOllama,
  listModels: listOllamaModels,
  // live per-model window for the trim trigger (providerModelContextWindow).
  contextWindow: fetchOllamaContextWindow,
});
