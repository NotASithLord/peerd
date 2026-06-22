// @ts-check
// Contacts store — CRUD over the IDB `contacts` object store.
//
// A pure store factory over injected idb, mirroring profiles/store.js: IO is a
// parameter, never an import. One record per known peer, keyed by its did:key
// (the store's keyPath). The record is the user-owned overlay only (name/notes/
// tags) — activity history is derived elsewhere (aggregate.js), never stored.

import { isPeerDid, newContactRecord, applyContactPatch } from './contact.js';

const STORE = 'contacts';

export class InvalidDidError extends Error {
  /** @param {unknown} did */
  constructor(did) {
    super(`not a valid peer did: ${String(did).slice(0, 32)}`);
    this.name = 'InvalidDidError';
  }
}

/**
 * @param {Object} deps
 * @param {{
 *   get: (store: string, key: string) => Promise<any>,
 *   put: (store: string, value: any) => Promise<void>,
 *   getAll: (store: string) => Promise<any[]>,
 *   del: (store: string, key: string) => Promise<void>,
 * }} deps.idb
 * @param {() => number} [deps.now]  injectable clock
 */
export const createContactsStore = ({ idb, now = Date.now }) => {
  if (!idb || typeof idb.get !== 'function') {
    throw new TypeError('createContactsStore: idb adapter is required');
  }

  /** @param {string} did @returns {Promise<import('./contact.js').ContactRecord | undefined>} */
  const get = (did) => idb.get(STORE, did);

  /** All saved contacts (the overlay set only — derived "known peers" is aggregate.js). */
  const list = () => idb.getAll(STORE);

  /**
   * Upsert a peer's overlay: create it on first touch, else patch the editable
   * fields. This is the single write the UI makes when you name (or note/tag) a
   * peer. Returns the stored record.
   *
   * @param {string} did
   * @param {{ name?: string|null, notes?: string, tags?: string[], favorite?: boolean }} patch
   */
  const upsert = async (did, patch = {}) => {
    if (!isPeerDid(did)) throw new InvalidDidError(did);
    const existing = await get(did);
    const record = existing
      ? applyContactPatch(existing, patch, now())
      : newContactRecord(did, patch, now());
    await idb.put(STORE, record);
    return record;
  };

  /** Forget a peer's overlay (the did may still surface as a "known" peer from
   * its app/audit history — this just drops the user-assigned name/notes).
   * @param {string} did */
  const remove = async (did) => {
    const existing = await get(did);
    if (!existing) return false;
    await idb.del(STORE, did);
    return true;
  };

  return Object.freeze({ get, list, upsert, remove });
};
