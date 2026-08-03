// @ts-check
// design js-superpower/06 — the toolbox STORE: two-tier, keyed by module name,
// copying the site-client store discipline (site-clients/store.js is the
// template): a small META record (the dossier — listed cheaply by toolbox_list)
// and a BODY record (the module source — read only at import-resolution time).
//
// A TOOLBOX MODULE IS A DISTINCT TRUST CLASS from a skill AND from a site
// client, so it gets its OWN DB: it must never be loadable as a skill (a
// skill's body is injected into the prompt as instructions; a toolbox body only
// ever executes in the sealed worker under the calling run's caps) and never be
// runnable against a site client's origin pin. Separate DBs make that boundary
// structural, not conventional.
//
// Functional-core discipline: IO (indexedDB) is INJECTED so this is
// Bun-testable with fake-indexeddb. MV3: IDB-backed (survives the 30s SW death).

import {
  validateToolboxName, validateToolboxBody, validateToolboxDescription,
  extractToolboxExports, stampToolboxMeta, isValidToolboxName,
  MAX_TOOLBOX_MODULES,
} from './core.js';

const DB_NAME = 'peerd-toolbox';
const DB_VERSION = 1;
const META_STORE = 'meta';
const BODY_STORE = 'bodies';

/**
 * Build a toolbox store over an injected IDB-like surface. Production passes
 * the real `indexedDB`; tests pass fake-indexeddb.
 *
 * @param {Object} [deps]
 * @param {IDBFactory} [deps.idbFactory]  defaults to globalThis.indexedDB
 * @param {() => number} [deps.now]        injected clock (deterministic tests)
 * @param {string} [deps.dbName]           override — tests use a unique name per
 *   case for isolation; production always uses the default.
 */
export const createToolboxStore = (deps = {}) => {
  const idbFactory = deps.idbFactory ?? globalThis.indexedDB;
  const now = deps.now ?? Date.now;
  const dbName = deps.dbName ?? DB_NAME;
  /** @type {Promise<IDBDatabase> | null} */
  let openPromise = null;

  const openDb = () => {
    if (openPromise) return openPromise;
    openPromise = new Promise((resolve, reject) => {
      if (!idbFactory) { reject(new Error('indexedDB not available in this context')); return; }
      const req = idbFactory.open(dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'name' });
        if (!db.objectStoreNames.contains(BODY_STORE)) db.createObjectStore(BODY_STORE, { keyPath: 'name' });
      };
      req.onsuccess = () => {
        const db = req.result;
        // Mirror the skills/egress idb wrapper: yield to another context's
        // version-change / delete so we never block an upgrade, and re-open clean.
        db.onversionchange = () => { db.close(); openPromise = null; };
        db.onclose = () => { openPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error('open failed'));
    });
    return openPromise;
  };

  /**
   * @template T
   * @param {string | string[]} stores @param {IDBTransactionMode} mode
   * @param {(t: IDBTransaction) => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  const tx = async (stores, mode, fn) => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      /** @type {T} */
      let result;
      Promise.resolve(fn(t)).then((r) => { result = r; }).catch(reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error ?? new Error('tx failed'));
      t.onabort = () => reject(t.error ?? new Error('tx aborted'));
    });
  };

  /** @template T @param {IDBRequest<T>} request @returns {Promise<T>} */
  const reqP = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return {
    /**
     * Persist a module (meta + body) atomically after a CONFIRMED write.
     * Validates every field (defense in depth behind the tool's proposal) and
     * enforces the module-count cap on a create. Returns the stamped meta.
     * @param {{ name: string, description?: string, body: string }} input
     * @returns {Promise<import('./core.js').ToolboxMeta>}
     */
    put: async ({ name, description, body }) => {
      const validName = validateToolboxName(name);
      const validBody = validateToolboxBody(body);
      const validDescription = validateToolboxDescription(description ?? '');
      // ONE readwrite transaction over both tiers: the prior/count read, the
      // cap re-check, and the write commit together — no interleaved put can
      // slip past the ceiling or stamp counters against a stale prior. The
      // count cap is re-checked HERE (not only in the tool's proposal) so no
      // dispatch path can grow the library past the ceiling.
      return tx([META_STORE, BODY_STORE], 'readwrite', async (t) => {
        const metaStore = t.objectStore(META_STORE);
        const prior = /** @type {import('./core.js').ToolboxMeta | undefined} */ (await reqP(metaStore.get(validName))) ?? null;
        const priorBody = /** @type {any} */ (await reqP(t.objectStore(BODY_STORE).get(validName)))?.body ?? '';
        const count = await reqP(metaStore.count());
        if (!prior && count >= MAX_TOOLBOX_MODULES) {
          throw new RangeError(`toolbox is full: ${count}/${MAX_TOOLBOX_MODULES} modules`);
        }
        const meta = stampToolboxMeta({
          name: validName, description: validDescription,
          exports: extractToolboxExports(validBody),
          body: validBody, prior, priorBody, now: now(),
        });
        metaStore.put(meta);
        t.objectStore(BODY_STORE).put({ name: validName, body: validBody });
        return meta;
      });
    },

    /**
     * List ALL metas (the toolbox_list hot path — meta store ONLY, so no module
     * body is ever deserialized here).
     * @returns {Promise<import('./core.js').ToolboxMeta[]>}
     */
    listMeta: () => tx(META_STORE, 'readonly', (t) => reqP(t.objectStore(META_STORE).getAll())),

    /**
     * The meta for one module, or null.
     * @param {string} name
     * @returns {Promise<import('./core.js').ToolboxMeta | null>}
     */
    getMeta: (name) => tx(META_STORE, 'readonly', async (t) =>
      /** @type {import('./core.js').ToolboxMeta | undefined} */ (await reqP(t.objectStore(META_STORE).get(name))) ?? null),

    /**
     * The full record (meta + body) for one module, or null — toolbox_write
     * reads this to build its proposal against the prior.
     * @param {string} name
     * @returns {Promise<{ meta: import('./core.js').ToolboxMeta, body: string } | null>}
     */
    get: (name) => tx([META_STORE, BODY_STORE], 'readonly', async (t) => {
      const meta = /** @type {import('./core.js').ToolboxMeta | undefined} */ (await reqP(t.objectStore(META_STORE).get(name)));
      if (!meta) return null;
      const bodyRow = await reqP(t.objectStore(BODY_STORE).get(name));
      return { meta, body: /** @type {any} */ (bodyRow)?.body ?? '' };
    }),

    /**
     * The BODY alone, or null — the import-resolution hot path (the toolbox/read
     * route). Body-tier only: resolution never touches the dossier.
     * @param {string} name
     * @returns {Promise<string | null>}
     */
    getBody: (name) => tx(BODY_STORE, 'readonly', async (t) => {
      if (!isValidToolboxName(name)) return null;
      const row = await reqP(t.objectStore(BODY_STORE).get(name));
      const body = /** @type {any} */ (row)?.body;
      return typeof body === 'string' ? body : null;
    }),

    /**
     * Record a RUN OUTCOME against every module a run imported: runCount always
     * bumps (a use is a use); failCount bumps when the run errored — the rot
     * signal toolbox_list surfaces. Unknown/invalid names are skipped (a module
     * deleted mid-run must not crash the bookkeeping). Idempotent per call.
     * @param {string[]} names @param {{ ok: boolean }} outcome
     * @returns {Promise<void>}
     */
    recordRuns: (names, { ok }) => tx(META_STORE, 'readwrite', async (t) => {
      const store = t.objectStore(META_STORE);
      for (const name of names) {
        if (!isValidToolboxName(name)) continue;
        const meta = /** @type {import('./core.js').ToolboxMeta | undefined} */ (await reqP(store.get(name)));
        if (!meta) continue;
        meta.runCount = (meta.runCount ?? 0) + 1;
        if (!ok) meta.failCount = (meta.failCount ?? 0) + 1;
        // why updatedAt is NOT touched: it is the WRITE timestamp (the dossier
        // shows "updated Nd ago") — a frequently-run stale module must still
        // read as old, or the treat-as-cache rot signal is masked.
        store.put(meta);
      }
    }),

    /**
     * Remove a module entirely (reversibility — every stored module is
     * deletable; a deleted name stops resolving on the next run). Drops both
     * tiers.
     * @param {string} name
     */
    remove: (name) => tx([META_STORE, BODY_STORE], 'readwrite', (t) => {
      t.objectStore(META_STORE).delete(name);
      t.objectStore(BODY_STORE).delete(name);
    }),
  };
};

/** @typedef {ReturnType<typeof createToolboxStore>} ToolboxStore */
