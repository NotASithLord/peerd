// @ts-check
// peerd-provider — public surface.
//
// Exports the registry helpers (callModel, listProviders, getProvider,
// registerProvider) plus error classes and adapter metadata. The
// agent loop in peerd-runtime calls into this module via callModel
// and never imports adapter modules directly — that keeps runtime
// agnostic to which providers exist.
//
// Shipped: Anthropic + OpenRouter (cloud) and Ollama (local, keyless).
// Later: OpenAI adapter, local WebGPU inference.

export {
  callModel,
  listProviders,
  listProviderModels,
  providerModelContextWindow,
  getProvider,
  registerProvider,
  unregisterProvider,
} from './registry.js';

// Pure resolution of the page-reader runner model (do/get/check). The SW
// resolves it per tool-context build; once the local WebGPU runner ships it
// slots in as the on-device rung. See runner-model.js / FEATURE-LOCAL-WEBGPU.md.
export { resolveRunnerModel } from './runner-model.js';

export {
  ProviderError,
  ProviderHttpError,
  ProviderKeyMissingError,
  ProviderUsageLimitError,
  UnknownProviderError,
  OllamaNotRunningError,
} from './errors.js';

// Pure classification of provider error bodies (hard usage/credit limit vs
// transient throttle) — the adapters use it; exported so the chassis/tests can
// reason about a failure body too.
export { isUsageLimitResponse, apiErrorMessage } from './error-classify.js';

// Provider failover (switch-and-continue): shouldFailover classifies a
// failure as one a DIFFERENT provider could get past (exhausted overload /
// hard usage limit); planFailoverChain orders the candidate {provider,model}
// list. The SW wraps callModel with these. See failover.js.
export { shouldFailover, planFailoverChain } from './failover.js';

// Adapter metadata + default model are exposed so chassis UI (settings
// view in the side panel) can render "you are using Anthropic, model
// claude-sonnet-4-6". The live `call` reference stays inside the
// adapter; UI never calls it directly.
export { anthropicAdapter, DEFAULT_MODEL as ANTHROPIC_DEFAULT_MODEL } from './adapters/anthropic.js';
export {
  openrouterAdapter,
  DEFAULT_MODEL as OPENROUTER_DEFAULT_MODEL,
  // Live gateway catalog + the curated "popular" seed, for the Settings
  // model-curation picker. listOpenRouterModels doubles as the key-verify probe.
  listOpenRouterModels,
  OPENROUTER_POPULAR,
} from './adapters/openrouter.js';
export { ollamaAdapter, DEFAULT_MODEL as OLLAMA_DEFAULT_MODEL } from './adapters/ollama.js';
// local WebGPU runner (FEATURE-LOCAL-WEBGPU B). setLocalGenerate wires the
// offscreen engine bridge at SW boot; LOCAL_MODEL_ID is the actor model.
export {
  localWebgpuAdapter, LOCAL_MODEL_ID, setLocalGenerate,
  // future-proof seam: lets the offscreen engine report the actor model's
  // live context window through the unified provider context-window seam.
  setLocalModelInfo,
} from './adapters/local-webgpu.js';
// Hardware gate for local WebGPU models: the probe (document contexts only) +
// the pure capable/not judge + per-model min-specs. Powers the Settings "Test" button.
export { MODEL_SPECS, probeLocalModelCapability, judgeModelCapability } from './local-model-capability.js';

// "Which local model fits this machine?" — the probe (document contexts
// only; reads navigator.gpu) + the pure recommendation logic + the tier
// table, for the Settings Ollama card. See ollama-recommend.js.
export {
  OLLAMA_MODEL_TIERS,
  probeGpuCapability,
  estimateUsableMemGB,
  recommendOllamaModel,
} from './ollama-recommend.js';

// Local pricing table + cost math for the cost/usage meter (feature 06).
// Pure data + arithmetic — no network. The agent loop accumulates usage;
// the SW multiplies it by these rates (with user overrides) client-side.
export { DEFAULT_PRICING, costOf, resolvePricing, hasPricing } from './pricing.js';

// Per-model context-window table + resolver. The long-session trim layer
// scales its trigger to a fraction of the ACTIVE model's window (dynamic,
// not a fixed token count). Same static-snapshot + user-override + live-
// value posture as pricing.js — no network at module load.
export {
  DEFAULT_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  resolveContextWindow,
  contextWindowFor,
} from './context-window.js';
