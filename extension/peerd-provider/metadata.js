// @ts-check
// Controller-owned provider/model metadata. This module contains no endpoint,
// credential, authentication-header, or transport policy data.

import { OPENROUTER_POPULAR, normalizeOpenRouterModels } from './semantic-metadata.js';

export const PROVIDER_METADATA = Object.freeze([
  Object.freeze({ name: 'anthropic', label: 'Anthropic',
    defaultModel: 'claude-sonnet-4-6', defaultRunnerModel: 'claude-haiku-4-5',
    keyless: false, liveModels: false }),
  Object.freeze({ name: 'openrouter', label: 'OpenRouter',
    defaultModel: 'z-ai/glm-5.1', defaultRunnerModel: 'anthropic/claude-haiku-4.5',
    keyless: false, liveModels: false }),
  Object.freeze({ name: 'openai', label: 'OpenAI',
    defaultModel: 'gpt-5.1', defaultRunnerModel: 'gpt-5.1-mini',
    keyless: false, liveModels: false }),
  Object.freeze({ name: 'glm', label: 'Z.ai',
    defaultModel: 'glm-5.2', defaultRunnerModel: 'glm-4.5-air',
    keyless: false, liveModels: false }),
  Object.freeze({ name: 'ollama', label: 'Ollama',
    defaultModel: 'qwen3:8b', defaultRunnerModel: 'qwen3:8b',
    keyless: true, liveModels: true }),
  Object.freeze({ name: 'local-webgpu', label: 'Local (WebGPU)',
    defaultModel: 'gemma-4-e2b', defaultRunnerModel: 'gemma-4-e2b',
    keyless: true, liveModels: false }),
]);

export const PROVIDER_MODEL_CATALOG = Object.freeze({
  anthropic: Object.freeze([
    Object.freeze({ model: 'claude-opus-4-8', label: 'Claude Opus 4.8' }),
    Object.freeze({ model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }),
    Object.freeze({ model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' }),
  ]),
  openrouter: Object.freeze([
    Object.freeze({ model: 'z-ai/glm-5.1', label: 'GLM-5.1 (open · tool-calling)' }),
    Object.freeze({ model: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6 (open)' }),
    Object.freeze({ model: 'minimax/minimax-m2', label: 'MiniMax M2 (open · cheap)' }),
    Object.freeze({ model: 'openai/gpt-4o', label: 'GPT-4o' }),
  ]),
  openai: Object.freeze([
    Object.freeze({ model: 'gpt-5.1', label: 'GPT-5.1' }),
    Object.freeze({ model: 'gpt-5.1-mini', label: 'GPT-5.1 mini (cheap)' }),
    Object.freeze({ model: 'gpt-5', label: 'GPT-5' }),
    Object.freeze({ model: 'o4-mini', label: 'o4-mini (reasoning)' }),
  ]),
  glm: Object.freeze([
    Object.freeze({ model: 'glm-5.2', label: 'GLM-5.2 (1M · agentic)' }),
    Object.freeze({ model: 'glm-4.6', label: 'GLM-4.6' }),
    Object.freeze({ model: 'glm-4.5-air', label: 'GLM-4.5 Air (fast · cheap)' }),
  ]),
});

export const LOCAL_MODEL_LABELS = Object.freeze({
  'gemma-4-e2b': 'Gemma 4 E2B',
  'muse-glimmer-30b': 'Muse Glimmer 30B',
});

export const listProviderMetadata = () => PROVIDER_METADATA.map((provider) => ({ ...provider }));

/** @param {unknown} name */
export const providerMetadata = (name) => typeof name === 'string'
  ? PROVIDER_METADATA.find((provider) => provider.name === name) ?? null : null;

export { OPENROUTER_POPULAR, normalizeOpenRouterModels };
