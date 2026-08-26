// @ts-check
// tools/run-cache.js — the value-spill store for JS runs (`script`).
//
// The web spill's twin, one tier down: when a run's serialized [VALUE]
// overflows its cap (tools/defs/value-block.js), the FULL text is stored here
// and read_run_cache pages it back. Records are stamped with the OWNING
// session (ownership refusal on read — a spilled value must not be pageable
// from another session) and the run's FENCE state (a value from an
// egress/actors/workspace run re-enters wrapped; a pure-compute value is the
// agent's own bytes and re-enters raw).
//
// Functional-core discipline (site-clients/store.js is the template): IO
// (indexedDB) is INJECTED so this is Bun-testable with fake-indexeddb, never
// imported here. Its own DB — spilled run values are best-effort cache bytes,
// safe to clear, never mixed into a durable store.

import { SPILL_CACHE_MAX_ENTRIES } from './web/spill.js';
import { MAX_SPILL_TEXT_CHARS } from './run-cache-policy.js';

export { MAX_SPILL_TEXT_CHARS } from './run-cache-policy.js';

const DB_NAME = 'peerd-run-cache';
// v2 added the createdAt index (body-free eviction below).
const DB_VERSION = 2;
const STORE = 'entries';
const CREATED_AT_INDEX = 'createdAt';

// LRU cap — the shared spill-cache entry cap (web/spill.js; the web extract
// cache uses the same one): a window onto recent oversized values, not an
// archive. Eviction is by createdAt (keys here carry run/toolUse ids, so key
// order is NOT chronological — unlike the web cache's time-prefixed keys).
const MAX_ENTRIES = SPILL_CACHE_MAX_ENTRIES;

// Per-record text ceiling. A spilled value is a paging convenience, not an
// archive: without a ceiling one pathological multi-hundred-MB value would
// dominate the store (and every context that materializes the record). At the
// read tool's per-call slice cap this is still hundreds of pages.
/**
 * @typedef {Object} RunCacheRecord
 * @property {string} key             `run:<runId or toolUseId>`
 * @property {string} ownerSessionId  the session whose run spilled — read refuses others
 * @property {boolean} fenced         did the run touch egress/actors/workspace (untrusted bytes)
 * @property {string} originLabel     the fence origin label the run's output used
 * @property {string} text            the serialized value (capped at MAX_SPILL_TEXT_CHARS)
 * @property {number} createdAt
 */

/**
 * Build a run-cache store over an injected IDB-like surface. Production passes
 * the real `indexedDB`; tests pass fake-indexeddb.
 *
 * @param {Object} [deps]
 * @param {IDBFactory} [deps.idbFactory]  defaults to globalThis.indexedDB
 * @param {() => number} [deps.now]        injected clock (deterministic tests)
 * @param {string} [deps.dbName]           override — tests use a unique name per case
 */
export const createRunCacheStore = (deps = {}) => {
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
    /**
     * Store one spilled value (stamped createdAt, text capped at
     * MAX_SPILL_TEXT_CHARS), then evict the oldest entries beyond the cap in
     * a SEPARATE best-effort transaction — a failed eviction never fails the
     * put (a shared transaction would abort both).
     * @param {Omit<RunCacheRecord, 'createdAt'> & { createdAt?: number }} record
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
     * @returns {Promise<RunCacheRecord | undefined>}
     */
    get: (key) => tx('readonly', async (t) =>
      /** @type {RunCacheRecord | undefined} */ (await reqP(t.objectStore(STORE).get(key)))),
  };
};

/** @typedef {ReturnType<typeof createRunCacheStore>} RunCacheStore */
