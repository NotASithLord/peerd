// @ts-check
// App body storage — IndexedDB layer for app HTML bodies.
//
// Apps are stored in two tiers: cheap metadata in chrome.storage.local
// (see app-registry.js), the HTML body here in IDB. Why IDB: bodies are
// generated HTML pages that can run several hundred KB; chrome.storage.
// local's 10MB ceiling is fine for an index but tight for the bodies.
// IDB also gives us natural per-id keying and async-blob-friendly I/O.
//
// V1 search is a linear scan over all bodies. That's the honest answer
// at the scale we expect (tens, maybe low hundreds of apps). When apps
// grow to thousands we'll add an inverted index or migrate to lunr.

const DB_NAME = 'peerd-app-bodies';
const STORE = 'bodies';
const DB_VERSION = 1;

/**
 * Open (or create) the apps DB. Cached per worker.
 * @type {Promise<IDBDatabase> | null}
 */
let openPromise = null;
const openDb = () => {
  if (openPromise) return openPromise;
  openPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB not available in this context'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // keyPath: id. value: { id, html, updatedAt }.
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('open failed'));
  });
  return openPromise;
};

/**
 * @template T
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
const tx = async (mode, fn) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    /** @type {T} */
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; }).catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error ?? new Error('tx failed'));
    t.onabort = () => reject(t.error ?? new Error('tx aborted'));
  });
};

/**
 * @param {string} id
 * @returns {Promise<string | null>}
 */
export const getAppBody = async (id) => {
  return tx('readonly', (store) => new Promise(
    /** @param {(v: string | null) => void} resolve */
    (resolve, reject) => {
      const r = store.get(id);
      r.onsuccess = () => resolve(r.result?.html ?? null);
      r.onerror = () => reject(r.error);
    }));
};

/**
 * @param {string} id
 * @param {string} html
 */
export const putAppBody = async (id, html) => {
  return tx('readwrite', (store) => /** @type {Promise<void>} */ (new Promise(
    (resolve, reject) => {
      const r = store.put({ id, html, updatedAt: Date.now() });
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    })));
};

/** @param {string} id */
export const deleteAppBody = async (id) => {
  return tx('readwrite', (store) => /** @type {Promise<void>} */ (new Promise(
    (resolve, reject) => {
      const r = store.delete(id);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    })));
};

/**
 * Linear-scan search across app bodies for a substring (case-insensitive).
 * Returns array of { id, snippet } for matches. Snippet is ~120 chars
 * centred on the first match.
 *
 * @param {string} query
 * @returns {Promise<Array<{ id: string, snippet: string }>>}
 */
export const searchBodies = async (query) => {
  if (!query) return [];
  const q = query.toLowerCase();
  return tx('readonly', (store) => new Promise(
    /** @param {(v: Array<{ id: string, snippet: string }>) => void} resolve */
    (resolve, reject) => {
    /** @type {Array<{ id: string, snippet: string }>} */
    const out = [];
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) { resolve(out); return; }
      const { id, html } = c.value;
      const lower = (html || '').toLowerCase();
      const idx = lower.indexOf(q);
      if (idx >= 0) {
        const start = Math.max(0, idx - 60);
        const end = Math.min(html.length, idx + query.length + 60);
        const snippet = (start > 0 ? '…' : '') + html.slice(start, end).replace(/\s+/g, ' ').trim() + (end < html.length ? '…' : '');
        out.push({ id, snippet });
      }
      c.continue();
    };
    cursor.onerror = () => reject(cursor.error);
  }));
};
