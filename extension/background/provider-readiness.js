// @ts-check
// Provider readiness for the current composer. The Settings projection answers
// "what should a new chat use?"; this answers "what does the chat in view need?"
// so changing a future default cannot disable (or falsely enable) an existing
// session bound to a different provider.

/**
 * @param {object} deps
 * @param {string} deps.provider
 * @param {string} deps.model
 * @param {Array<{ name: string, keyless?: boolean, vaultSecretName?: string|null }>} deps.providers
 * @param {(name: string) => Promise<string | null>} deps.getSecret
 * @param {boolean} deps.localModelAvailable
 * @param {{ known?: boolean, reachable?: boolean|null, count?: number|null, models?: string[]|null }} [deps.ollamaModels]
 * @param {boolean} [deps.settingsAvailable]
 */
export const resolveComposerReadiness = async ({
  provider, model, providers, getSecret, localModelAvailable, ollamaModels,
  settingsAvailable = true,
}) => {
  const descriptor = providers.find((candidate) => candidate.name === provider);
  const keyless = !!descriptor?.keyless;
  let credentialReady = keyless;
  if (descriptor && !keyless && descriptor.vaultSecretName) {
    try { credentialReady = !!(await getSecret(descriptor.vaultSecretName)); }
    catch { credentialReady = false; }
  }
  const localReady = provider !== 'local-webgpu' || localModelAvailable;
  const ollamaNoModels = provider === 'ollama'
    && ollamaModels?.known && ollamaModels.reachable && ollamaModels.count === 0;
  const ollamaModelMissing = provider === 'ollama'
    && ollamaModels?.known && ollamaModels.reachable
    && Array.isArray(ollamaModels.models) && ollamaModels.models.length > 0
    && !ollamaModels.models.includes(model)
    && !(!model.split('/').at(-1)?.includes(':') && ollamaModels.models.includes(`${model}:latest`));
  const ollamaWarning = provider === 'ollama'
    && ollamaModels?.known && ollamaModels.reachable === false
      ? 'ollama-unreachable'
      : null;
  const ollamaReady = provider !== 'ollama' || (!ollamaNoModels && !ollamaModelMissing);
  const reason = !settingsAvailable ? 'settings-unavailable'
    : !descriptor ? 'unknown-provider'
      : !credentialReady ? 'missing-key'
        : !localReady ? 'local-model-not-installed'
          : ollamaNoModels ? 'ollama-no-models'
            : ollamaModelMissing ? 'ollama-model-missing'
          : null;
  return Object.freeze({
    provider,
    model,
    keyless,
    credentialReady,
    localReady,
    ollamaReady,
    canSend: reason === null,
    reason,
    warning: reason === null ? ollamaWarning : null,
  });
};
