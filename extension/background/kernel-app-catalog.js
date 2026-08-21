// @ts-check
// Native App metadata authority; bytes and repository work stay demand-owned.

import { parseAppManifest } from '/peerd-engine/app-manifest.js';

export const KERNEL_APP_CATALOG_KEY = 'apps.v1';

/** @param {unknown} cause @param {string} code @param {string} action */
const catalogEffectFailure = (cause, code, action) => {
  void cause;
  return {
    ok: false,
    error: `Peerd could not confirm whether ${action} finished. Refresh to reconcile before trying again.`,
    code,
    outcomeKnown: false,
    outcomeKind: 'unknown',
    retryable: false,
  };
};

/** @typedef {{schemaVersion:1,apps:Record<string,any>,sessionDefaults:Record<string,string>}} KernelAppCatalogState */

/** @param {unknown} row @returns {KernelAppCatalogState|null} */
export const parseKernelAppCatalogRow = (row) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const envelope = /** @type {{key?:unknown,value?:unknown}} */ (row);
  if (envelope.key !== KERNEL_APP_CATALOG_KEY || !envelope.value
      || typeof envelope.value !== 'object' || Array.isArray(envelope.value)) return null;
  const state = /** @type {Record<string,any>} */ (envelope.value);
  if (state.schemaVersion !== 1 || !state.apps
      || typeof state.apps !== 'object' || Array.isArray(state.apps)
      || (state.sessionDefaults !== undefined
        && (typeof state.sessionDefaults !== 'object'
          || state.sessionDefaults === null || Array.isArray(state.sessionDefaults)))) return null;
  if (state.sessionDefaults === undefined) return /** @type {KernelAppCatalogState} */ ({
    ...state, sessionDefaults: {},
  });
  return /** @type {KernelAppCatalogState} */ (state);
};

/** @param {unknown} row */
export const kernelAppCatalogRows = (row) => {
  const state = parseKernelAppCatalogRow(row);
  return state ? Object.values(state.apps) : [];
};

/** @param {unknown} row @param {string} sessionId */
export const kernelSessionAppId = (row, sessionId) => {
  const state = parseKernelAppCatalogRow(row);
  if (!state) return null;
  const appId = state.sessionDefaults[sessionId];
  return typeof appId === 'string' && Object.hasOwn(state.apps, appId) ? appId : null;
};

/** @param {any} deps */
export const createKernelAppCatalog = ({
  idb, now = Date.now,
  newId = () => `app-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
}) => {
  if (typeof idb?.get !== 'function' || typeof idb?.put !== 'function') {
    throw new TypeError('kernel-app-catalog-idb-invalid');
  }
  const read = () => idb.get('apps', KERNEL_APP_CATALOG_KEY);
  let mutationTail = Promise.resolve();
  /** @template T @param {()=>Promise<T>} operation */
  const mutate = (operation) => {
    const run = mutationTail.then(operation);
    mutationTail = run.then(() => {}, () => {});
    return run;
  };
  /** @param {string} appId @param {Record<string,unknown>} patch */
  const patchApp = (appId, patch) => mutate(async () => {
    const state = parseKernelAppCatalogRow(await read());
    const current = state?.apps[appId];
    if (!state || !current) return null;
    state.apps[appId] = { ...current, ...patch, updatedAt: now() };
    await idb.put('apps', { key: KERNEL_APP_CATALOG_KEY, value: state });
    return state.apps[appId];
  });
  return Object.freeze({
    list: async () => kernelAppCatalogRows(await read()),
    /** @param {string} appId */
    get: async (appId) => parseKernelAppCatalogRow(await read())?.apps[appId] ?? null,
    /** @param {string} sessionId */
    getDefaultForSession: async (sessionId) => kernelSessionAppId(await read(), sessionId),
    /** @param {{name?:unknown,ownerSessionId?:unknown}} input */
    createImported: (input = {}) => mutate(async () => {
      const state = parseKernelAppCatalogRow(await read()) ?? {
        schemaVersion: 1, apps: {}, sessionDefaults: {},
      };
      const id = newId();
      if (!/^app-[a-z0-9-]{1,92}$/.test(id) || state.apps[id]) {
        throw new Error('invalid or duplicate App id');
      }
      const createdAt = now();
      const record = {
        id,
        name: (typeof input.name === 'string' && input.name.trim()
          ? input.name.trim() : 'Git App').slice(0, 80),
        tags: [], entryFile: 'index.html', fileKinds: {},
        ownerSessionId: typeof input.ownerSessionId === 'string' ? input.ownerSessionId : null,
        createdAt, updatedAt: createdAt, favorite: false,
        source: 'imported', thumbnail: null,
      };
      state.apps[id] = record;
      await idb.put('apps', { key: KERNEL_APP_CATALOG_KEY, value: state });
      return record;
    }),
    /** @param {string} appId */
    remove: (appId) => mutate(async () => {
      const state = parseKernelAppCatalogRow(await read());
      if (!state?.apps[appId]) return false;
      delete state.apps[appId];
      for (const [sessionId, id] of Object.entries(state.sessionDefaults)) {
        if (id === appId) delete state.sessionDefaults[sessionId];
      }
      await idb.put('apps', { key: KERNEL_APP_CATALOG_KEY, value: state });
      return true;
    }),
    /** @param {string} appId @param {Record<string,unknown>} patch */
    patch: (appId, patch) => patchApp(appId, patch),
    /** @param {string} appId @param {boolean} favorite */
    setFavorite: (appId, favorite) => patchApp(appId, { favorite }),
    /** @param {string} appId @param {string} name */
    setName: (appId, name) => patchApp(appId, { name }),
    /** @param {string} appId @param {string} entryFile */
    setEntryFile: (appId, entryFile) => patchApp(appId, { entryFile }),
    /** @param {string} appId @param {Record<string,'text'|'binary'>} fileKinds */
    setFileKinds: (appId, fileKinds) => {
      const entries = Object.entries(fileKinds ?? {});
      if (entries.length > 256 || entries.some(([path, kind]) => (
        !path || path.length > 512 || (kind !== 'text' && kind !== 'binary')
      ))) throw new TypeError('app-file-kinds-invalid');
      return patchApp(appId, { fileKinds: Object.fromEntries(entries) });
    },
    /** @param {string} sessionId @param {string} appId */
    setDefaultForSession: (sessionId, appId) => mutate(async () => {
      const state = parseKernelAppCatalogRow(await read());
      if (!state?.apps[appId]) return false;
      state.sessionDefaults[sessionId] = appId;
      await idb.put('apps', { key: KERNEL_APP_CATALOG_KEY, value: state });
      return true;
    }),
  });
};

/** @param {any} deps */
export const makeKernelAppCatalogRoutes = ({
  vault, idb, catalog = createKernelAppCatalog({ idb }), reloadApp = () => {},
  browser = null, appTabUrl = '', sessionCache = undefined,
  isAppSender = () => false, appFiles = undefined, dwebEnabled = false,
}) => Object.freeze({
  'apps/list': async () => {
    if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
    try { return { ok: true, apps: await catalog.list() }; }
    catch (cause) {
      return { ok: false, error: /** @type {{message?:string}} */ (cause)?.message ?? String(cause) };
    }
  },
  'apps/favorite': async (
    /** @type {{appId?:unknown,favorite?:unknown}} */ { appId, favorite } = {},
  ) => {
    if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
    if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
    if (typeof favorite !== 'boolean') return { ok: false, error: 'favorite-boolean-required' };
    try {
      const app = await catalog.setFavorite(appId, favorite);
      return app ? { ok: true, app } : { ok: false, error: 'app-not-found' };
    } catch (cause) {
      return catalogEffectFailure(cause, 'app-favorite-outcome-unknown', 'the favorite update');
    }
  },
  'apps/rename': async (
    /** @type {{appId?:unknown,name?:unknown}} */ { appId, name } = {},
  ) => {
    if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
    if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
    if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'name-required' };
    try {
      const app = await catalog.setName(appId, name.trim().slice(0, 80));
      if (!app) return { ok: false, error: 'app-not-found' };
      Promise.resolve(reloadApp(appId)).catch(() => {});
      return { ok: true, app };
    } catch (cause) {
      return catalogEffectFailure(cause, 'app-rename-outcome-unknown', 'the App rename');
    }
  },
  'apps/open': async (/** @type {{appId?:unknown}} */ { appId } = {}) => {
    if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
    if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
    const app = await catalog.get(appId);
    if (!app) return { ok: false, error: 'app-not-found' };
    const sessionId = await sessionCache?.sessionGet('currentSessionId');
    const owner = typeof sessionId === 'string' ? sessionId
      : typeof app.ownerSessionId === 'string' ? app.ownerSessionId : null;
    const url = `${appTabUrl}#${appId}${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`;
    const existing = (await browser?.tabs?.query?.({ url: `${appTabUrl}#${appId}*` }) ?? [])[0];
    try {
      if (typeof existing?.id === 'number') await browser.tabs.update(existing.id, { active: true });
      else await browser?.tabs?.create?.({ url, active: true });
      if (typeof sessionId === 'string') await catalog.setDefaultForSession(sessionId, appId);
      return { ok: true };
    } catch (cause) {
      return catalogEffectFailure(cause, 'app-open-outcome-unknown', 'opening the App');
    }
  },
  'app/get-meta': async (
    /** @type {{appId?:unknown}} */ { appId } = {}, /** @type {unknown} */ sender = undefined,
  ) => {
    if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
    if (!isAppSender(sender, appId)) return { ok: false, error: 'app-meta-unauthorized' };
    let app = await catalog.get(appId);
    if (!app) return { ok: false, error: 'app-not-found' };
    let runtimeDweb = app.dweb ?? null;
    let runtimeAgent = { kind: 'bound-app', profile: 'developer', surface: 'code' };
    if (appFiles) {
      try {
        const contract = parseAppManifest(await appFiles.readText(appId, 'peerd.json'));
        const paths = new Set((await appFiles.listApp(appId))
          .map((/** @type {string} */ path) => path.replace(/^\/+/, '')));
        if (!paths.has(contract.entry)) {
          return { ok: false, error: `peerd.json entry is missing: ${contract.entry}` };
        }
        runtimeDweb = contract.capabilities.includes('dweb') && dwebEnabled
          ? (app.dweb ?? { uri: null, publisher: null, hash: null, local: true }) : null;
        runtimeAgent = contract.agent;
        if (contract.entry !== app.entryFile) {
          try { app = await catalog.setEntryFile(appId, contract.entry) ?? app; }
          catch (cause) {
            return catalogEffectFailure(
              cause, 'app-entry-update-outcome-unknown', 'the App entry update',
            );
          }
        }
      } catch (cause) {
        if (/** @type {{name?:unknown}} */ (cause)?.name !== 'NotFoundError') {
          return { ok: false, error: /** @type {{message?:string}} */ (cause)?.message ?? String(cause) };
        }
      }
    }
    return { ok: true, name: app.name, entryFile: app.entryFile,
      fileKinds: app.fileKinds ?? {}, dweb: runtimeDweb, agent: runtimeAgent };
  },
});
