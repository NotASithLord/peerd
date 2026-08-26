// @ts-check
// Cold provider authority projection. This module owns only credential and
// local-residency facts; labels, defaults, model catalogs and composer
// semantics are projected by the sealed controller.

import { PROVIDER_EGRESS_MANIFEST } from './provider-egress-manifest.js';

/**
 * @param {Object} deps
 * @param {{get:()=>Record<string,any>}} deps.settingsStore
 * @param {{getSecret:(name:string)=>Promise<string|null>}} deps.vault
 * @param {any} deps.browser
 * @param {(snapshot:Record<string,any>)=>Promise<any>} deps.projectSemantic
 * @param {boolean} [deps.localModels]
 * @param {()=>Promise<any>|any} [deps.pushState]
 */
export const createKernelProviderProjection = ({
  settingsStore,
  vault,
  browser,
  projectSemantic,
  localModels = true,
  pushState = () => {},
}) => {
  if (typeof projectSemantic !== 'function') {
    throw new TypeError('kernel-provider-semantic-projection-required');
  }
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

  const authoritySnapshot = async (/** @type {any} */ session = null,
    /** @type {boolean} */ locked = false) => {
    const settings = settingsStore.get();
    const usable = [];
    if (!locked) {
      for (const [provider, policy] of Object.entries(PROVIDER_EGRESS_MANIFEST)) {
        if (policy.credential === null) usable.push(provider);
        else {
          try { if (await vault.getSecret(policy.credential)) usable.push(provider); }
          catch { /* locked or unavailable */ }
        }
      }
    }
    let downloaded = [];
    if (!locked && localModels) {
      try {
        const raw = (await browser.storage.local.get('localModelDownloaded'))?.localModelDownloaded;
        downloaded = raw === true ? ['gemma-4-e2b'] : Array.isArray(raw)
          ? raw.slice(0, 64).filter((id) => typeof id === 'string' && id.length <= 128)
          : [];
      } catch { downloaded = []; }
    }
    const liveOllama = ollamaStatus?.host === String(settings.ollamaHost ?? '')
      ? { known: ollamaStatus.known, reachable: ollamaStatus.reachable,
        count: ollamaStatus.count, models: ollamaStatus.models }
      : null;
    return Object.freeze({
      settings: Object.freeze({
        providerName: String(settings.providerName ?? ''),
        providerModel: String(settings.providerModel ?? ''),
        openrouterModels: Array.isArray(settings.openrouterModels)
          ? settings.openrouterModels.slice(0, 200) : [],
      }),
      session: session && typeof session === 'object' ? Object.freeze({
        provider: typeof session.provider === 'string' ? session.provider : null,
        model: typeof session.model === 'string' ? session.model : null,
      }) : null,
      usable: Object.freeze(usable),
      downloaded: Object.freeze(downloaded),
      localModels,
      locked,
      ollamaStatus: liveOllama,
      configRevision,
    });
  };

  const view = async (/** @type {any} */ session = null,
    /** @type {boolean} */ locked = false) => projectSemantic(
    await authoritySnapshot(session, locked),
  );

  return Object.freeze({
    view, authoritySnapshot, observeOllamaStatus, bumpRevision,
  });
};
