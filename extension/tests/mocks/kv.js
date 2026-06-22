// @ts-check
// In-memory KV mock matching the `KV` interface in peerd-egress/storage/kv.js.
//
// Used by tests that don't want to touch real chrome.storage.local.
// Exposes a `_dump()` helper so tests can inspect what's been stored
// (e.g. assert that plaintext didn't accidentally land there).

/** @returns {import('/peerd-egress/storage/kv.js').KV & { _dump: () => Map<string, any> }} */
export const makeMockKV = () => {
  const store = new Map();
  return {
    get: async (key) => store.get(key),
    set: async (key, value) => { store.set(key, value); },
    delete: async (key) => { store.delete(key); },
    list: async (prefix) => {
      /** @type {Record<string, any>} */
      const out = {};
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) out[k] = v;
      }
      return out;
    },
    clear: async () => { store.clear(); },
    _dump: () => new Map(store),
  };
};
