// @ts-check
// chrome.storage.local wrapper.
//
// This is the only file in the project that calls browser.storage.local
// directly. Feature code talks to the wrapper, tests pass a mock kv
// (see tests/mocks/kv.js). By convention, `browser.storage.local` is
// not called outside this file and the SW chassis — feature code goes
// through the wrapper.
//
// Why a wrapper at all: chrome.storage.local has a slightly awkward
// "get returns an object keyed by the key you asked for" shape that we
// don't want to repeat in feature code, and we want a single seam for
// test mocks.
//
// Storage backend semantics this wrapper relies on:
//   - structured-clone roundtrip preserves Uint8Array/ArrayBuffer
//   - keys are strings
//   - ~10MB total quota per extension
//
// Anything that exceeds those bounds — large blobs, persistent queues —
// goes to IndexedDB via peerd-egress/storage/idb.js instead.

import browser from '/vendor/browser-polyfill.js';

/**
 * @typedef {Object} KV
 * @property {(key: string) => Promise<any>} get
 * @property {(key: string, value: any) => Promise<void>} set
 * @property {(key: string) => Promise<void>} delete
 * @property {(prefix?: string) => Promise<Record<string, any>>} list
 * @property {() => Promise<void>} clear
 */

/** @returns {KV} */
export const makeRealKV = () => ({
  get: async (key) => {
    const result = await browser.storage.local.get(key);
    return result[key];
  },
  set: async (key, value) => {
    await browser.storage.local.set({ [key]: value });
  },
  delete: async (key) => {
    await browser.storage.local.remove(key);
  },
  list: async (prefix) => {
    const all = await browser.storage.local.get(null);
    if (!prefix) return all;
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(prefix)) out[k] = v;
    }
    return out;
  },
  clear: async () => {
    await browser.storage.local.clear();
  },
});

/**
 * The production KV singleton. Feature code that doesn't take a kv via
 * dependency injection (i.e. small one-off helpers) imports this. Modules
 * with state or that are tested in isolation (the vault, the egress
 * allowlist) take a kv parameter instead.
 *
 * Only constructed when actually used to avoid touching browser.storage
 * at module-load time in test environments where it may not exist.
 *
 * @type {KV | null}
 */
let _real = null;
export const realKV = () => {
  if (!_real) _real = makeRealKV();
  return _real;
};
