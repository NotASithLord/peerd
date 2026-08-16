// @ts-check
// Background-only provider surface. UI-only capability probes, recommendation
// helpers, and key-format controls stay out of the MV3 worker's cold graph.

export {
  callModel, listProviders, listProviderModels, providerModelContextWindow,
} from './registry.js';
export { resolveRunnerTarget } from './runner-model.js';
export {
  ProviderHttpError, ProviderKeyMissingError, ProviderUsageLimitError,
  UnknownProviderError,
} from './errors.js';
export { shouldFailover, planFailoverChain } from './failover.js';
export { anthropicAdapter } from './adapters/anthropic.js';
export { listOpenRouterModels, OPENROUTER_POPULAR } from './adapters/openrouter.js';
export {
  LOCAL_MODEL_ID, setLocalGenerate, setLocalModelInfo,
} from './adapters/local-webgpu.js';
export { localModelSpec } from './local-model-capability.js';
export { costOf, hasPricing } from './pricing.js';
export { contextWindowFor } from './context-window.js';
