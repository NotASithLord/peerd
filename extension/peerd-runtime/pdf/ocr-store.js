// @ts-check
// ocr-store — fetch, verify, and cache the OPT-IN OCR engine assets.
//
// This is the Moonshine-voice download pattern (peerd-runtime/voice/
// model-store.js), applied to OCR: the heavy engine for scanned PDFs is NOT
// shipped in the box. The user opts in from Settings → Voice & OCR; we
// stream the assets down with progress, SHA-384 SRI-verify each one, and
// cache it in IndexedDB. The offscreen extractor then reads the cached bytes
// (a cache hit) when it needs to OCR a page.
//
// Lifecycle (per asset): IDB lookup → SRI match → return cached, else
// download → verify → cache. SRI mismatch throws and does NOT cache.
//
// Note on `fetch`: like voice/model-store.js this calls bare `fetch` (ESLint
// no-restricted-globals exception). The URLs are a hardcoded, commit-pinned
// table; they're DATA fetches with no secret material, and the SRI check
// makes each response self-verifying. Added to the eslint exception list
// alongside voice/model-store.js.

import { OcrDownloadError, OcrSriMismatchError, OcrUnavailableError } from './errors.js';
import { bytesToBase64 } from '/shared/util.js';

const DB_NAME = 'peerd-pdf';
const STORE_NAME = 'ocr-assets';
const DB_VERSION = 1;

/**
 * @typedef {Object} OcrAssetSpec
 * @property {string} name      role within the engine ('core-wasm', 'lang-eng', ...)
 * @property {string} url       absolute fetch URL (commit-pinned)
 * @property {string|null} sri  expected SHA-384 in SRI form ('sha384-<base64>'); null = unpinned
 * @property {number} [sizeBytes]
 */

/**
 * @typedef {Object} OcrCacheEntry  a stored asset record (IDB keyPath: url)
 * @property {string} url
 * @property {string|null} sri
 * @property {ArrayBuffer} bytes
 * @property {number} [sizeBytes]
 * @property {number} [cachedAt]
 */

// The OCR engine assets. peerd's OCR path renders a page to a bitmap and
// recognizes glyphs with a vendored WASM recognizer (Tesseract — its core
// WASM + a language model). These URLs are commit-pinned; the SRIs are pinned
// by running scripts/compute-ocr-sri.sh and pasting the result. Until they're
// pinned, every `sri` is null and PRODUCTION REFUSES to download (fail-closed),
// exactly like voice shipped before its hashes were computed — the engine
// picker reports "OCR unavailable" instead of offering a button that throws.
//
// why English only to start: the traineddata is ~per-language and large; we
// ship the one most-requested model and add a language picker later (the
// catalog shape already supports more rows).
export const OCR_ASSETS = Object.freeze([
  // sizeBytes are exact (from the pinned download); the SRI is the gate.
  // URLs are EXACT-version-pinned (not @6/@1) so the SRI stays valid — a
  // range URL would drift to a new upstream build and break verification.
  // To bump: edit the version, re-run scripts/compute-ocr-sri.sh, paste both.
  { name: 'core-wasm', url: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.1.2/tesseract-core-simd.wasm', sri: 'sha384-3KUztdriXAMWnnOO86COcQ5Zc5fInO+vnpQux5nZqGa6xgZGOv6povhaewDn1/8G', sizeBytes: 3_469_078 },
  { name: 'lang-eng',  url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz', sri: 'sha384-JI+fraGAoc5GBGIliuqzHRnP1nJyrukg5ggNSBv/TO+YOVj+6Te6XXQOx7ia10xq', sizeBytes: 2_952_873 },
]);

export const OCR_TOTAL_BYTES = OCR_ASSETS.reduce((s, a) => s + (a.sizeBytes ?? 0), 0);

/**
 * Are the OCR SRIs pinned (i.e. is OCR actually shippable)? Until
 * scripts/compute-ocr-sri.sh is run and the hashes pasted into OCR_ASSETS,
 * every `sri` is null and production refuses the download. The settings UI
 * uses this to hide the download button (vs. offering one that throws).
 * Flips automatically once SRIs are pinned. Pure.
 *
 * @returns {boolean}
 */
export const hasValidOcrSris = () => OCR_ASSETS.some((a) => a.sri != null);

/**
 * Factory mirroring voice's createModelStore: production calls createOcrStore()
 * and uses the returned object; tests inject in-memory `idb` + `fetchFn`.
 *
 * @param {Object} [deps]
 * @param {object|null} [deps.idb]
 * @param {typeof fetch} [deps.fetchFn]
 * @param {typeof crypto} [deps.cryptoApi]
 * @param {{warn:(...a:any[])=>void}} [deps.logger]
 * @param {(entry: {url:string}) => Promise<void>} [deps.audit]
 * @param {OcrAssetSpec[]} [deps.assets]  asset list to manage (default OCR_ASSETS)
 */
export const createOcrStore = (deps = {}) => {
  const {
    fetchFn = (typeof fetch !== 'undefined' ? fetch : null),
    cryptoApi = (typeof crypto !== 'undefined' ? crypto : null),
    logger = console,
    audit = async () => {},
    // The asset list to manage. Defaults to the shipped OCR_ASSETS; tests
    // inject a fake list (own URLs/SRIs) the same way they inject idb/fetchFn.
    assets = OCR_ASSETS,
  } = deps;

  let idbPromise = deps.idb !== undefined ? Promise.resolve(deps.idb) : null;
  const idb = () => idbPromise ?? (idbPromise = openDb());

  /**
   * Is the FULL engine present in the cache (every asset, SRI-matched)? Cheap
   * read — the settings UI and the offscreen extractor call this to decide
   * whether OCR is usable without triggering a download.
   *
   * @param {{ dev?: boolean }} [opts]
   * @returns {Promise<boolean>}
   */
  const isInstalled = async ({ dev = false } = {}) => {
    // Independent IDB reads — fetch them concurrently, then check.
    const cached = await Promise.all(assets.map((a) => readAsset(a.url)));
    return assets.every((asset, i) => {
      const c = cached[i];
      return c && (c.sri === asset.sri || (asset.sri === null && dev));
    });
  };

  /**
   * Download (or load cached) every OCR asset. Resolves with
   * { files: { [name]: ArrayBuffer } }.
   *
   * @param {Object} [opts]
   * @param {(p:number)=>void} [opts.onProgress]  0..1 across all assets
   * @param {boolean} [opts.dev]   permit null SRI (loud warning); prod = false
   * @param {AbortSignal} [opts.signal]
   */
  const getEngine = async (opts = {}) => {
    const totalBytes = assets.reduce((s, a) => s + (a.sizeBytes ?? 0), 0) || 1;
    let downloaded = 0;
    /** @type {Record<string, ArrayBuffer>} */
    const files = {};

    // Read every asset's cache entry up front (independent IDB reads), then walk
    // the list — only the actual downloads need to be sequential (progress).
    const cachedAll = await Promise.all(assets.map((a) => readAsset(a.url)));

    for (let i = 0; i < assets.length; i += 1) {
      const asset = assets[i];
      const cached = cachedAll[i];
      if (cached && (cached.sri === asset.sri || (asset.sri === null && opts.dev))) {
        files[asset.name] = cached.bytes;
        downloaded += cached.bytes.byteLength;
        opts.onProgress?.(Math.min(1, downloaded / totalBytes));
        continue;
      }
      if (cached) await deleteAsset(asset.url);

      if (asset.sri === null && !opts.dev) {
        throw new OcrUnavailableError(
          `OCR asset ${asset.name} has no pinned SRI hash. Run scripts/compute-ocr-sri.sh `
          + 'and paste the result into OCR_ASSETS, or pass {dev:true} for local development.',
        );
      }

      audit({ url: asset.url }).catch(() => {});
      const bytes = await downloadAsset(asset, {
        onPartial: (/** @type {number} */ n) => { downloaded += n; opts.onProgress?.(Math.min(1, downloaded / totalBytes)); },
        signal: opts.signal,
      });
      await verifySri(bytes, asset, opts);
      await writeAsset(asset.url, { sri: asset.sri, bytes });
      files[asset.name] = bytes;
    }
    return { files };
  };

  // ---- helpers (parallel to voice/model-store.js) ---------------------------

  /**
   * @param {OcrAssetSpec} asset
   * @param {{ onPartial?: (n:number)=>void, signal?: AbortSignal }} cb
   * @returns {Promise<ArrayBuffer>}
   */
  const downloadAsset = async (asset, { onPartial, signal }) => {
    if (!fetchFn) throw new OcrDownloadError('no fetch available in this context');
    let res;
    try {
      res = await fetchFn(asset.url, { signal });
    } catch (e) {
      throw new OcrDownloadError(`network failure for ${asset.url}: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
    }
    if (!res.ok) throw new OcrDownloadError(`HTTP ${res.status} for ${asset.url}`, { status: res.status });
    if (!res.body || typeof res.body.getReader !== 'function') {
      const buf = await res.arrayBuffer();
      onPartial?.(buf.byteLength);
      return buf;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onPartial?.(value.byteLength);
    }
    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out.buffer;
  };

  /**
   * @param {ArrayBuffer} bytes
   * @param {OcrAssetSpec} asset
   * @param {{ dev?: boolean }} [opts]
   */
  const verifySri = async (bytes, asset, opts) => {
    if (!asset.sri) {
      if (opts?.dev) {
        logger.warn?.(`[pdf/ocr-store] using ${asset.url} without SRI verification (dev mode).`);
        return;
      }
      throw new OcrUnavailableError(`OCR asset ${asset.url} has no pinned SRI hash.`);
    }
    if (!cryptoApi?.subtle?.digest) throw new OcrUnavailableError('crypto.subtle.digest unavailable.');
    const digest = await cryptoApi.subtle.digest('SHA-384', bytes);
    const actual = `sha384-${bytesToBase64(new Uint8Array(digest))}`;
    if (actual !== asset.sri) throw new OcrSriMismatchError({ url: asset.url, expected: asset.sri, actual });
  };

  /**
   * @param {string} url
   * @returns {Promise<OcrCacheEntry|null>}
   */
  const readAsset = async (url) => {
    const db = await idb();
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(url);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  };

  /**
   * @param {string} url
   * @param {{ sri: string|null, bytes: ArrayBuffer }} entry
   * @returns {Promise<void>}
   */
  const writeAsset = async (url, { sri, bytes }) => {
    const db = await idb();
    if (!db) return;
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).put({ url, sri, bytes, sizeBytes: bytes.byteLength, cachedAt: Date.now() });
      req.onsuccess = () => resolve(undefined);
      req.onerror = () => reject(req.error);
    }));
  };

  /**
   * @param {string} url
   * @returns {Promise<void>}
   */
  const deleteAsset = async (url) => {
    const db = await idb();
    if (!db) return;
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).delete(url);
      req.onsuccess = () => resolve(undefined);
      req.onerror = () => reject(req.error);
    }));
  };

  return Object.freeze({ getEngine, isInstalled });
};

const openDb = () => new Promise((resolve) => {
  if (typeof indexedDB === 'undefined') return resolve(null);
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'url' });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => resolve(null);
});
