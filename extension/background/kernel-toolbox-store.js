// @ts-check
// Minimal authority-side view of the Toolbox database. The native cold kernel
// needs only two operations for a semantic run: read one validated module body
// and account for the run result. Module creation, parsing, dossier rendering,
// export extraction, and write validation stay in their demand-loaded feature
// cluster and therefore do not enter the first-wake graph.

const DB_NAME = 'peerd-toolbox';
const DB_VERSION = 1;
const META_STORE = 'meta';
const BODY_STORE = 'bodies';
const TOOLBOX_NAME_RE = /^[a-z0-9-]{1,64}$/;

/**
 * @param {Object} [deps]
 * @param {IDBFactory} [deps.idbFactory]
 * @param {string} [deps.dbName]
 */
export const createKernelToolboxStore = ({
  idbFactory = globalThis.indexedDB,
  dbName = DB_NAME,
} = {}) => {
  /** @type {Promise<IDBDatabase>|null} */
  let opened = null;
  const open = () => {
    if (opened) return opened;
    opened = new Promise((resolve, reject) => {
      if (!idbFactory) {
        reject(new Error('indexedDB not available in this context'));
        return;
      }
      const request = idbFactory.open(dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'name' });
        }
        if (!db.objectStoreNames.contains(BODY_STORE)) {
          db.createObjectStore(BODY_STORE, { keyPath: 'name' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const retire = () => { db.close(); opened = null; };
        db.onversionchange = retire;
        db.onclose = () => { opened = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('open failed'));
    });
    return opened;
  };

  /** @template T @param {IDBRequest<T>} request @returns {Promise<T>} */
  const result = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  /**
   * @template T
   * @param {string} store
   * @param {IDBTransactionMode} mode
   * @param {(objectStore:IDBObjectStore)=>Promise<T>|T} operation
   * @returns {Promise<T>}
   */
  const transact = async (store, mode, operation) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      /** @type {T} */ let value;
      Promise.resolve(operation(transaction.objectStore(store)))
        .then((next) => { value = next; }, reject);
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error ?? new Error('tx failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('tx aborted'));
    });
  };

  const nameValid = (/** @type {unknown} */ name) =>
    typeof name === 'string' && TOOLBOX_NAME_RE.test(name);

  return Object.freeze({
    /** @param {unknown} name */
    getBody: (name) => !nameValid(name) ? Promise.resolve(null)
      : transact(BODY_STORE, 'readonly', async (store) => {
        const row = await result(store.get(/** @type {string} */ (name)));
        return typeof /** @type {any} */ (row)?.body === 'string'
          ? /** @type {any} */ (row).body : null;
      }),
    /** @param {unknown[]} names @param {{ok:boolean}} outcome */
    recordRuns: (names, outcome) => transact(META_STORE, 'readwrite', async (store) => {
      for (const name of names) {
        if (!nameValid(name)) continue;
        const meta = await result(store.get(/** @type {string} */ (name)));
        if (!meta || typeof meta !== 'object') continue;
        const next = /** @type {Record<string,any>} */ (meta);
        next.runCount = (Number.isFinite(next.runCount) ? next.runCount : 0) + 1;
        if (outcome?.ok !== true) {
          next.failCount = (Number.isFinite(next.failCount) ? next.failCount : 0) + 1;
        }
        store.put(next);
      }
    }),
  });
};
