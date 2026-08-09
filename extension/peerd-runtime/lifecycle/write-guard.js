// @ts-check
// The store write guard — §11.5's "refuse to mutate" made universal.
//
// checkStores can mark a durable surface read-only when its schema is not
// writable by this build. Detection alone is a log line; this module is
// the enforcement: the SW wraps its kv and idb adapters through the guard
// ONCE at construction, and every store built on those adapters — sessions,
// vault, memory, hooks, audit, dpop, engine registries — inherits the
// refusal with zero per-store wiring. The blocked set starts empty (all
// writes allowed) and is filled from the §11.1 check at boot; reads always
// pass (read-only means READABLE).
//
// Physical mapping lives on STORE_REGISTRY entries (store-registry.js
// `physical`): registry store name → kv keys/prefixes + idb object stores.
// Two surfaces open their OWN IndexedDB databases and are not reached
// through the injected adapters — skills (peerd-skills) and App bodies
// (peerd-app-bodies). The registry marks them selfHosted and their modules
// call this guard at the mutation boundary. OPFS hosts do the same.
//
// Pure factory; the wrappers close over the mutable blocked set.

import { STORE_REGISTRY } from './store-registry.js';

export class StoreReadOnlyError extends Error {
  /** @param {string} store @param {string} target
   * @param {{ reason?: string, diagnosticId?: string }} [detail] */
  constructor(store, target, detail = {}) {
    super(`store '${store}' is read-only; refusing write to ${target}. `
      + `No data was changed.${detail.reason ? ` ${detail.reason}.` : ''}`
      + `${detail.diagnosticId ? ` Diagnostic: ${detail.diagnosticId}.` : ''}`);
    this.name = 'StoreReadOnlyError';
    this.store = store;
    this.diagnosticId = detail.diagnosticId;
  }
}

export const makeWriteGuard = () => {
  /** @type {Map<string, string>} kv exact key → store */
  const blockedKvKeys = new Map();
  /** @type {Array<[string, string]>} kv key prefix → store */
  let blockedKvPrefixes = [];
  /** @type {Map<string, string>} idb object store → store */
  const blockedIdbStores = new Map();

  /** @type {Set<string>} every blocked registry store, by NAME — the
   *  assertWritable gate for self-hosted stores keys on this. */
  const blockedNames = new Set();
  /** @type {Map<string, { reason?: string, diagnosticId?: string }>} */
  const blockedDetails = new Map();

  /**
   * Block the named registry stores. Unknown names are ignored (the check
   * that produced them is the authority); calling again is additive.
   * @param {Array<string | { store: string, reason?: string, diagnosticId?: string }>} stores
   */
  const block = (stores) => {
    for (const input of Array.isArray(stores) ? stores : []) {
      const name = typeof input === 'string' ? input : input?.store;
      const entry = STORE_REGISTRY.find((s) => s.store === name);
      if (!entry) continue; // unknown names are ignored — the check is the authority
      blockedNames.add(name);
      if (input && typeof input === 'object') {
        blockedDetails.set(name, {
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.diagnosticId ? { diagnosticId: input.diagnosticId } : {}),
        });
      }
      const physical = /** @type {{ kvKeys?: string[], kvPrefixes?: string[],
        idbStores?: string[] } | undefined} */ (
        /** @type {any} */ (entry)?.physical);
      if (!physical) continue;
      for (const key of physical.kvKeys ?? []) blockedKvKeys.set(key, name);
      blockedKvPrefixes = blockedKvPrefixes.concat(
        (physical.kvPrefixes ?? []).map((p) => /** @type {[string, string]} */ ([p, name])));
      for (const os of physical.idbStores ?? []) blockedIdbStores.set(os, name);
    }
  };

  /** @param {string} store @param {string} target */
  const readOnlyError = (store, target) =>
    new StoreReadOnlyError(store, target, blockedDetails.get(store));

  /** @param {string} key @returns {string | undefined} blocking store name */
  const kvBlockedBy = (key) => {
    const exact = blockedKvKeys.get(key);
    if (exact) return exact;
    const prefix = blockedKvPrefixes.find(([p]) => key.startsWith(p));
    return prefix?.[1];
  };

  /**
   * Wrap the chrome.storage.local kv adapter. set/delete refuse for blocked
   * targets; get/list/clear pass through (clear is the user's own explicit
   * reset surface, not a store mutation this guard arbitrates).
   * @template {{ set: Function, delete?: Function }} KV
   * @param {KV} kv @returns {KV}
   */
  const wrapKv = (kv) => /** @type {KV} */ ({
    ...kv,
    set: (/** @type {string} */ key, /** @type {unknown} */ value) => {
      const store = kvBlockedBy(key);
      if (store) throw readOnlyError(store, `kv:${key}`);
      return kv.set(key, value);
    },
    ...(typeof kv.delete === 'function' ? {
      delete: (/** @type {string} */ key) => {
        const store = kvBlockedBy(key);
        if (store) throw readOnlyError(store, `kv:${key}`);
        return /** @type {Function} */ (kv.delete)(key);
      },
    } : {}),
  });

  // The idb namespace's write verbs, all (storeName, ...) shaped.
  const IDB_WRITE_VERBS = Object.freeze(['put', 'del', 'clear', 'delUpTo', 'write']);

  /**
   * Wrap the idb module namespace (or any object exposing the same
   * (store, ...) verbs). Write verbs refuse for blocked object stores.
   * @template {Record<string, any>} IDB
   * @param {IDB} idb @returns {IDB}
   */
  const wrapIdb = (idb) => {
    /** @type {Record<string, any>} */
    const wrapped = { ...idb };
    for (const verb of IDB_WRITE_VERBS) {
      const original = idb[verb];
      if (typeof original !== 'function') continue;
      wrapped[verb] = (/** @type {string} */ objectStore, /** @type {any[]} */ ...rest) => {
        const store = blockedIdbStores.get(objectStore);
        if (store) throw readOnlyError(store, `idb:${objectStore}`);
        return original(objectStore, ...rest);
      };
    }
    return /** @type {IDB} */ (wrapped);
  };

  /**
   * Wrap an idbKV single-blob adapter for a given object store.
   * @param {string} objectStore
   * @param {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void> }} adapter
   */
  const wrapIdbKvAdapter = (objectStore, adapter) => ({
    ...adapter,
    set: (/** @type {string} */ key, /** @type {unknown} */ value) => {
      const store = blockedIdbStores.get(objectStore);
      if (store) throw readOnlyError(store, `idb:${objectStore}/${key}`);
      return adapter.set(key, value);
    },
  });

  const blockedStores = () => [...blockedNames];

  /**
   * The gate for SELF-HOSTED stores (own databases the adapters can't
   * reach — skills, app bodies): injected into those stores' mutators so
   * the same schema verdict refuses their writes too. Throws when blocked.
   * @param {string} storeName
   */
  const assertWritable = (storeName) => {
    if (blockedNames.has(storeName)) {
      throw readOnlyError(storeName, `self-hosted:${storeName}`);
    }
  };

  return { block, wrapKv, wrapIdb, wrapIdbKvAdapter, blockedStores, assertWritable };
};
