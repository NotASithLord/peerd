// @ts-check
// runner-model — resolve which model the page-reader runner (do/get/check)
// runs on.
//
// The browser-runner is the disposable subagent behind `do`/`get`/`check`:
// a narrow, high-frequency, latency-sensitive, security-contained job. It
// gets its OWN model, distinct from the main chat model, so page reads ride
// a fast cheap model while the chat keeps the stronger one.
//
// Pure (no IO) → Bun-testable. The SW calls this once per tool-context build
// and hands the result to the runner via ctx.runnerModel; get.js / check.js
// pass it as the runner's model. An empty string means "inherit the main
// session model" (the last-resort fallback) — runRunner ALSO falls back to
// the inherited model at runtime if the resolved one blows its step budget.
//
// Resolution order (first match wins):
//   1. Explicit user pin (Settings → Page-reader model), if set.
//   2. Local WebGPU runner, when downloaded + available — on-device, keyless,
//      provider-independent. This is the rung the local Gemma runner plugs
//      into: once the model is resident it becomes the runner default for
//      every provider. (Absent until the local-webgpu adapter ships.)
//   3. The active provider's defaultRunnerModel (e.g. Haiku on Anthropic).
//   4. Inherit the main session model ('').

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
 * Resolve the runner (page-reader) model id.
 *
 * @param {RunnerModelInputs} inputs
 * @returns {string} a model id, or '' to inherit the main session model.
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
