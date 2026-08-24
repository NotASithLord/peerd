// @ts-check
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
  /** @type {Map<string, string>} */
  const blockedKvKeys = new Map();
  /** @type {Array<[string, string]>} */
  let blockedKvPrefixes = [];
  /** @type {Map<string, string>} */
  const blockedIdbStores = new Map();

  /** @type {Set<string>} */
  const blockedNames = new Set();
  /** @type {Map<string, { reason?: string, diagnosticId?: string }>} */
  const blockedDetails = new Map();

  /** @param {Array<string | { store: string, reason?: string, diagnosticId?: string }>} stores */
  const block = (stores) => {
    for (const input of Array.isArray(stores) ? stores : []) {
      const name = typeof input === 'string' ? input : input?.store;
      const entry = STORE_REGISTRY.find((s) => s.store === name);
      if (!entry) continue;
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

  /** @param {string} key @returns {string|undefined} */
  const kvBlockedBy = (key) => {
    const exact = blockedKvKeys.get(key);
    if (exact) return exact;
    const prefix = blockedKvPrefixes.find(([p]) => key.startsWith(p));
    return prefix?.[1];
  };

  /** @template {{set:Function,delete?:Function}} KV @param {KV} kv @returns {KV} */
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

  const IDB_WRITE_VERBS = Object.freeze(['put', 'patch', 'del', 'clear', 'delUpTo', 'write']);

  /** @template {Record<string,any>} IDB @param {IDB} idb @returns {IDB} */
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
    if (typeof idb.transact === 'function') {
      wrapped.transact = (/** @type {string[]} */ objectStores,
        /** @type {Function} */ operation) => {
        for (const objectStore of objectStores ?? []) {
          const store = blockedIdbStores.get(objectStore);
          if (store) throw readOnlyError(store, `idb:${objectStore}`);
        }
        return idb.transact(objectStores, operation);
      };
    }
    return /** @type {IDB} */ (wrapped);
  };

  /** @param {string} objectStore
   * @param {{get:(key:string)=>Promise<any>,set:(key:string,value:any)=>Promise<void>}} adapter */
  const wrapIdbKvAdapter = (objectStore, adapter) => ({
    ...adapter,
    set: (/** @type {string} */ key, /** @type {unknown} */ value) => {
      const store = blockedIdbStores.get(objectStore);
      if (store) throw readOnlyError(store, `idb:${objectStore}/${key}`);
      return adapter.set(key, value);
    },
  });

  const blockedStores = () => [...blockedNames];

  /** @param {string} storeName */
  const assertWritable = (storeName) => {
    if (blockedNames.has(storeName)) {
      throw readOnlyError(storeName, `self-hosted:${storeName}`);
    }
  };

  return { block, wrapKv, wrapIdb, wrapIdbKvAdapter, blockedStores, assertWritable };
};
