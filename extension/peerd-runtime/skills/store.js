// @ts-check
// Skill storage adapter — the persistence substrate for installed skills.
//
// DEPENDENCY NOTE (feature 01, file-based memory): feature 01 owns the
// real peerd workspace store (read/write/list under a namespace in
// IDB/OPFS). It is being built in parallel, so this file is a THIN,
// SELF-CONTAINED adapter peerd-skills owns today. The integrator repoints
// it at feature 01's store by replacing the four functions below with
// calls into the workspace store under the `skills/` namespace — the
// registry only ever touches `createSkillStore()`'s returned interface,
// never IDB directly. See DEV-NOTES.md "01 adapter".
//
// PROGRESSIVE DISCLOSURE shows up in the storage shape too. A skill is
// persisted as two records under the same id:
//   - a META record (name, description, source, version, byte size) —
//     small, listed at startup to build the descriptions block.
//   - a BODY record (the full SKILL.md text) — large, read only on
//     invocation.
// Keeping them in separate stores means startup never deserializes a
// single byte of any skill body. That's the cost discipline the lean-
// memory budget (<200 lines of skill context at startup) demands.
//
// MV3 note: skills MUST survive a 30s service-worker death, so this is
// IDB-backed (persistent), never in-memory-only.

const DB_NAME = 'peerd-skills';
const DB_VERSION = 1;
const META_STORE = 'meta';
const BODY_STORE = 'bodies';

/**
 * @typedef {Object} SkillMeta
 * @property {string} id            normalized name; the invocation handle + key
 * @property {string} name          same as id today; kept distinct for clarity
 * @property {string} description    the cheap startup-injected line(s)
 * @property {string|null} version
 * @property {string|null} license
 * @property {string[]} allowedTools  advisory; peerd never auto-grants these
 * @property {'local'|'git'|'manifest'} source   how it was installed
 * @property {string|null} origin    source URL/dir label, for the UI + audit
 * @property {number} sizeBytes      body size — surfaced so users see cost
 * @property {boolean} enabled       toggled off → excluded from the prompt
 * @property {number} installedAt    epoch ms
 */

/**
 * Build a skill store over an injected IDB-like surface. Production wiring
 * passes the real `indexedDB`; tests pass fake-indexeddb. Functional-core
 * discipline: IO is injected, never imported here.
 *
 * @param {Object} [deps]
 * @param {IDBFactory} [deps.idbFactory]  defaults to globalThis.indexedDB
 */
export const createSkillStore = (deps = {}) => {
  const idbFactory = deps.idbFactory ?? globalThis.indexedDB;
  /** @type {Promise<IDBDatabase> | null} */
  let openPromise = null;

  const openDb = () => {
    if (openPromise) return openPromise;
    openPromise = new Promise((resolve, reject) => {
      if (!idbFactory) {
        reject(new Error('indexedDB not available in this context'));
        return;
      }
      const req = idbFactory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(BODY_STORE)) {
          // value: { id, body }
          db.createObjectStore(BODY_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // why: if another context (a second tab, or a test resetting the
        // DB) triggers a version change or delete, close our connection and
        // drop the cache so we don't block the upgrade/delete and so the
        // next call re-opens cleanly. Mirrors the egress idb.js wrapper.
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
   * @param {string | string[]} stores
   * @param {IDBTransactionMode} mode
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

  /**
   * @template T
   * @param {IDBRequest<T>} request
   * @returns {Promise<T>}
   */
  const reqP = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return {
    /**
     * Persist a skill (meta + body) atomically in one transaction.
     * @param {SkillMeta} meta
     * @param {string} body
     */
    put: (meta, body) => tx([META_STORE, BODY_STORE], 'readwrite', (t) => {
      t.objectStore(META_STORE).put(meta);
      t.objectStore(BODY_STORE).put({ id: meta.id, body });
    }),

    /**
     * List ALL skill metas. This is the startup hot path — it touches the
     * meta store ONLY, so no skill body is ever read here.
     * @returns {Promise<SkillMeta[]>}
     */
    listMeta: () => tx(META_STORE, 'readonly', (t) =>
      reqP(t.objectStore(META_STORE).getAll())),

    /**
     * Read one skill's full body. The expensive, on-invocation-only path.
     * @param {string} id
     * @returns {Promise<string|null>}
     */
    getBody: async (id) => tx(BODY_STORE, 'readonly', async (t) => {
      const row = await reqP(t.objectStore(BODY_STORE).get(id));
      return row?.body ?? null;
    }),

    /**
     * Remove a skill entirely (reversibility — every install is
     * uninstallable). Drops both records.
     * @param {string} id
     */
    remove: (id) => tx([META_STORE, BODY_STORE], 'readwrite', (t) => {
      t.objectStore(META_STORE).delete(id);
      t.objectStore(BODY_STORE).delete(id);
    }),
  };
};

/**
 * @typedef {ReturnType<typeof createSkillStore>} SkillStore
 */
