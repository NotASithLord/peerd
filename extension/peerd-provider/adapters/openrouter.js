// @ts-check
// OpenRouter adapter — OpenAI-compatible gateway + live model catalog/windows.

import { readModelWindow } from '../model-window.js';
import { ProviderHttpError } from '../errors.js';
import { normalizeOpenRouterModels } from '../semantic-metadata.js';
import { callOpenAiCompatible, computeBackoffMs } from './openai-compat.js';
export { OPENROUTER_POPULAR } from '../semantic-metadata.js';

export const DEFAULT_MODEL = 'z-ai/glm-5.1';
export const DEFAULT_RUNNER_MODEL = 'anthropic/claude-haiku-4.5';

/**
 * @typedef {import('../types.js').InternalMessage} InternalMessage
 * @typedef {import('../format/from-anthropic.js').ProviderEvent} ProviderEvent
 * @typedef {import('../model-egress.js').ModelEgress} ModelEgress
 */

/**
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
export const callOpenRouter = (args) => callOpenAiCompatible({
  providerId: 'openrouter',
  defaultModel: DEFAULT_MODEL,
  tagStreamProvider: false,
}, args);

export const _computeBackoffMsForTests = computeBackoffMs;

/**
 * Live model inventory from GET /api/v1/models for the Settings curation picker.
 * @param {Object} deps
 * @param {ModelEgress} deps.modelEgress
 * @param {AbortSignal} [deps.signal]
 * @returns {Promise<Array<{ model: string, label: string, contextLength: number,
 *   promptPrice: number, completionPrice: number }>>}
 */
export const listOpenRouterModels = async ({ modelEgress, signal } = /** @type {any} */ ({})) => {
  const res = await modelEgress.readModelInventory({ providerId: 'openrouter', signal });
  if (!res.ok) {
    let excerpt = '';
    try { excerpt = (await res.text()).slice(0, 1024); }
    catch { excerpt = '<no body>'; }
    throw new ProviderHttpError('openrouter', res.status, excerpt);
  }
  return normalizeOpenRouterModels(await res.json());
};

/**
 * Fetch the live context window for a model from OpenRouter's models endpoint.
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
      // why the SMALLER: top-level context_length is nominal; top_provider is
      // what the routed provider actually serves.
      const candidates = [entry.context_length, entry.top_provider?.context_length]
        .filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
      return candidates.length ? Math.min(...candidates) : null;
    },
    signal,
  });
};

export const openrouterAdapter = Object.freeze({
  name: 'openrouter',
  label: 'OpenRouter',
  defaultModel: DEFAULT_MODEL,
  defaultRunnerModel: DEFAULT_RUNNER_MODEL,
  call: callOpenRouter,
  contextWindow: fetchOpenRouterContextWindow,
});
