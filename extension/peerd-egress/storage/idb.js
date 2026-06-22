// @ts-check
// IndexedDB wrapper for larger structured data — sessions, audit log,
// tool grants, the engine instance catalogs, and more.
//
// Object stores:
//   sessions     keyPath: sessionId
//   audit_log    keyPath: id          (UUIDv7 — cursor reads return chronologically)
//   tool_grants  keyPath: id          composite "sessionId:toolName:origin"
//   vm_state     keyPath: key         vestigial (declared, no live writers) — see ROADMAP
//   agents_memory keyPath: id         AGENTS.md docs, keyed by scope id (V1.5)
//   vault        keyPath: key         the vault blob (wrapped DK + wrap metadata)
//   profiles     keyPath: id          profile records ('default' today; multi-profile later)
//   apps         keyPath: key         App catalog blob (record { key:'apps.v1', value })
//   notebooks    keyPath: key         Notebook catalog blob ({ key:'notebooks.v1', value })
//   vms          keyPath: key         WebVM catalog blob ({ key:'webvms.v1', value })
//   contacts     keyPath: did         per-peer overlay (user name/notes/tags), keyed by did:key
//
// The apps/notebooks/vms stores hold the per-kind catalog as a SINGLE
// { key, value } blob (the registry-factory's load-all / persist-all
// shape), moved off chrome.storage.local for consistency + to escape its
// ~10MB quota. See `idbKV` at the bottom — the single-blob adapter the
// registries inject. The live App/Sandbox FILES stay in OPFS and VM
// disks in their own per-VM IDB block devices; only the catalog + the
// content-addressed bundle live here.
//
// We keep the wrapper deliberately thin. IndexedDB is verbose, but we
// don't want to take on a heavier wrapper library for a fixed schema.

const DB_NAME = 'peerd';
// v2 (V1.5): adds the agents_memory store. The upgrade is forward-only
// and additive — existing stores are untouched, so V1 data survives.
// v3: adds the vault store (the vault blob moves out of
// chrome.storage.local — storage hygiene, see vault/blob-migration.js).
// v4: adds the profiles store (ROADMAP "Profiles", deprioritized to the
// default-profile shape — one record, id 'default', carrying peerName +
// the onboarding latch; the store is multi-profile shaped for later).
// v5: adds the engine catalog stores (apps/sandboxes/vms) + app_content.
// The catalogs move off chrome.storage.local onto IDB for storage
// consistency and to escape the ~10MB local quota (pre-release: the old
// chrome.storage.local catalogs are abandoned, not migrated).
// v6: renames the JS-kind catalog store 'sandboxes' → 'notebooks' (the
// kind was renamed Sandbox → Notebook). Pre-release, no migration: the
// old 'sandboxes' store is dropped and any local instances in it are
// orphaned (accepted — see notebook-registry.js).
// v7: adds the contacts store (peerd-runtime/contacts) — one record per
// known peer, keyed by its did:key, carrying the user-assigned name +
// notes/tags. Additive, forward-only; nothing else changes.
// v8: adds the vm_http_cache store — the WebVM's HTTP bridge caches safe,
// idempotent GETs here (records { key, meta, bodyB64, storedAt }; bodies up to
// the cache cap, too big for chrome.storage.local). A pure best-effort speed
// layer: a dev re-cloning/re-installing the same bytes hits warm IDB instead
// of re-streaming. Additive, forward-only; safe to clear at any time.
// v9: adds the session_messages store (peerd-runtime/sessions) — one record
// per chat message, keyed by the message's uuidv7 id, so a streaming delta
// is a single-record patch instead of a whole-session rewrite (kills the
// per-token write amplification + the cross-field race). The session record
// keeps only an ordered `msgIndex`; the store migrates inline messages
// lazily on read. Additive, forward-only.
// why v8 AND v9 are separate (integration note): #53 (vm_http_cache) and #72
// (session_messages) each claimed their own version — a store sharing a
// version with another would never fire onupgradeneeded for a user already at
// that version → NotFoundError. #53 lands first at v8; this is v9. Both upgrade
// blocks below run in order for a pre-v8 user; each is guarded by a contains()
// check so re-runs are idempotent.
const DB_VERSION = 9;

/**
 * Open the database. Cached after first call. Re-opens on connection
 * error (extension reload, etc.).
 *
 * @returns {Promise<IDBDatabase>}
 */
/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;
export const openDB = () => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Schema upgrade is a single forward-only path; if we add stores
      // in a future version, bump DB_VERSION and add another `if` here.
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
      // V1.5 — file-based memory. One AGENTS.md doc per scope id.
      if (!db.objectStoreNames.contains('agents_memory')) {
        db.createObjectStore('agents_memory', { keyPath: 'id' });
      }
      // v3 — the vault blob's new home (records: { key, value }). The
      // blob itself stays ciphertext; this is hygiene, not a security
      // boundary — both backends are unencrypted extension-scoped disk.
      if (!db.objectStoreNames.contains('vault')) {
        db.createObjectStore('vault', { keyPath: 'key' });
      }
      // v4 — profile records (peerd-runtime/profiles). One 'default'
      // record today; the keyPath-on-id shape is what multi-profile
      // will key per-profile namespacing off later.
      if (!db.objectStoreNames.contains('profiles')) {
        db.createObjectStore('profiles', { keyPath: 'id' });
      }
      // v5 — engine instance catalogs, moved off chrome.storage.local.
      // Each holds the whole per-kind catalog as one { key, value } blob
      // (the registry-factory load-all/persist-all shape) via `idbKV`.
      // (The content-addressed App-bundle store the dweb sharing tier will
      // need is intentionally NOT created here — it gets added with its
      // first writer, not reserved empty.)
      if (!db.objectStoreNames.contains('apps')) {
        db.createObjectStore('apps', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('vms')) {
        db.createObjectStore('vms', { keyPath: 'key' });
      }
      // v6 — the JS-kind catalog store, renamed 'sandboxes' → 'notebooks'.
      // Pre-release, no migration: create the new store and drop the old
      // one (orphaning any local instances it held — accepted).
      if (!db.objectStoreNames.contains('notebooks')) {
        db.createObjectStore('notebooks', { keyPath: 'key' });
      }
      if (db.objectStoreNames.contains('sandboxes')) {
        db.deleteObjectStore('sandboxes');
      }
      // v7 — contacts (peerd-runtime/contacts). One record per known peer,
      // keyed by its did:key — a user-owned overlay (personal name, notes,
      // tags) on top of the otherwise-anonymous peer identity. Activity
      // history is DERIVED at read time (apps + audit log), never stored here.
      if (!db.objectStoreNames.contains('contacts')) {
        db.createObjectStore('contacts', { keyPath: 'did' });
      }
      // v8 — the WebVM HTTP bridge's response cache. Records
      // { key, meta, bodyB64, storedAt }, keyed by the content-addressed URL.
      // Best-effort + disposable: nothing else depends on it surviving.
      if (!db.objectStoreNames.contains('vm_http_cache')) {
        db.createObjectStore('vm_http_cache', { keyPath: 'key' });
      }
      // v9 — per-message session records (peerd-runtime/sessions). One record
      // per chat message keyed by the message's uuidv7 id; the session record
      // holds only the ordered `msgIndex`. Additive; the session store
      // migrates pre-v9 inline-message sessions lazily on read.
      if (!db.objectStoreNames.contains('session_messages')) {
        db.createObjectStore('session_messages', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // If the connection closes (e.g. another tab triggered a version
      // bump), drop the cached promise so the next call re-opens cleanly.
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
};

/**
 * Run a read-only transaction on a store and return its result.
 *
 * @template T
 * @param {string} store
 * @param {(s: IDBObjectStore) => IDBRequest<T>} fn
 * @returns {Promise<T>}
 */
export const read = async (store, fn) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
};

/**
 * Run a read-write transaction. Resolves when the transaction completes,
 * not when the request fires — this catches commit-time failures (quota,
 * constraint violations) that single-request reads miss.
 *
 * @param {string} store
 * @param {(s: IDBObjectStore) => void} fn
 * @returns {Promise<void>}
 */
export const write = async (store, fn) => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    fn(tx.objectStore(store));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

/** @param {string} store @param {any} value */
export const put = (store, value) => write(store, (s) => s.put(value));

/** @param {string} store @param {IDBValidKey} key */
export const get = (store, key) => read(store, (s) => s.get(key));

/**
 * Read many records by key in ONE read-only transaction, returned aligned
 * to `keys` (a missing key yields `undefined` at its slot). This is the
 * batched assembly primitive the session store uses to rebuild a session's
 * `messages` from its `msgIndex` without N separate transactions.
 *
 * @param {string} store
 * @param {ReadonlyArray<IDBValidKey>} keys
 * @returns {Promise<any[]>}
 */
export const getMany = async (store, keys) => {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const out = new Array(keys.length);
    keys.forEach((key, i) => {
      const req = os.get(key);
      req.onsuccess = () => { out[i] = req.result; };
      // Per-request errors bubble to tx.onerror; no per-request handler.
    });
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

/** @param {string} store */
export const getAll = (store) => read(store, (s) => s.getAll());

/** @param {string} store @param {IDBValidKey} key */
export const del = (store, key) => write(store, (s) => s.delete(key));

/**
 * Number of records in a store. Backed by the engine's b-tree count —
 * O(log n), no record deserialization — so callers (audit retention) can
 * poll it cheaply on a write path.
 *
 * @param {string} store
 * @returns {Promise<number>}
 */
export const count = (store) => read(store, (s) => s.count());

/**
 * The first `limit` keys in key order (all keys when limit is omitted).
 * Keys only — no values are deserialized, which is what makes "find the
 * N oldest entries" affordable on a large store.
 *
 * @param {string} store
 * @param {number} [limit]
 * @returns {Promise<IDBValidKey[]>}
 */
export const getAllKeys = (store, limit) =>
  read(store, (s) => limit === undefined ? s.getAllKeys() : s.getAllKeys(null, limit));

/**
 * Delete every record with key <= `key` in ONE ranged delete request.
 * This is the bulk-prune primitive: deleting a batch of oldest entries
 * is a single IDBKeyRange delete, not N individual requests.
 *
 * @param {string} store
 * @param {IDBValidKey} key
 */
export const delUpTo = (store, key) =>
  write(store, (s) => s.delete(IDBKeyRange.upperBound(key)));

/** @param {string} store */
export const clear = (store) => write(store, (s) => s.clear());

/**
 * A key-value adapter over ONE IDB store, shaped like the chrome.storage
 * `kv` wrapper's get/set so the engine registries (registry-factory.js)
 * can be backed by IndexedDB with zero changes to the factory. Records
 * are `{ key, value }`; `get` unwraps to `value`, `set` wraps. The
 * registry passes its `storageKey` (e.g. 'apps.v1') as the record key,
 * so the store holds one blob per kind.
 *
 * why: the catalogs outgrew chrome.storage.local's ~10MB shared quota and
 * we want one storage substrate (IDB) for all structured state.
 *
 * @param {string} store  an existing object store ('apps' | 'notebooks' | 'vms' | …)
 * @returns {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void> }}
 */
export const idbKV = (store) => ({
  get: async (key) => (await get(store, key))?.value,
  set: async (key, value) => put(store, { key, value }),
});
