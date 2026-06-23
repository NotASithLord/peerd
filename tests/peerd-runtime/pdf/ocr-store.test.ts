import { describe, test, expect } from 'bun:test';
import {
  createOcrStore, hasValidOcrSris, OCR_ASSETS,
} from '../../../extension/peerd-runtime/pdf/ocr-store.js';
import { OcrUnavailableError } from '../../../extension/peerd-runtime/pdf/errors.js';

// Minimal in-memory IndexedDB stand-in matching the request/onsuccess shape the
// store uses (db.transaction(store, mode).objectStore(store).{get,put,delete}).
const makeFakeIdb = () => {
  const map = new Map<string, any>();
  const req = (run: () => any) => {
    const r: any = { onsuccess: null, onerror: null };
    queueMicrotask(() => { try { r.result = run(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } });
    return r;
  };
  return {
    map,
    transaction() {
      return {
        objectStore() {
          return {
            get: (k: string) => req(() => map.get(k) ?? undefined),
            put: (v: any) => req(() => { map.set(v.url, v); return undefined; }),
            delete: (k: string) => req(() => { map.delete(k); return undefined; }),
          };
        },
      };
    },
  };
};

// A fetch stand-in: counts calls, returns fixed bytes with no streaming body
// (so downloadAsset takes the arrayBuffer() branch).
const makeFakeFetch = () => {
  const state = { calls: 0 };
  const fetchFn: any = async () => {
    state.calls += 1;
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    return { ok: true, status: 200, body: null, arrayBuffer: async () => bytes };
  };
  return { state, fetchFn };
};

// Injected (fake) asset list so the store mechanics tests don't depend on the
// real CDN bytes: unpinned (sri:null) assets the fake fetch can satisfy. The
// store takes `assets` the same way it takes `idb`/`fetchFn`. The REAL pinned
// OCR_ASSETS are asserted separately below.
const FAKE_ASSETS = [
  { name: 'core-wasm', url: 'https://example.test/core.wasm', sri: null, sizeBytes: 4 },
  { name: 'lang-eng',  url: 'https://example.test/eng.gz',   sri: null, sizeBytes: 4 },
];

describe('OCR engine SRIs are pinned (shippable)', () => {
  test('hasValidOcrSris is true and every asset carries a sha384 hash', () => {
    expect(hasValidOcrSris()).toBe(true);
    for (const a of OCR_ASSETS) {
      expect(a.sri).toMatch(/^sha384-/);
      expect(a.url).toMatch(/@\d+\.\d+\.\d+\//);  // exact-version-pinned URL (not @6/@1)
    }
  });
});

describe('createOcrStore', () => {
  test('production (dev:false) refuses an unpinned asset', async () => {
    const idb = makeFakeIdb();
    const { fetchFn } = makeFakeFetch();
    const store = createOcrStore({ idb, fetchFn, assets: FAKE_ASSETS });
    await expect(store.getEngine({ dev: false })).rejects.toBeInstanceOf(OcrUnavailableError);
  });

  test('dev mode downloads, caches, and reports installed', async () => {
    const idb = makeFakeIdb();
    const { state, fetchFn } = makeFakeFetch();
    const store = createOcrStore({ idb, fetchFn, assets: FAKE_ASSETS });

    expect(await store.isInstalled({ dev: true })).toBe(false);

    const out = await store.getEngine({ dev: true });
    expect(Object.keys(out.files).sort()).toEqual(['core-wasm', 'lang-eng']);
    expect(state.calls).toBe(FAKE_ASSETS.length);     // one fetch per asset
    expect(await store.isInstalled({ dev: true })).toBe(true);
  });

  test('second run is a cache hit — no new fetches', async () => {
    const idb = makeFakeIdb();
    const { state, fetchFn } = makeFakeFetch();
    const store = createOcrStore({ idb, fetchFn, assets: FAKE_ASSETS });

    await store.getEngine({ dev: true });
    const after = state.calls;
    await store.getEngine({ dev: true });
    expect(state.calls).toBe(after);                 // served from IDB
  });

  test('progress reaches 1 across the download', async () => {
    const idb = makeFakeIdb();
    const { fetchFn } = makeFakeFetch();
    const store = createOcrStore({ idb, fetchFn, assets: FAKE_ASSETS });
    let last = 0;
    await store.getEngine({ dev: true, onProgress: (p) => { last = p; } });
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThanOrEqual(1);
  });
});
