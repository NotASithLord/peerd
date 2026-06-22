// @ts-check
// model-store — variant table + getModel variant coercion.
//
// Tests use an in-memory IDB mock so logic is exercised deterministically
// without network.

import { describe, it, expect } from '../../../framework.js';
import { createModelStore, MODEL_VARIANTS } from '/peerd-runtime/voice/model-store.js';

// IDBRequest-shaped object: model-store fires `onsuccess` / `onerror`
// after returning. We synthesize it synchronously for tests.
/** @param {unknown} result */
const req = (result) => {
  /** @type {{ result: unknown, onsuccess: (() => void) | null, onerror: (() => void) | null }} */
  const r = { result, onsuccess: null, onerror: null };
  queueMicrotask(() => r.onsuccess?.());
  return r;
};

// Tiny in-memory IDB mock matching the subset model-store uses. Cast to
// the IDBDatabase the store awaits — it only ever touches transaction().
const mockIdb = () => {
  /** @type {Map<string, { url: string }>} */
  const store = new Map();
  const txOf = () => ({
    objectStore: () => ({
      /** @param {string} key */
      get: (key) => req(store.get(key) ?? null),
      /** @param {{ url: string }} value */
      put: (value) => { store.set(value.url, value); return req(undefined); },
      /** @param {string} key */
      delete: (key) => { store.delete(key); return req(undefined); },
    }),
  });
  // why cast: createModelStore awaits deps.idb (Promise.resolve wraps a bare
  // value), but the dep's declared type is the openDb() promise. Hand it the
  // db object the store actually touches, typed as that promise.
  return /** @type {Promise<IDBDatabase | null>} */ (/** @type {unknown} */ ({ transaction: () => txOf() }));
};

describe('voice.model-store', () => {
  describe('variant table', () => {
    it('declares base with at least encoder + decoder', () => {
      // Moonshine ships only `tiny` and `base` upstream — `small` never
      // existed — and we pin `base` alone (see the MODEL_VARIANTS
      // comment in model-store.js).
      for (const variant of /** @type {const} */ (['base'])) {
        const v = MODEL_VARIANTS[variant];
        expect(v).toBeTruthy();
        const names = v.assets.map((a) => a.name);
        expect(names.includes('encoder')).toBe(true);
        expect(names.includes('decoder')).toBe(true);
      }
    });

    it('coerces a legacy/unknown variant to the shipped model', async () => {
      // Regression: an old install persisted voiceVariant:'small', a model
      // that never existed, and getModel('small') threw — the recurring
      // "Unknown voice model variant: small" crash. It must now resolve to
      // the one shipped model (base) instead. We point fetch at a 404 so
      // the call still fails, but reaching the DOWNLOAD path (not a
      // variant-name rejection) proves the coercion happened.
      const store = createModelStore({
        idb: mockIdb(),
        // why cast: a test fetch stub stands in for the full `typeof fetch`
        // surface (it never touches the static `preconnect` member).
        fetchFn: /** @type {typeof fetch} */ (/** @type {unknown} */ (
          async () => ({ ok: false, status: 404, body: null, arrayBuffer: async () => new ArrayBuffer(0) })
        )),
      });
      /** @type {unknown} */
      let err;
      try { await store.getModel('small'); }
      catch (e) { err = e; }
      // It reached the download path and failed THERE (a 404
      // ModelDownloadError) rather than rejecting on the variant name.
      expect(err).toBeTruthy();
      expect(/** @type {{ name?: string }} */ (err)?.name === 'ModelDownloadError').toBe(true);
    });
  });
});
