// @ts-check
// Shared streaming/retry core for OpenAI-compatible chat-completions adapters
// (OpenAI, OpenRouter, Z.ai GLM). Keeps one audited backoff and error-
// classification path across all three cloud adapters.

import { toOpenAiBody } from '../format/to-openai.js';
import { fromOpenAiStream } from '../format/from-openai.js';
import { abortableSleep, openInitialResponseWithRetry } from '../connect-timeout.js';
import {
  ProviderError,
  ProviderHttpError,
  ProviderUsageLimitError,
} from '../errors.js';
import { isUsageLimitResponse, apiErrorMessage } from '../error-classify.js';

const CONNECT_TIMEOUT_MS = 45_000;
const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60_000;

/**
 * @typedef {import('../types.js').InternalMessage} InternalMessage
 * @typedef {import('../format/from-anthropic.js').ProviderEvent} ProviderEvent
 * @typedef {import('../model-egress.js').ModelEgress} ModelEgress
 */

/**
 * @param {Headers} headers
 * @param {number} attempt   1-indexed
 * @returns {number}         milliseconds to wait, clamped to MAX_BACKOFF_MS
 */
export const computeBackoffMs = (headers, attempt) => {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000 + 250, MAX_BACKOFF_MS);
    }
  }
  return Math.min(DEFAULT_BACKOFF_MS * (2 ** (attempt - 1)), MAX_BACKOFF_MS);
};

/**
 * @param {Object} config
 * @param {string} config.providerId
 * @param {string} config.defaultModel
 * @param {(body: Record<string, unknown>) => Record<string, unknown>} [config.transformBody]
 * @param {boolean} [config.tagStreamProvider]
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
export async function* callOpenAiCompatible(config, args) {
  const { providerId, defaultModel, transformBody, tagStreamProvider = true } = config;
  const {
    messages, system,
    model = defaultModel,
    maxTokens,
    tools,
    modelEgress,
    signal,
    _sleep = abortableSleep,
  } = args;

  const formatted = /** @type {Record<string, unknown>} */ (
    toOpenAiBody({ model, system, messages, tools, maxTokens }));
  const body = transformBody ? transformBody(formatted) : formatted;

  // why two retry layers: connection-drop retry (TypeError rejections, up to
  // 3 total attempts) rides inside this HTTP loop — orthogonal failure modes;
  // a network drop never produces a Response for the status logic below.
  for (let attempt = 1; ; attempt++) {
    const res = await openInitialResponseWithRetry(
      (requestSignal) => modelEgress.openInference({
        providerId,
        modelId: model,
        nativeBody: body,
        signal: requestSignal,
      }), {
        stopSignal: signal,
        timeoutMs: CONNECT_TIMEOUT_MS,
        onTimeout: (ms) => new ProviderError(providerId, `the API did not respond within ${ms / 1000}s — it may be unreachable or down. Try again.`),
        sleepFn: _sleep,
      },
    );
    if (res.ok) {
      if (!res.body) {
        throw new ProviderError(providerId, 'response has no body (streaming requires it)');
      }
      yield* tagStreamProvider
        ? fromOpenAiStream(res.body, { provider: providerId })
        : fromOpenAiStream(res.body);
      return;
    }
    let bodyText = '';
    try { bodyText = await res.text(); }
    catch { bodyText = ''; }
    if (isUsageLimitResponse(res.status, bodyText)) {
      throw new ProviderUsageLimitError(providerId, {
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
    throw new ProviderHttpError(providerId, res.status, bodyText.slice(0, 1024) || '<no body>');
  }
}
