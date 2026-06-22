// @ts-check
// In-memory IDB mock matching the surface of peerd-egress/storage/idb.js
// (put/get/getAll/del plus the retention helpers count/getAllKeys/
// delUpTo/clear). Same shape; no transactions, no schema versioning, no
// async cursor — just a Map per store. Key-ordered reads are emulated by
// sorting, since IDB's b-tree ordering is what retention pruning leans on.
//
// Used by session-store and agent-loop tests so we don't have to spin
// up a real IndexedDB. The real wrapper has its own surface tests in the
// in-browser suite.

/** @returns {{
 *   put: (store: string, value: any) => Promise<void>,
 *   get: (store: string, key: IDBValidKey) => Promise<any>,
 *   getMany: (store: string, keys: string[]) => Promise<any[]>,
 *   getAll: (store: string) => Promise<any[]>,
 *   del: (store: string, key: IDBValidKey) => Promise<void>,
 *   count: (store: string) => Promise<number>,
 *   getAllKeys: (store: string, limit?: number) => Promise<IDBValidKey[]>,
 *   delUpTo: (store: string, key: IDBValidKey) => Promise<void>,
 *   clear: (store: string) => Promise<void>,
 *   _dump: () => Record<string, any[]>,
 * }} */
export const makeMockIdb = () => {
  /** @type {Map<string, Map<any, any>>} */
  const stores = new Map();

  /** @param {string} name */
  const ensure = (name) => {
    let s = stores.get(name);
    if (!s) { s = new Map(); stores.set(name, s); }
    return s;
  };

  // Match how IDB derives the in-store key from `keyPath`. We hardcode
  // the keyPaths used by the real schema rather than introspecting; the
  // mock only has to handle the stores we actually use.
  /** @type {Record<string, string>} */
  const keyPathFor = {
    sessions: 'sessionId',
    // v8 — per-message session records keyed by the message's own id.
    session_messages: 'id',
    audit_log: 'id',
    tool_grants: 'id',
    vm_state: 'key',
    agents_memory: 'id',
    vault: 'key',
    // v5 — engine catalogs (single-blob { key, value } records via idbKV).
    apps: 'key',
    notebooks: 'key',
    vms: 'key',
  };

  // IDB returns records in key order, not insertion order. Our keys are
  // strings, where JS default sort matches IDB's code-unit ordering.
  /** @param {string} name */
  const sortedKeys = (name) => [...ensure(name).keys()].sort();

  return {
    put: async (storeName, value) => {
      const kp = keyPathFor[storeName];
      const key = value?.[kp];
      ensure(storeName).set(key, structuredClone(value));
    },
    get: async (storeName, key) => {
      const v = ensure(storeName).get(key);
      return v ? structuredClone(v) : undefined;
    },
    getMany: async (storeName, keys) => {
      const s = ensure(storeName);
      return (keys ?? []).map((k) => {
        const v = s.get(k);
        return v ? structuredClone(v) : undefined;
      });
    },
    getAll: async (storeName) => {
      const s = ensure(storeName);
      return sortedKeys(storeName).map((k) => structuredClone(s.get(k)));
    },
    del: async (storeName, key) => {
      ensure(storeName).delete(key);
    },
    count: async (storeName) => ensure(storeName).size,
    getAllKeys: async (storeName, limit) => {
      const keys = sortedKeys(storeName);
      return limit === undefined ? keys : keys.slice(0, limit);
    },
    delUpTo: async (storeName, key) => {
      const s = ensure(storeName);
      for (const k of [...s.keys()]) if (k <= key) s.delete(k);
    },
    clear: async (storeName) => {
      ensure(storeName).clear();
    },
    _dump: () => {
      /** @type {Record<string, any[]>} */
      const out = {};
      for (const [name, store] of stores) {
        out[name] = [...store.values()].map((v) => structuredClone(v));
      }
      return out;
    },
  };
};
