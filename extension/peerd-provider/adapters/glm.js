// @ts-check
// Z.ai GLM adapter — OpenAI-compatible /chat/completions with bare GLM model ids.

import { callOpenAiCompatible, computeBackoffMs } from './openai-compat.js';

export const DEFAULT_MODEL = 'glm-5.2';
export const DEFAULT_RUNNER_MODEL = 'glm-4.5-air';

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
export const callGlm = (args) => callOpenAiCompatible({
  providerId: 'glm',
  defaultModel: DEFAULT_MODEL,
}, args);

export const _computeBackoffMsForTests = computeBackoffMs;

export const glmAdapter = Object.freeze({
  name: 'glm',
  label: 'Z.ai',
  defaultModel: DEFAULT_MODEL,
  defaultRunnerModel: DEFAULT_RUNNER_MODEL,
  call: callGlm,
});
