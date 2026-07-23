// @ts-check
// Z.ai GLM adapter.
//
// Z.ai publishes GLM (General Language Model) behind an OpenAI-compatible
// API — same /chat/completions wire shape, same SSE streaming, same
// tools/tool_choice function-calling schema. The only deltas from a vanilla
// OpenAI client are the base URL (https://api.z.ai/api/paas/v4, note /v4 not
// /v1), Bearer auth on a `xxxxx.yyyyy`-shaped key, and bare model ids
// (`glm-5.2`, not `vendor/model`). That makes this a thin adapter: it reuses
// to-openai.js / from-openai.js for the format, exactly like openrouter.js.
//
// Same DI contract as the other cloud adapters: `safeFetch` + `getSecret`
// are injected; this module never imports peerd-egress.
//
// Thinking mode (GLM-4.6/4.5/4.5-Air, and 5.2): Z.ai surfaces reasoning as a
// `delta.reasoning_content` SSE field gated by `extra_body.thinking.type`. The
// shared from-openai.js parser doesn't surface that field yet, so for now this
// adapter mirrors openrouter.js — it accepts the `reasoning` arg and ignores
// it (doesn't enable thinking mode). GLM-5.2 still tool-calls and streams
// content fine without it; surfacing reasoning_content is future work that
// belongs in the shared parser, not this adapter.

import { toOpenAiBody } from '../format/to-openai.js';
import { fromOpenAiStream } from '../format/from-openai.js';
import { abortableSleep, fetchInitialResponseWithRetry } from '../connect-timeout.js';
import {
  ProviderError,
  ProviderHttpError,
  ProviderKeyMissingError,
  ProviderUsageLimitError,
} from '../errors.js';
import { isUsageLimitResponse, apiErrorMessage } from '../error-classify.js';

// The standard Z.ai platform endpoint. A separate `coding/paas/v4` path exists
// for GLM Coding Plan subscribers; this is the general one every normal API
// key (`xxxxx.yyyyy`) authenticates against.
const ENDPOINT = 'https://api.z.ai/api/paas/v4/chat/completions';
const VAULT_SECRET_NAME = 'glm_api_key';
// Connect timeout for the response headers; the SSE body streams untimed.
const CONNECT_TIMEOUT_MS = 45_000;

// Default model id. GLM-5.2 is Z.ai's flagship long-horizon coding/agentic
// model (1M lossless context, strong tool-calling) — the profile a browser
// agent harness wants as its default. The user picks their own in Settings.
export const DEFAULT_MODEL = 'glm-5.2';

// why: the web actor default — GLM-4.5-Air is Z.ai's lightweight fast variant,
// the cheap high-frequency page-driver. Same intent as OpenRouter's
// DEFAULT_RUNNER_MODEL (Haiku). If the user's account can't reach it, the
// actor falls back to the inherited chat model.
export const DEFAULT_RUNNER_MODEL = 'glm-4.5-air';

const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60_000;

/**
 * @typedef {import('../types.js').InternalMessage} InternalMessage
 * @typedef {import('../format/from-anthropic.js').ProviderEvent} ProviderEvent
 */

/**
 * Call Z.ai GLM /chat/completions and stream events back. Mirrors the
 * OpenRouter adapter's signature; `reasoning` is accepted but ignored
 * (thinking mode is not wired here — see the file header).
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
export async function* callGlm(args) {
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
  if (!apiKey) throw new ProviderKeyMissingError('glm');

  const body = toOpenAiBody({ model, system, messages, tools, maxTokens });
  const requestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  };

  // why two retry layers: connection-drop retry (TypeError rejections, up to
  // 3 total attempts) rides inside this HTTP loop — orthogonal failure modes;
  // a network drop never produces a Response for the status logic below.
  // Mirrors openrouter.js / anthropic.js.
  for (let attempt = 1; ; attempt++) {
    const res = await fetchInitialResponseWithRetry(safeFetch, ENDPOINT, requestInit, {
      stopSignal: signal,
      timeoutMs: CONNECT_TIMEOUT_MS,
      onTimeout: (ms) => new ProviderError('glm', `the API did not respond within ${ms / 1000}s — it may be unreachable or down. Try again.`),
      sleepFn: _sleep,
    });
    if (res.ok) {
      if (!res.body) {
        throw new ProviderError('glm', 'response has no body (streaming requires it)');
      }
      yield* fromOpenAiStream(res.body, { provider: 'glm' });
      return;
    }
    // Non-2xx: read the body ONCE (drains the socket for reuse), then classify
    // before deciding to retry. why: Z.ai returns a hard limit (out of credit /
    // over a usage cap) as a billable status/body that must fail fast, while a
    // transient 429 throttle is worth retrying. Same shape as openrouter.js.
    let bodyText = '';
    try { bodyText = await res.text(); }
    catch { bodyText = ''; }
    if (isUsageLimitResponse(res.status, bodyText)) {
      throw new ProviderUsageLimitError('glm', {
        status: res.status,
        detail: apiErrorMessage(bodyText),
      });
    }
    // why include 500: a transient upstream/server blip commonly surfaces as a
    // one-off 500; an immediate retry almost always succeeds. The hard-limit
    // fast-fail above already caught a 500 carrying a billing needle. Mirrors
    // openrouter.js / anthropic.js.
    const retryable = res.status === 429 || res.status === 500
      || res.status === 503 || res.status === 529;
    if (retryable && attempt <= MAX_RATE_LIMIT_RETRIES) {
      const waitMs = computeBackoffMs(res.headers, attempt);
      yield { type: 'rate-limit-pause', retryAfterMs: waitMs, attempt };
      await _sleep(waitMs, signal);
      continue;
    }
    throw new ProviderHttpError('glm', res.status, bodyText.slice(0, 1024) || '<no body>');
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
 * Adapter descriptor — the shape the provider registry stores.
 */
export const glmAdapter = Object.freeze({
  name: 'glm',
  label: 'Z.ai',
  endpoint: ENDPOINT,
  defaultModel: DEFAULT_MODEL,
  defaultRunnerModel: DEFAULT_RUNNER_MODEL,
  vaultSecretName: VAULT_SECRET_NAME,
  call: callGlm,
});
