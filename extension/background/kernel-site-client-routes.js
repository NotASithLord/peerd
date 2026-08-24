// @ts-check
// Native nonsecret Site Client management. Rich derivation/runtime code stays lazy.

const DB_NAME = 'peerd-site-clients';
const DB_VERSION = 1;
const META_STORE = 'meta';
const BODY_STORE = 'bodies';

/**
 * @param {Object} deps
 * @param {(sender:unknown)=>boolean} deps.isAllowed
 * @param {IDBFactory} [deps.idbFactory]
 * @param {string} [deps.dbName]
 */
export const createKernelSiteClientRoutes = ({
  isAllowed, idbFactory = globalThis.indexedDB, dbName = DB_NAME,
}) => {
  /** @type {Promise<IDBDatabase>|null} */ let pending = null;
  const open = () => {
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      if (!idbFactory) { reject(new Error('Site Client storage is unavailable.')); return; }
      const request = idbFactory.open(dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'origin' });
        }
        if (!db.objectStoreNames.contains(BODY_STORE)) {
          db.createObjectStore(BODY_STORE, { keyPath: 'origin' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); pending = null; };
        db.onclose = () => { pending = null; };
        resolve(db);
      };
      request.onerror = () => { pending = null; reject(request.error ?? new Error('Site Client storage failed.')); };
      request.onblocked = () => { pending = null; reject(new Error('Site Client storage is busy.')); };
    });
    return pending;
  };
  const listMeta = async () => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readonly');
      const request = tx.objectStore(META_STORE).getAll();
      /** @type {any[]} */ let rows = [];
      request.onsuccess = () => { rows = request.result; };
      request.onerror = () => reject(request.error ?? new Error('Site Client list failed.'));
      tx.oncomplete = () => resolve(rows);
      tx.onerror = () => reject(tx.error ?? new Error('Site Client list failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Site Client list was cancelled.'));
    });
  };
  const remove = async (/** @type {string} */ origin) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([META_STORE, BODY_STORE], 'readwrite');
      tx.objectStore(META_STORE).delete(origin);
      tx.objectStore(BODY_STORE).delete(origin);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error ?? new Error('Site Client removal failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Site Client removal was cancelled.'));
    });
  };
  return Object.freeze({
    'site-client/list': async (
      /** @type {any} */ _message = {}, /** @type {unknown} */ sender = undefined,
    ) => {
      if (!isAllowed(sender)) return { ok: false, error: 'site-client-unauthorized' };
      try {
        const rows = /** @type {any[]} */ (await listMeta());
        return { ok: true, clients: rows.filter((row) => row && typeof row === 'object'
          && typeof row.origin === 'string').map((row) => ({
          origin: row.origin, summary: row.summary, endpoints: row.endpoints?.length ?? 0,
          auth: row.auth, deriver: row.deriver, sizeBytes: row.sizeBytes,
          derivedAt: row.derivedAt, lastVerifiedAt: row.lastVerifiedAt,
          recentFailures: row.recentFailures,
        })) };
      } catch (cause) {
        return { ok: false, error: /** @type {{message?:string}} */ (cause)?.message
          ?? 'Site Clients could not be loaded.' };
      }
    },
    'site-client/delete': async (
      /** @type {{origin?:unknown}} */ { origin } = {},
      /** @type {unknown} */ sender = undefined,
    ) => {
      if (!isAllowed(sender)) return { ok: false, error: 'site-client-unauthorized' };
      if (typeof origin !== 'string' || !origin) return { ok: false, error: 'origin-required' };
      try { await remove(origin); return { ok: true }; }
      catch (cause) {
        return { ok: false, error: /** @type {{message?:string}} */ (cause)?.message
          ?? 'Site Client could not be removed.' };
      }
    },
  });
};
