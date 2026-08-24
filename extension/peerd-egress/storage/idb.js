// @ts-check

const DB_NAME = 'peerd';
const DB_VERSION = 13;
const OPEN_TIMEOUT_MS = 8_000;
const TX_TIMEOUT_MS = 15_000;

/** @param {IDBTransaction} tx @param {Function} resolve @param {Function} reject */
const guardTransaction = (tx, resolve, reject) => {
  let settled = false;
  const finish = (/** @type {Function} */ fn, /** @type {unknown} */ value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn(value);
  };
  const timer = setTimeout(() => {
    try { tx.abort(); } catch {}
    finish(reject, new Error('idb-transaction-timeout'));
  }, TX_TIMEOUT_MS);
  return {
    resolve: (/** @type {unknown} */ value) => finish(resolve, value),
    reject: (/** @type {unknown} */ cause) => finish(reject, cause),
  };
};

/** @returns {Promise<IDBDatabase>} */
/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;
export const openDB = () => {
  if (dbPromise) return dbPromise;
  const opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;
    const fail = (/** @type {unknown} */ cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (dbPromise === opening) dbPromise = null;
      reject(cause);
    };
    const timer = setTimeout(() => fail(new Error('idb-open-timeout')), OPEN_TIMEOUT_MS);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'sessionId' });
      }
      if (!db.objectStoreNames.contains('audit_log')) {
        db.createObjectStore('audit_log', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('tool_grants')) {
        db.createObjectStore('tool_grants', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('vm_state')) {
        db.createObjectStore('vm_state', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('agents_memory')) {
        db.createObjectStore('agents_memory', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('audit_meta')) {
        db.createObjectStore('audit_meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('web_extract_cache')) {
        db.createObjectStore('web_extract_cache', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('vault')) {
        db.createObjectStore('vault', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('profiles')) {
        db.createObjectStore('profiles', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('apps')) {
        db.createObjectStore('apps', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('vms')) {
        db.createObjectStore('vms', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('notebooks')) {
        db.createObjectStore('notebooks', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('pods')) {
        db.createObjectStore('pods', { keyPath: 'key' });
      }
      if (db.objectStoreNames.contains('sandboxes')) {
        db.deleteObjectStore('sandboxes');
      }
      if (!db.objectStoreNames.contains('contacts')) {
        db.createObjectStore('contacts', { keyPath: 'did' });
      }
      if (!db.objectStoreNames.contains('vm_http_cache')) {
        db.createObjectStore('vm_http_cache', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('session_messages')) {
        db.createObjectStore('session_messages', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('dpop_keys')) {
        db.createObjectStore('dpop_keys', { keyPath: 'origin' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) { db.close(); return; }
      settled = true;
      clearTimeout(timer);
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => fail(req.error ?? new Error('idb-open-failed'));
    req.onblocked = () => fail(new Error('idb-open-blocked'));
  });
  dbPromise = /** @type {Promise<IDBDatabase>} */ (opening);
  return dbPromise;
};

/** @template T
 * @param {string} store
 * @param {(s: IDBObjectStore) => IDBRequest<T>} fn
 * @returns {Promise<T>}
 */
export const read = async (store, fn) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const guard = guardTransaction(tx, resolve, reject);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => guard.resolve(req.result);
    req.onerror = () => guard.reject(req.error);
    tx.onabort = () => guard.reject(tx.error ?? new Error('idb-read-aborted'));
  });
};

/** @param {string} store
 * @param {(s: IDBObjectStore) => void} fn
 * @returns {Promise<void>}
 */
export const write = async (store, fn) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const guard = guardTransaction(tx, resolve, reject);
    fn(tx.objectStore(store));
    tx.oncomplete = () => guard.resolve(undefined);
    tx.onerror = () => guard.reject(tx.error);
    tx.onabort = () => guard.reject(tx.error ?? new Error('idb-write-aborted'));
  });
};

/** Atomic multi-store request graph; resolves after commit. @template T
 * @param {string[]} stores
 * @param {(stores:Record<string,IDBObjectStore>,tx:IDBTransaction)=>T|(()=>T)} fn
 * @returns {Promise<T>} */
export const transact = async (stores, fn) => {
  if (!Array.isArray(stores) || stores.length === 0
      || new Set(stores).size !== stores.length
      || stores.some((store) => typeof store !== 'string' || !store)
      || typeof fn !== 'function') throw new TypeError('idb-transaction-invalid');
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    const guard = guardTransaction(tx, resolve, reject);
    const handles = Object.fromEntries(stores.map((name) => [name, tx.objectStore(name)]));
    /** @type {T|(()=>T)} */
    let result;
    try {
      result = fn(handles, tx);
      if (result && typeof /** @type {any} */ (result).then === 'function') {
        throw new TypeError('idb-transaction-callback-must-be-synchronous');
      }
    }
    catch (cause) { try { tx.abort(); } catch {} guard.reject(cause); return; }
    tx.oncomplete = () => guard.resolve(typeof result === 'function'
      ? /** @type {()=>T} */ (result)() : result);
    tx.onerror = () => guard.reject(tx.error ?? new Error('idb-transaction-failed'));
    tx.onabort = () => guard.reject(tx.error ?? new Error('idb-transaction-aborted'));
  });
};

/** @param {string} store @param {any} value */
export const put = (store, value) => write(store, (s) => s.put(value));

/** @param {string} store
 * @param {IDBValidKey} key
 * @param {Record<string, unknown>} fields
 * @returns {Promise<any|undefined>}
 */
export const patch = async (store, key, fields) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const guard = guardTransaction(tx, resolve, reject);
    const objectStore = tx.objectStore(store);
    const request = objectStore.get(key);
    /** @type {any} */
    let updated;
    request.onsuccess = () => {
      if (request.result === undefined) return;
      updated = { ...request.result, ...fields };
      objectStore.put(updated);
    };
    tx.oncomplete = () => guard.resolve(updated);
    tx.onerror = () => guard.reject(tx.error);
    tx.onabort = () => guard.reject(tx.error ?? new Error('idb-patch-aborted'));
  });
};

/** @param {string} store @param {IDBValidKey} key */
export const get = (store, key) => read(store, (s) => s.get(key));

/** @param {string} store
 * @param {ReadonlyArray<IDBValidKey>} keys
 * @returns {Promise<any[]>}
 */
export const getMany = async (store, keys) => {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const guard = guardTransaction(tx, resolve, reject);
    const os = tx.objectStore(store);
    const out = new Array(keys.length);
    keys.forEach((key, i) => {
      const req = os.get(key);
      req.onsuccess = () => { out[i] = req.result; };
    });
    tx.oncomplete = () => guard.resolve(out);
    tx.onerror = () => guard.reject(tx.error);
    tx.onabort = () => guard.reject(tx.error ?? new Error('idb-read-aborted'));
  });
};

/** @param {string} store */
export const getAll = (store) => read(store, (s) => s.getAll());

/** @param {string} store @param {IDBValidKey} key */
export const del = (store, key) => write(store, (s) => s.delete(key));

/** @param {string} store
 * @returns {Promise<number>}
 */
export const count = (store) => read(store, (s) => s.count());

/** @param {string} store
 * @param {number} [limit]
 * @returns {Promise<IDBValidKey[]>}
 */
export const getAllKeys = (store, limit) =>
  read(store, (s) => limit === undefined ? s.getAllKeys() : s.getAllKeys(null, limit));

/** @param {string} store
 * @param {IDBValidKey} key
 */
export const delUpTo = (store, key) =>
  write(store, (s) => s.delete(IDBKeyRange.upperBound(key)));

/** @param {string} store */
export const clear = (store) => write(store, (s) => s.clear());

/** @param {string} store
 * @returns {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void> }}
 */
export const idbKV = (store) => ({
  get: async (key) => (await get(store, key))?.value,
  set: async (key, value) => put(store, { key, value }),
});
