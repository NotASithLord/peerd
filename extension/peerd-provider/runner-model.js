// @ts-check
// runner-model — resolve which model the WEB ACTOR runs on.
//
// The web actor is the disposable page-driving agent the orchestrator reaches
// via message_actor: a narrow, high-frequency, latency-sensitive, security-
// contained job. It gets its OWN model, distinct from the main chat model, so
// page reads ride a fast cheap model (Haiku by default) while the chat keeps
// the stronger one.
//
// Pure (no IO) → Bun-testable. The SW calls this in mintWebSession and pins the
// result as the web actor session's model. An empty string means "inherit the
// owner chat model" (the last-resort fallback).
//
// Resolution order (first match wins):
//   1. Explicit user pin (Settings → Web actor model), if set.
//   2. Local WebGPU runner, when downloaded + available — on-device, keyless,
//      provider-independent. This is the rung the local Gemma runner plugs
//      into: once the model is resident it becomes the default for every
//      provider. (Absent until the local-webgpu adapter ships.)
//   3. The active provider's defaultRunnerModel (e.g. Haiku on Anthropic).
//   4. Inherit the owner chat model ('').

/**
 * @typedef {Object} RunnerModelInputs
 * @property {{ runnerModel?: string }} [settings]   user settings; runnerModel '' = no pin
 * @property {{ defaultRunnerModel?: string, defaultModel?: string }} [provider]
 *   the active provider descriptor (from listProviders()).
 * @property {{ available?: boolean, model?: string } | null} [localRunner]
 *   the on-device WebGPU runner, when one is downloaded and ready. `available`
 *   gates it; `model` is the resident model id the local adapter answers to.
 */

/**
 * Resolve the web actor model id.
 *
 * @param {RunnerModelInputs} inputs
 * @returns {string} a model id, or '' to inherit the owner chat model.
 */
export const resolveRunnerModel = ({ settings, provider, localRunner } = {}) => {
  // 1. Explicit user pin always wins — power users override deliberately.
  const pinned = typeof settings?.runnerModel === 'string' ? settings.runnerModel.trim() : '';
  if (pinned) return pinned;

  // 2. Local WebGPU runner, once downloaded + available. Provider-independent
  //    (keyless, on-device), so it works whatever the main provider is.
  if (localRunner?.available && typeof localRunner.model === 'string' && localRunner.model) {
    return localRunner.model;
  }

  // 3. The active provider's fast default (e.g. claude-haiku-4-5).
  const providerDefault = provider?.defaultRunnerModel || provider?.defaultModel || '';
  if (providerDefault) return providerDefault;

  // 4. Inherit the main session model.
  return '';
};
