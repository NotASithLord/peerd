// @ts-check
// Compatibility + copy for the composer readiness projection. Older fixtures
// still provide only providers.hasKey; live snapshots include the provider-aware
// composer object.

/** @param {any} state */
export const composerForState = (state) => state?.composer ?? {
  provider: state?.session?.provider ?? state?.providers?.current ?? 'anthropic',
  model: state?.providers?.model ?? '',
  keyless: false,
  credentialReady: !!state?.providers?.hasKey,
  localReady: true,
  canSend: !!state?.providers?.hasKey,
  reason: state?.providers?.hasKey ? null : 'missing-key',
};

/** @param {string} name */
const providerLabel = (name) => (/** @type {Record<string, string>} */ ({
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  glm: 'Z.ai',
  ollama: 'Ollama',
  'local-webgpu': 'Local WebGPU',
}))[name] ?? 'the selected provider';

/** @param {any} composer @param {{ compact?: boolean }} [opts] */
export const composerUnavailableCopy = (composer, { compact = false } = {}) => {
  if (composer?.reason === 'settings-unavailable') {
    return compact
      ? 'Provider settings are temporarily unavailable.'
      : 'Provider settings could not be loaded. Reopen peerd to retry.';
  }
  if (composer?.reason === 'local-model-not-installed') {
    return compact
      ? 'Install the Local WebGPU model in Settings to send.'
      : 'Install the Local WebGPU model in Settings to start chatting.';
  }
  if (composer?.reason === 'ollama-no-models') {
    return compact
      ? 'Pull an Ollama model, then test the connection in Settings.'
      : 'Ollama is connected but has no models. Pull a model, then test again in Settings.';
  }
  if (composer?.reason === 'ollama-model-missing') {
    return compact
      ? 'The selected Ollama model is not installed. Choose a pulled model or pull it in Ollama.'
      : 'The selected Ollama model is not installed. Choose a pulled model above, or pull it in Ollama and test again.';
  }
  if (composer?.reason === 'unknown-provider') {
    return compact
      ? 'Choose a provider in Settings to send.'
      : 'Choose a provider in Settings to start chatting.';
  }
  const label = providerLabel(composer?.provider);
  return compact
    ? `Add an API key for ${label} in Settings to send.`
    : `Add an API key for ${label} in Settings to start chatting.`;
};

/** @param {any} composer */
export const composerWarningCopy = (composer) => composer?.warning === 'ollama-unreachable'
  ? 'Ollama could not be reached. You can still try Send after starting Ollama, or test the connection in Settings.'
  : null;
