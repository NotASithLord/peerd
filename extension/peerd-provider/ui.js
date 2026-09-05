// @ts-check
// Cold-safe provider controls. Model adapters and provider HTTP code stay out
// of document UI graphs.

export { checkApiKeyFormat, KEY_PREFIX } from './key-format.js';
export {
  OLLAMA_MODEL_TIERS, probeGpuCapability, recommendOllamaModel,
} from './ollama-recommend.js';
export {
  listLocalModelSpecs, probeLocalModelCapability, judgeModelCapability,
} from './local-model-capability.js';
export { DEFAULT_PRICING } from './pricing.js';
export { listProviderMetadata } from './metadata.js';
