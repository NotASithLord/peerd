// @ts-check
// OpenAI adapter — direct BYOK access to api.openai.com via /chat/completions.

import { callOpenAiCompatible, computeBackoffMs } from './openai-compat.js';

export const DEFAULT_MODEL = 'gpt-5.1';
export const DEFAULT_RUNNER_MODEL = 'gpt-5.1-mini';

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
export const callOpenAi = (args) => callOpenAiCompatible({
  providerId: 'openai',
  defaultModel: DEFAULT_MODEL,
  // why: direct OpenAI refuses `max_tokens` for gpt-5.x and o-series models
  // (400 "Use 'max_completion_tokens' instead"); other OpenAI-compat providers
  // still expect `max_tokens`, so the rename stays scoped to this adapter.
  transformBody: ({ max_tokens: outputLimit, ...formatted }) => ({
    ...formatted, max_completion_tokens: outputLimit,
  }),
}, args);

export const _computeBackoffMsForTests = computeBackoffMs;

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

export const openaiAdapter = Object.freeze({
  name: 'openai',
  label: 'OpenAI',
  defaultModel: DEFAULT_MODEL,
  defaultRunnerModel: DEFAULT_RUNNER_MODEL,
  call: callOpenAi,
});
