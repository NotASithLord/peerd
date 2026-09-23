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

/**
 * Pick the provider a chat should bind to when the user has NOT chosen one -
 * `providerName` is empty (the shipped default) or names an unregistered
 * adapter. Returns the first usable provider's name in registry order, or null
 * when nothing is usable.
 *
 * Keyless usability is REAL readiness, not mere presence: a live daemon
 * (Ollama) must answer, and the on-device model must be downloaded.
 *
 * @param {object} deps
 * @param {Array<{ name: string, keyless?: boolean, liveModels?: boolean, vaultSecretName?: string|null }>} deps.providers
 * @param {(name: string) => Promise<string | null>} deps.getSecret
 * @param {boolean} deps.localModelAvailable
 * @param {(name: string) => (number | null) | Promise<number | null>} deps.liveModelCount
 * @returns {Promise<string | null>}
 */
export const pickUsableProvider = async ({
  providers, getSecret, localModelAvailable, liveModelCount,
}) => {
  for (const candidate of providers) {
    if (candidate.keyless) {
      if (candidate.liveModels) {
        const count = await liveModelCount(candidate.name);
        if (typeof count === 'number' && count > 0) return candidate.name;
      } else if (candidate.name === 'local-webgpu') {
        if (localModelAvailable) return candidate.name;
      } else return candidate.name;
    } else if (candidate.vaultSecretName) {
      try {
        if (await getSecret(candidate.vaultSecretName)) return candidate.name;
      } catch { /* an unreadable vault entry is not a usable provider */ }
    }
  }
  return null;
};

/**
 * Which provider the SETTINGS/new-chat projection should show. Returns '' when
 * the user's own selection stands - the caller then reads settings as usual,
 * keeping any providerModel they chose - or a name to project instead.
 *
 * why this exists (issue #384): the projection used to fall back to Anthropic
 * whenever providerName was empty, without checking readiness. An Ollama-only
 * install therefore had its composer gated on an unkeyed Anthropic, and the
 * only code that would have re-picked runs at send time - which that same gate
 * blocks. Readiness needed a provider, the provider needed a send, the send
 * needed readiness. Reloading never helped: the empty setting is durable, not
 * a race. Rendering must not write, so this resolves without persisting; the
 * binder still records the choice on the first turn, from the same ordering
 * rule via pickUsableProvider.
 *
 * @param {object} deps
 * @param {Array<{ name: string, keyless?: boolean, liveModels?: boolean, vaultSecretName?: string|null }>} deps.providers
 * @param {string} deps.chosenName
 * @param {(name: string) => Promise<string | null>} deps.getSecret
 * @param {() => boolean} deps.localAvailable
 * @param {(name: string) => (number | null) | Promise<number | null>} deps.liveModelCount
 * @param {() => Promise<unknown>} [deps.hydrateLocal]
 * @returns {Promise<string>}
 */
export const resolveDisplayProvider = async ({
  providers, chosenName, getSecret, localAvailable, liveModelCount, hydrateLocal,
}) => {
  if (chosenName && providers.some((candidate) => candidate.name === chosenName)) return '';
  // Only on the unchosen path, warm the keyless readiness signals so the pick
  // sees what the binder would. Both callers cache their result - failures
  // included - so this is bounded, not a probe on every state push.
  if (hydrateLocal && providers.some((candidate) => candidate.name === 'local-webgpu')) {
    await hydrateLocal().catch(() => false);
  }
  const picked = await pickUsableProvider({
    providers, getSecret, localModelAvailable: localAvailable(), liveModelCount,
  });
  return picked ?? '';
};
