// @ts-check
// Cold provider/composer truth. Route implementations may be demand-owned,
// but state/get must still describe the selected provider without starting a
// feature host or probing the network.

import {
  PROVIDER_AUTHORITY,
  providerAuthority,
} from '../shared/provider-authority-policy.js';

/**
 * @param {Object} deps
 * @param {{get:()=>Record<string,any>}} deps.settingsStore
 * @param {{getSecret:(name:string)=>Promise<string|null>}} deps.vault
 * @param {any} deps.browser
 * @param {boolean} [deps.localModels]
 * @param {()=>Promise<any>|any} [deps.pushState]
 */
export const createKernelProviderProjection = ({
  settingsStore,
  vault,
  browser,
  localModels = true,
  pushState = () => {},
}) => {
  /** @type {{known:boolean,reachable:boolean,count:number|null,models:string[]|null,host:string}|null} */
  let ollamaStatus = null;
  let ollamaStatusKey = '';
  let configRevision = 0;

  const observeOllamaStatus = (/** @type {any} */ status) => {
    const next = { ...status, host: String(settingsStore.get().ollamaHost ?? '') };
    const key = JSON.stringify(next);
    if (key === ollamaStatusKey) return;
    ollamaStatusKey = key;
    ollamaStatus = next;
    configRevision += 1;
    void Promise.resolve(pushState()).catch(() => {});
  };
  const bumpRevision = () => { configRevision += 1; };

  const view = async (/** @type {any} */ session = null,
    /** @type {boolean} */ locked = false) => {
    const settings = settingsStore.get();
    const defaults = providerAuthority(settings.providerName) ?? providerAuthority('anthropic')
      ?? PROVIDER_AUTHORITY[0];
    const defaultModel = typeof settings.providerModel === 'string' && settings.providerModel.trim()
      ? settings.providerModel.trim() : defaults.defaultModel;
    const selected = providerAuthority(session?.provider ?? defaults.name);
    const composerModel = typeof session?.model === 'string' && session.model.trim()
      ? session.model : selected?.name === defaults.name ? defaultModel : selected?.defaultModel ?? '';
    const credential = async (/** @type {any} */ policy) => {
      if (locked || !policy) return false;
      if (policy.secretName === null) return true;
      try { return !!(await vault.getSecret(policy.secretName)); } catch { return false; }
    };
    const defaultCredential = await credential(defaults);
    const composerCredential = selected?.name === defaults.name
      ? defaultCredential : await credential(selected);
    let localReady = selected?.name !== 'local-webgpu';
    if (!localReady && localModels) {
      try {
        const raw = (await browser.storage.local.get('localModelDownloaded'))?.localModelDownloaded;
        localReady = raw === true || Array.isArray(raw) && raw.includes(composerModel);
      } catch { localReady = false; }
    }
    const liveOllama = ollamaStatus?.host === String(settings.ollamaHost ?? '') ? ollamaStatus : null;
    const ollamaNoModels = selected?.name === 'ollama'
      && liveOllama?.known && liveOllama.reachable && liveOllama.count === 0;
    const ollamaModelMissing = selected?.name === 'ollama'
      && liveOllama?.known && liveOllama.reachable
      && Array.isArray(liveOllama.models) && liveOllama.models.length > 0
      && !liveOllama.models.includes(composerModel)
      && !(!composerModel.split('/').at(-1)?.includes(':')
        && liveOllama.models.includes(`${composerModel}:latest`));
    const ollamaReady = selected?.name !== 'ollama' || (!ollamaNoModels && !ollamaModelMissing);
    const reason = locked ? 'vault-locked' : !selected ? 'unknown-provider'
      : !composerCredential ? 'missing-key'
        : !localReady ? 'local-model-not-installed'
          : ollamaNoModels ? 'ollama-no-models'
            : ollamaModelMissing ? 'ollama-model-missing' : null;
    return {
      providers: {
        current: defaults.name, hasKey: defaultCredential, model: defaultModel,
        defaultRunnerModel: defaults.defaultRunnerModel, configRevision,
      },
      composer: {
        provider: selected?.name ?? String(session?.provider ?? ''), model: composerModel,
        keyless: selected?.secretName === null, credentialReady: composerCredential,
        localReady, ollamaReady, canSend: reason === null, reason,
        warning: reason === null && selected?.name === 'ollama'
          && liveOllama?.known && liveOllama.reachable === false
          ? 'ollama-unreachable' : null,
      },
    };
  };

  return Object.freeze({ view, observeOllamaStatus, bumpRevision });
};
