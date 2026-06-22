// @ts-check
// Persistent rootfs overlay.
//
// CheerpX boots from a read-only base image (vendored, SRI-pinned). On
// top of that, we mount a read/write overlay backed by IndexedDB so
// changes survive SW restarts and browser sessions.
//
// V1 design: one IDB database per peerd install, one object store
// `vm_overlay` keyed by `blockIndex` (CheerpX's block-device layer
// addresses by index). CheerpX provides a `BlockDevice` interface we
// satisfy with read/write callbacks below.
//
// Why IDB and not OPFS:
//   - OPFS is faster and cleaner for this — direct ArrayBuffer storage
//   - BUT OPFS in offscreen documents has subtle persistence quirks
//     across SW restarts in Chrome MV3 (the offscreen doc can be torn
//     down between calls, OPFS lock semantics are not battle-tested)
//   - IDB is boring and works. V2 can migrate to OPFS once the rest of
//     the engine is stable.
//
// Reset semantics: `reset()` deletes the entire overlay store. Next VM
// run boots fresh off the base image. Useful when a session leaves
// the rootfs in a bad state.

const DB_NAME = 'peerd-vm-overlay';
const DB_VERSION = 1;
const STORE_NAME = 'blocks';

/**
 * @typedef {{
 *   read(index: number): Promise<Uint8Array | null>,
 *   write(index: number, data: Uint8Array): Promise<void>,
 *   reset(): Promise<void>,
 *   close(): void,
 * }} Overlay
 */

/**
 * Open (or create) the overlay database. Returns an Overlay handle
 * the CheerpX block-device adapter can call into.
 *
 * @param {{ indexedDB?: IDBFactory }} [deps]   for tests; defaults to globalThis.indexedDB
 * @returns {Promise<Overlay>}
 */
export const openOverlay = async (deps = {}) => {
  const idb = deps.indexedDB ?? globalThis.indexedDB;
  if (!idb) throw new Error('indexedDB not available in this realm');

  const db = await openDb(idb);

  return {
    read: (index) => promisify(
      db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(index),
    ).then((v) => v ?? null),

    write: (index, data) => promisify(
      db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(data, index),
    ).then(() => {}),

    reset: async () => {
      db.close();
      await promisify(idb.deleteDatabase(DB_NAME));
      // why: caller is expected to throw away the handle and call
      // openOverlay again. We don't auto-reopen here — that would
      // hide the lifecycle from the caller and surprise them when a
      // stale `db` reference still pointed at the dropped database.
    },

    close: () => db.close(),
  };
};

/**
 * @param {IDBFactory} idb
 * @returns {Promise<IDBDatabase>}
 */
const openDb = (idb) => new Promise((resolve, reject) => {
  const req = idb.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME);
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
  req.onblocked = () => reject(new Error('indexedDB open blocked — another tab holds an older version'));
});

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
const promisify = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
