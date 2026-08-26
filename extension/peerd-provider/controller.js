// @ts-check
// Sealed-controller provider surface.
//
// This entry point intentionally exports semantic execution and metadata only.
// Fixed destinations, credentials, authentication, quotas, and transport
// policy belong to the service worker's model-egress authority.

export {
  callModel,
  getProvider,
  listProviderModels,
  listProviders,
  providerModelContextWindow,
} from './registry.js';

export { planFailoverChain, providerFailureCode, shouldFailover } from './failover.js';

export {
  DEFAULT_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  contextWindowFor,
  resolveContextWindow,
} from './context-window.js';

export {
  DEFAULT_PRICING,
  costOf,
  hasPricing,
  resolvePricing,
} from './pricing.js';

export {
  ProviderError,
  ProviderHttpError,
  ProviderKeyMissingError,
  ProviderUsageLimitError,
  UnknownProviderError,
  OllamaNotRunningError,
} from './errors.js';

export {
  OPENROUTER_POPULAR,
  normalizeOpenRouterModels,
} from './semantic-metadata.js';

export {
  LOCAL_MODEL_LABELS,
  PROVIDER_METADATA,
  PROVIDER_MODEL_CATALOG,
  listProviderMetadata,
  providerMetadata,
} from './metadata.js';

export { listOpenRouterModels } from './adapters/openrouter.js';
export { LOCAL_MODEL_ID } from './adapters/local-webgpu.js';
