// @ts-check
// Cold provider authority projection. This module owns only credential and
// local-residency facts; labels, defaults, model catalogs and composer
// semantics are projected by the sealed controller.

import { PROVIDER_EGRESS_MANIFEST } from './provider-egress-manifest.js';

const MAX_SETTLED_VIEWS = 8;

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
  let authorityRevision = 0;
  let authorityLocked = true;
  /** @type {Map<string,Promise<any>>} */
  const inFlightViews = new Map();
  /** @type {Map<string,any>} */
  const settledViews = new Map();
  /** @type {Promise<void>} */
  let projectionTail = Promise.resolve();
  /** @type {{key:string,snapshot:Record<string,any>,revision:number}|null} */
  let desiredRefresh = null;
  /** @type {string|null} */
  let requestedKey = null;
  /** @type {Promise<void>|null} */
  let refreshDrain = null;

  const invalidate = () => {
    authorityRevision += 1;
    desiredRefresh = null;
    requestedKey = null;
    settledViews.clear();
  };

  const rememberSettled = (/** @type {string} */ key, /** @type {any} */ value) => {
    settledViews.delete(key);
    settledViews.set(key, value);
    while (settledViews.size > MAX_SETTLED_VIEWS) {
      settledViews.delete(/** @type {string} */ (settledViews.keys().next().value));
    }
    return value;
  };

  const readSettled = (/** @type {string} */ key) => {
    if (!settledViews.has(key)) return null;
    const value = settledViews.get(key);
    settledViews.delete(key);
    settledViews.set(key, value);
    return value;
  };

  const observeOllamaStatus = (/** @type {any} */ status) => {
    const next = { ...status, host: String(settingsStore.get().ollamaHost ?? '') };
    const key = JSON.stringify(next);
    if (key === ollamaStatusKey) return;
    ollamaStatusKey = key;
    ollamaStatus = next;
    configRevision += 1;
    invalidate();
    void Promise.resolve(pushState()).catch(() => {});
  };
  const bumpRevision = () => {
    configRevision += 1;
    invalidate();
  };
  const observeLocked = (/** @type {boolean} */ locked) => {
    const next = locked === true;
    if (next === authorityLocked) return;
    authorityLocked = next;
    invalidate();
  };

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

  const project = (/** @type {Record<string,any>} */ snapshot,
    /** @type {string} */ key, /** @type {number} */ revision) => {
    const settled = readSettled(key);
    if (settled) return Promise.resolve(settled);
    // why: lock -> unlock can recreate byte-identical facts while an older
    // controller request is still resolving. Its authority lifetime is not
    // interchangeable even though the semantic input is identical.
    const operationKey = `${revision}:${key}`;
    const active = inFlightViews.get(operationKey);
    if (active) return active;
    // why: vault, onboarding, Settings, and first-paint state pushes can race
    // during one unlock. They need the same pure semantic projection; sharing
    // it avoids filling the controller's bounded host lane with duplicate reads.
    const operation = projectionTail.catch(() => {}).then(() => projectSemantic(snapshot))
      .then((value) => {
        if (revision === authorityRevision && !authorityLocked && snapshot.locked === false) {
          rememberSettled(key, value);
        }
        return value;
      });
    projectionTail = operation.then(() => {}, () => {});
    inFlightViews.set(operationKey, operation);
    void operation.finally(() => {
      if (inFlightViews.get(operationKey) === operation) inFlightViews.delete(operationKey);
    }).catch(() => {});
    return operation;
  };

  const startRefresh = () => {
    if (refreshDrain) return;
    const operation = (async () => {
      while (desiredRefresh && !authorityLocked) {
        const target = desiredRefresh;
        try {
          await project(target.snapshot, target.key, target.revision);
        } catch {
          // why: a controller loss must not spin the cold state route. The
          // next independent state read retries the exact authority snapshot.
          if (desiredRefresh === target) desiredRefresh = null;
          return;
        }
        if (target.revision !== authorityRevision || authorityLocked
            || requestedKey !== target.key || desiredRefresh !== target) continue;
        desiredRefresh = null;
        if (!readSettled(target.key)) continue;
        await Promise.resolve(pushState()).catch(() => {});
        return;
      }
    })();
    refreshDrain = operation;
    void operation.finally(() => {
      if (refreshDrain !== operation) return;
      refreshDrain = null;
      if (desiredRefresh && !authorityLocked) startRefresh();
    }).catch(() => {});
  };

  const view = async (/** @type {any} */ session = null,
    /** @type {boolean} */ locked = false) => {
    const revision = authorityRevision;
    const snapshot = await authoritySnapshot(session, locked);
    return project(snapshot, JSON.stringify(snapshot), revision);
  };

  const peek = async (/** @type {any} */ session = null,
    /** @type {boolean} */ locked = false) => {
    // why: locked first paint is a complete cold-kernel answer. It must never
    // boot the semantic controller merely to restate that sending is denied.
    if (locked || authorityLocked) return null;
    const revision = authorityRevision;
    const snapshot = await authoritySnapshot(session, false);
    if (revision !== authorityRevision || authorityLocked) return null;
    const key = JSON.stringify(snapshot);
    requestedKey = key;
    const settled = readSettled(key);
    if (settled) {
      desiredRefresh = null;
      return settled;
    }
    // why: state reads never queue one semantic request per UI Port. There is
    // one desired exact snapshot and one bounded drain; a newer snapshot
    // supersedes an older queued refresh without accepting its result.
    desiredRefresh = { key, snapshot, revision };
    startRefresh();
    return null;
  };

  return Object.freeze({
    view, peek, authoritySnapshot, observeOllamaStatus, observeLocked, bumpRevision,
  });
};
