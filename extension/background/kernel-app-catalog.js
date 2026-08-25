// @ts-check
// Native App metadata authority; bytes and repository work stay demand-owned.

import { makeSerialLane } from '../shared/cold-util.js';

export const KERNEL_APP_CATALOG_KEY = 'apps.v1';

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
  const mutate = makeSerialLane();
  /** @type {Record<string,any>|null} */
  let liveRegistry = null;
  const run = (/** @type {()=>Promise<any>} */ cold,
    /** @type {(registry:Record<string,any>)=>Promise<any>} */ live) =>
    mutate(() => liveRegistry ? live(liveRegistry) : cold());
  /** @param {string} appId @param {Record<string,unknown>} patch */
  const patchApp = (appId, patch) => run(async () => {
    const state = parseKernelAppCatalogRow(await read());
    const current = state?.apps[appId];
    if (!state || !current) return null;
    state.apps[appId] = { ...current, ...patch, updatedAt: now() };
    await idb.put('apps', { key: KERNEL_APP_CATALOG_KEY, value: state });
    return state.apps[appId];
  }, (registry) => registry.update(appId, patch));
  const boundRegistry = Object.freeze({
    load: () => run(async () => {}, (registry) => registry.load()),
    list: () => run(async () => kernelAppCatalogRows(await read()), (registry) => registry.list()),
    get: (/** @type {string} */ id) => run(
      async () => parseKernelAppCatalogRow(await read())?.apps[id] ?? null,
      (registry) => registry.get(id),
    ),
    create: (/** @type {any} */ input) => run(
      async () => { throw new Error('kernel-app-registry-not-bound'); },
      (registry) => registry.create(input),
    ),
    update: (/** @type {string} */ id, /** @type {any} */ patch) => run(
      async () => { throw new Error('kernel-app-registry-not-bound'); },
      (registry) => registry.update(id, patch),
    ),
    delete: (/** @type {string} */ id) => run(
      async () => { throw new Error('kernel-app-registry-not-bound'); },
      (registry) => registry.delete(id),
    ),
    getDefaultForSession: (/** @type {string} */ sessionId) => run(
      async () => kernelSessionAppId(await read(), sessionId),
      (registry) => registry.getDefaultForSession(sessionId),
    ),
    setDefaultForSession: (/** @type {string} */ sessionId, /** @type {string} */ id) => run(
      async () => { throw new Error('kernel-app-registry-not-bound'); },
      (registry) => registry.setDefaultForSession(sessionId, id),
    ),
    setActorSession: (/** @type {string} */ id, /** @type {string} */ actorSessionId) => run(
      async () => { throw new Error('kernel-app-registry-not-bound'); },
      (registry) => registry.setActorSession(id, actorSessionId),
    ),
    getActorSession: (/** @type {string} */ id) => run(
      async () => null,
      (registry) => registry.getActorSession(id),
    ),
    snapshot: (/** @type {any} */ options = {}) => run(
      async () => ({ apps: kernelAppCatalogRows(await read()), currentId: null }),
      (registry) => registry.snapshot(options),
    ),
    searchMetadata: (/** @type {string} */ query) => run(
      async () => [],
      (registry) => registry.searchMetadata(query),
    ),
  });
  return Object.freeze({
    bindLiveRegistry: (/** @type {()=>Promise<Record<string,any>>} */ create) => mutate(async () => {
      if (liveRegistry) return boundRegistry;
      const registry = await create();
      if (!registry || typeof registry.load !== 'function') {
        throw new TypeError('kernel-app-live-registry-invalid');
      }
      await registry.load();
      liveRegistry = registry;
      return boundRegistry;
    }),
    list: () => run(async () => kernelAppCatalogRows(await read()), (registry) => registry.list()),
    /** @param {string} appId */
    get: (appId) => run(
      async () => parseKernelAppCatalogRow(await read())?.apps[appId] ?? null,
      (registry) => registry.get(appId),
    ),
    /** @param {string} sessionId */
    getDefaultForSession: (sessionId) => run(
      async () => kernelSessionAppId(await read(), sessionId),
      (registry) => registry.getDefaultForSession(sessionId),
    ),
    /** @param {{name?:unknown,ownerSessionId?:unknown}} input */
    createImported: (input = {}) => run(async () => {
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
    }, (registry) => registry.create({ ...input, source: 'imported' })),
    /** @param {string} appId */
    remove: (appId) => run(async () => {
      const state = parseKernelAppCatalogRow(await read());
      if (!state?.apps[appId]) return false;
      delete state.apps[appId];
      for (const [sessionId, id] of Object.entries(state.sessionDefaults)) {
        if (id === appId) delete state.sessionDefaults[sessionId];
      }
      await idb.put('apps', { key: KERNEL_APP_CATALOG_KEY, value: state });
      return true;
    }, (registry) => registry.delete(appId)),
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
    setDefaultForSession: (sessionId, appId) => run(async () => {
      const state = parseKernelAppCatalogRow(await read());
      if (!state?.apps[appId]) return false;
      state.sessionDefaults[sessionId] = appId;
      await idb.put('apps', { key: KERNEL_APP_CATALOG_KEY, value: state });
      return true;
    }, async (registry) => {
      if (!await registry.get(appId)) return false;
      await registry.setDefaultForSession(sessionId, appId);
      return true;
    }),
  });
};
