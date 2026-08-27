// @ts-check
// tools/result-store.js — one opaque spill store for oversized tool results.
//
// `fetch_url`, `read_doc`, `read_page`, and `script` write the same bounded
// record shape. `read_result` is the only read side. Every record carries its
// producing tool, origin/provenance, trust posture, and owning session so one
// leaked handle cannot cross an actor or chat boundary.
//
// Functional-core discipline (site-clients/store.js is the template): IO
// (indexedDB) is INJECTED so this is Bun-testable with fake-indexeddb, never
// imported here. Its own DB — spilled results are best-effort cache bytes,
// safe to clear, never mixed into a durable store.

import { SPILL_CACHE_MAX_ENTRIES } from './web/spill.js';
import { MAX_SPILL_TEXT_CHARS } from './result-store-policy.js';

export { MAX_SPILL_TEXT_CHARS } from './result-store-policy.js';

const DB_NAME = 'peerd-result-spills';
// v2 added the createdAt index (body-free eviction below).
const DB_VERSION = 2;
const STORE = 'entries';
const CREATED_AT_INDEX = 'createdAt';

// LRU cap — one window onto recent oversized values, not an archive. Eviction
// is by createdAt because opaque keys are deliberately unordered.
const MAX_ENTRIES = SPILL_CACHE_MAX_ENTRIES;

// Per-record text ceiling. A spilled value is a paging convenience, not an
// archive: without a ceiling one pathological multi-hundred-MB value would
// dominate the store (and every context that materializes the record). At the
// read tool's per-call slice cap this is still hundreds of pages.
/**
 * @typedef {Object} ResultSpillRecord
 * @property {string} key             opaque local handle
 * @property {string} ownerSessionId  the session whose tool spilled — read refuses others
 * @property {'fetch_url'|'read_doc'|'read_page'|'script'} producer
 * @property {boolean} fenced         whether the stored bytes re-enter untrusted
 * @property {string} originLabel     source origin / fence label
 * @property {string} [url]           exact source URL where applicable
 * @property {string} [format]        stored representation where applicable
 * @property {string} text            the serialized value (capped at MAX_SPILL_TEXT_CHARS)
 * @property {number} createdAt
 */

/**
 * Build the result store over an injected IDB-like surface. Production passes
 * the real `indexedDB`; tests pass fake-indexeddb.
 *
 * @param {Object} [deps]
 * @param {IDBFactory} [deps.idbFactory]  defaults to globalThis.indexedDB
 * @param {() => number} [deps.now]        injected clock (deterministic tests)
 * @param {string} [deps.dbName]           override — tests use a unique name per case
 */
export const createResultStore = (deps = {}) => {
  const idbFactory = deps.idbFactory ?? globalThis.indexedDB;
  const now = deps.now ?? Date.now;
  const dbName = deps.dbName ?? DB_NAME;
  /** @type {Promise<IDBDatabase> | null} */
  let openPromise = null;

  const openDb = () => {
    if (openPromise) return openPromise;
    openPromise = new Promise((resolve, reject) => {
      if (!idbFactory) { openPromise = null; reject(new Error('indexedDB not available in this context')); return; }
      const req = idbFactory.open(dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const store = db.objectStoreNames.contains(STORE)
          // why the non-null cast: inside onupgradeneeded the request always
          // carries its versionchange transaction.
          ? /** @type {IDBTransaction} */ (req.transaction).objectStore(STORE)
          : db.createObjectStore(STORE, { keyPath: 'key' });
        if (!store.indexNames.contains(CREATED_AT_INDEX)) store.createIndex(CREATED_AT_INDEX, 'createdAt');
      };
      req.onsuccess = () => {
        const db = req.result;
        // Mirror the skills/egress idb wrapper: yield to another context's
        // version-change / delete so we never block an upgrade, and re-open clean.
        db.onversionchange = () => { db.close(); openPromise = null; };
        db.onclose = () => { openPromise = null; };
        resolve(db);
      };
      // Clear the cached promise so a TRANSIENT open failure doesn't disable
      // the spill until the SW restarts — the next call retries.
      req.onerror = () => { openPromise = null; reject(req.error ?? new Error('open failed')); };
    });
    return openPromise;
  };

  /**
   * @template T
   * @param {IDBTransactionMode} mode
   * @param {(t: IDBTransaction) => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  const tx = async (mode, fn) => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
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

  // Evict the oldest entries beyond the cap WITHOUT materializing bodies (the
  // web cache's getAllKeys/delUpTo posture, over an index because run keys are
  // not chronological): count, then walk the createdAt index with a KEY cursor
  // deleting until the overflow is gone — record text never enters memory.
  const evictOverflow = () => tx('readwrite', async (t) => {
    const store = t.objectStore(STORE);
    let excess = (await reqP(store.count())) - MAX_ENTRIES;
    if (excess <= 0) return;
    await new Promise((resolve, reject) => {
      const cursorReq = store.index(CREATED_AT_INDEX).openKeyCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || excess <= 0) { resolve(undefined); return; }
        store.delete(cursor.primaryKey);
        excess -= 1;
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  });

  return {
    // why opaque: result handles must reveal no run, URL, tool-use, or session id.
    key: () => `result:${crypto.randomUUID()}`,

    /**
     * Store one spilled value (stamped createdAt, text capped at
     * MAX_SPILL_TEXT_CHARS), then evict the oldest entries beyond the cap in
     * a SEPARATE best-effort transaction — a failed eviction never fails the
     * put (a shared transaction would abort both).
     * @param {Omit<ResultSpillRecord, 'createdAt'> & { createdAt?: number }} record
     * @returns {Promise<void>}
     */
    put: async (record) => {
      const text = typeof record.text === 'string' && record.text.length > MAX_SPILL_TEXT_CHARS
        ? record.text.slice(0, MAX_SPILL_TEXT_CHARS)
        : record.text;
      await tx('readwrite', (t) => { t.objectStore(STORE).put({ createdAt: now(), ...record, text }); });
      await evictOverflow().catch(() => { /* eviction is hygiene, never a failure */ });
    },

    /**
     * @param {string} key
     * @returns {Promise<ResultSpillRecord | undefined>}
     */
    get: (key) => tx('readonly', async (t) =>
      /** @type {ResultSpillRecord | undefined} */ (await reqP(t.objectStore(STORE).get(key)))),
  };
};

/** @typedef {ReturnType<typeof createResultStore>} ResultStore */
