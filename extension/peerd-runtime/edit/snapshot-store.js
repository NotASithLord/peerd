// @ts-check
// Content-addressed snapshot store — the persistence layer for
// checkpoints. Browser-native: the "workspace" here is OPFS App/Notebook
// files, NOT a mythical local git repo. A checkpoint is a manifest of
// {path -> contentHash}; the bytes live once, deduplicated by hash.
//
// why content-addressed: we snapshot AFTER every file-modifying turn
// (see service-worker.js). Most turns touch one or two files out of a
// workspace that may hold dozens. Storing a full copy per turn would be
// O(turns × workspace). Storing each distinct blob once, keyed by its
// SHA-256, makes a checkpoint O(files-changed) in new bytes — the rest
// is shared references. This is the Git object model in miniature, and
// the same idea behind OpenCode's per-turn snapshots.
//
// Two object stores, both keyed:
//   blobs       keyPath 'hash'   { hash, content }     — dedup'd file bodies
//   checkpoints keyPath 'id'     { id, scope, label,   — manifests
//                                  parentId, createdAt,
//                                  files: { path: hash }, meta }
//
// IO is injected as `db` (an idb-like { get, put, getAll, del } bound to
// a store name) so the functional core stays testable under fake-
// indexeddb without a browser. createBrowserSnapshotStore() wires the
// real one.

import { sha256Hex } from '/shared/util.js';

/**
 * @typedef {Object} Manifest
 * @property {string} id
 * @property {string} scope        e.g. 'app:abc' — which workspace this snaps
 * @property {string|null} label   user/agent label, or null for auto
 * @property {string|null} parentId previous checkpoint in the same scope
 * @property {number} createdAt
 * @property {Record<string,string>} files  path -> blob hash
 * @property {object} [meta]       free-form (turn id, tool, etc.)
 */

/**
 * @typedef {Object} StoreIO
 * @property {(store: string, key: IDBValidKey) => Promise<any>} get
 * @property {(store: string, value: any) => Promise<void>} put
 * @property {(store: string) => Promise<any[]>} getAll
 * @property {(store: string, key: IDBValidKey) => Promise<void>} del
 */

const BLOBS = 'blobs';
const CHECKPOINTS = 'checkpoints';

/**
 * Build a snapshot store over an injected IO surface.
 *
 * @param {StoreIO} io
 * @param {() => number} [now]
 */
export const createSnapshotStore = (io, now = Date.now) => {
  /**
   * Write a blob if we haven't seen its hash before; return the hash.
   * Dedup is the whole point — a put for an existing hash is a cheap
   * no-op read.
   *
   * @param {string} content
   * @returns {Promise<string>}
   */
  const putBlob = async (content) => {
    const hash = await sha256Hex(content);
    const existing = await io.get(BLOBS, hash);
    if (!existing) await io.put(BLOBS, { hash, content });
    return hash;
  };

  /** @param {string} hash @returns {Promise<string|null>} */
  const getBlob = async (hash) => {
    const row = await io.get(BLOBS, hash);
    return row ? row.content : null;
  };

  /**
   * Capture a checkpoint from a path->content map (the workspace as read
   * from OPFS). Returns the stored manifest.
   *
   * @param {Object} args
   * @param {string} args.scope
   * @param {Record<string,string>} args.files  path -> content
   * @param {string|null} [args.label]
   * @param {string|null} [args.parentId]
   * @param {object} [args.meta]
   * @param {string} [args.id]   override (tests); else time-ordered id
   * @returns {Promise<Manifest>}
   */
  const capture = async ({ scope, files, label = null, parentId = null, meta = {}, id }) => {
    if (typeof scope !== 'string' || !scope) throw new TypeError('scope required');
    /** @type {Record<string,string>} */
    const fileHashes = {};
    for (const [path, content] of Object.entries(files ?? {})) {
      fileHashes[path] = await putBlob(typeof content === 'string' ? content : String(content));
    }
    const createdAt = now();
    /** @type {Manifest} */
    const manifest = {
      // why: timestamp-prefixed id keeps getAll()-then-sort cheap and
      // gives a natural chronological order for the undo stack.
      id: id ?? `cp_${createdAt.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      scope,
      label,
      parentId,
      createdAt,
      files: fileHashes,
      meta,
    };
    await io.put(CHECKPOINTS, manifest);
    return manifest;
  };

  /** @param {string} id @returns {Promise<Manifest|null>} */
  const getCheckpoint = async (id) => (await io.get(CHECKPOINTS, id)) ?? null;

  /**
   * Reconstruct the full path->content map for a checkpoint by resolving
   * each blob hash. This is what restore writes back to OPFS.
   *
   * @param {string} id
   * @returns {Promise<Record<string,string>|null>}
   */
  const materialize = async (id) => {
    const cp = await getCheckpoint(id);
    if (!cp) return null;
    /** @type {Record<string,string>} */
    const out = {};
    for (const [path, hash] of Object.entries(cp.files)) {
      const content = await getBlob(hash);
      // A missing blob would mean a corrupted store; surface it loudly
      // rather than silently restoring a partial workspace.
      if (content === null) throw new Error(`snapshot blob missing: ${hash} for ${path}`);
      out[path] = content;
    }
    return out;
  };

  /**
   * List checkpoints for a scope, newest first. Cheap at V1 scale
   * (a getAll + filter + sort); an index lands if scopes grow large.
   *
   * @param {string} scope
   * @returns {Promise<Manifest[]>}
   */
  const list = async (scope) => {
    const all = await io.getAll(CHECKPOINTS);
    return all
      .filter((m) => m.scope === scope)
      .sort((a, b) => b.createdAt - a.createdAt);
  };

  /**
   * Delete a checkpoint manifest. We do NOT garbage-collect blobs inline
   * (other checkpoints may reference the same hash). Reversibility
   * requirement: checkpoints are deletable.
   *
   * @param {string} id
   */
  const remove = async (id) => { await io.del(CHECKPOINTS, id); };

  return {
    putBlob, getBlob,
    capture, getCheckpoint, materialize, list,
    remove,
  };
};

// --- Browser-backed IO (own IDB, not the shared `peerd` DB) -------------
//
// why a dedicated DB: bumping the shared peerd DB's version to add stores
// is a cross-cutting migration risk. Checkpoints are a self-contained
// concern with their own lifecycle, so they get their own database —
// the same pattern app-store.js uses for `peerd-app-bodies`. This keeps
// feature 02 from forcing a schema change on everyone else.

const DB_NAME = 'peerd-checkpoints';
const DB_VERSION = 1;

/** @type {Promise<IDBDatabase> | null} */
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
      if (!db.objectStoreNames.contains(BLOBS)) {
        db.createObjectStore(BLOBS, { keyPath: 'hash' });
      }
      if (!db.objectStoreNames.contains(CHECKPOINTS)) {
        db.createObjectStore(CHECKPOINTS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('open failed'));
  });
  return openPromise;
};

/** @returns {StoreIO} */
export const browserSnapshotIO = () => {
  /**
   * @template T
   * @param {string} store
   * @param {IDBTransactionMode} mode
   * @param {(s: IDBObjectStore) => Promise<T> | T} fn
   * @returns {Promise<T>}
   */
  const tx = async (store, mode, fn) => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      /** @type {T} */
      let result;
      Promise.resolve(fn(s)).then((r) => { result = r; }).catch(reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error ?? new Error('tx failed'));
      t.onabort = () => reject(t.error ?? new Error('tx aborted'));
    });
  };
  /**
   * @template T
   * @param {IDBRequest<T>} req
   * @returns {Promise<T>}
   */
  const reqP = (req) => new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return {
    get: (store, key) => tx(store, 'readonly', (s) => reqP(s.get(key))),
    getAll: (store) => tx(store, 'readonly', (s) => reqP(s.getAll())),
    // why: discard put's resolved key — the StoreIO contract is void and
    // every caller ignores the return; this keeps the type honest without
    // changing observable behavior.
    put: (store, value) => tx(store, 'readwrite', async (s) => { await reqP(s.put(value)); }),
    del: (store, key) => tx(store, 'readwrite', (s) => reqP(s.delete(key))),
  };
};

/** Convenience: the production store wired to the real IDB. */
export const createBrowserSnapshotStore = () => createSnapshotStore(browserSnapshotIO());
