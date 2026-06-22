// @ts-check
// model-store — fetch, verify, and cache Moonshine model assets.
//
// Architecture
// ------------
// The shipped `base` variant is a SET of assets: one or more .onnx files
// plus a tokenizer JSON. We cache per-URL in IndexedDB so bumping one
// file doesn't re-download the others.
//
// Lifecycle:
//   1. getModel(variant)
//   2. For each asset:
//      a. Look up by URL in IDB.
//      b. If present AND its stored SRI matches the variant's expected
//         SRI (or both are null and dev mode is on) → return cached.
//      c. Otherwise: download with streaming progress callbacks.
//      d. Verify SHA-384 against the variant's expected SRI:
//           - mismatch → throw SriMismatchError, do NOT cache.
//           - match    → cache + return.
//           - expected null AND dev:true → cache + return with warning.
//           - expected null AND !dev → throw VoiceUnsupportedError so
//                                       the UI surfaces a release-blocker.
//   3. getModel returns { files: { [name]: ArrayBuffer }, ... }
//
// Note on `fetch`
// ---------------
// This file calls bare `fetch` (banned elsewhere via ESLint's
// no-restricted-globals rule). The model URLs come from a hardcoded
// table; they're DATA fetches, not script execution. The egress
// concern that motivates the rule (provider-allowlist for model API
// calls) doesn't apply here — there's no secret material attached to
// the request, and the SRI check makes the response self-verifying.
// model-store.js is added to the eslint exception list alongside
// safe-fetch.js and the system-prompt loader.

import {
  ModelDownloadError,
  SriMismatchError,
  VoiceUnsupportedError,
} from './errors.js';
import { bytesToBase64 } from '/shared/util.js';

const DB_NAME = 'peerd-voice';
const STORE_NAME = 'assets';
const DB_VERSION = 1;

/**
 * @typedef {Object} AssetSpec
 * @property {string} name      role name within the variant ('encoder', 'tokenizer', ...)
 * @property {string} url       absolute fetch URL
 * @property {string|null} sri  expected SHA-384 in SRI form ('sha384-<base64>'); null = unverified
 * @property {number} [sizeBytes]
 */

/**
 * @typedef {Object} VariantSpec
 * @property {AssetSpec[]} assets
 * @property {number} sizeBytes      sum across assets (approx; for progress)
 */

/**
 * A cached asset row in IDB.
 * @typedef {Object} CachedAsset
 * @property {string} url
 * @property {string|null} sri
 * @property {ArrayBuffer} bytes
 * @property {number} [sizeBytes]
 * @property {number} [cachedAt]
 */

/**
 * Model variants. Each maps to the set of HF assets the offscreen
 * transcriber needs. The URLs are commit-pinned; bumping the commit
 * requires re-running scripts/compute-model-sri.sh and updating the
 * sri fields below. Until real hashes are pasted in, the entries are
 * null — see the `dev` flag rationale on getModel().
 */
// Moonshine ships ONLY `tiny` and `base` — there is no `small` (the earlier
// entry was fictional, with paths that 404, which is why the SRIs were never
// computed). We ship `base` (the larger, more accurate ONNX variant). URLs are
// pinned to a specific Hugging Face COMMIT (not the moving `main` branch) so the
// SRIs below stay valid. To add `tiny` (or bump the commit), download each file
// and run scripts/compute-model-sri.sh, then paste sri + sizeBytes here.
// Computed 2026-06 against commit 48b4e427b587bcf67797a5be706d6ddc4a298149.
const MOONSHINE_COMMIT = '48b4e427b587bcf67797a5be706d6ddc4a298149';
const MOONSHINE_BASE = `https://huggingface.co/UsefulSensors/moonshine/resolve/${MOONSHINE_COMMIT}`;

/** @type {Record<'base', VariantSpec>} */
export const MODEL_VARIANTS = Object.freeze({
  base: {
    sizeBytes: 250_791_877,
    assets: [
      // why: separate encoder / decoder mirrors the upstream Moonshine
      // packaging. The transcriber composes them at init time.
      { name: 'encoder',   url: `${MOONSHINE_BASE}/onnx/merged/base/float/encoder_model.onnx`,         sri: 'sha384-Ldxqd/tH/uvC03W9mdHoNQmhOWUTvWGl52RdJlwpxQZTyx3Rxc9JSNejFJPUhCzg' },
      { name: 'decoder',   url: `${MOONSHINE_BASE}/onnx/merged/base/float/decoder_model_merged.onnx`,  sri: 'sha384-AMjFqwM1cIi8O06+IAgla9p4CD1/kllZoTApptYJpy7GbwooW/5vuMOwwCKcl7Ox' },
      { name: 'tokenizer', url: `${MOONSHINE_BASE}/onnx/merged/base/float/tokenizer.json`,             sri: 'sha384-dFa+E3SIyjHWBSxoDHdZuDGg0Ka5bzE/18ucin6TzH8S1o/sx2cZVSC+2GqZZo7V' },
    ],
  },
});

// The single shipped model — derived from the table so it tracks whatever
// the one entry is, no magic string. getModel coerces any input to this.
const [SHIPPED_VARIANT] = Object.keys(MODEL_VARIANTS);

/**
 * Are the Moonshine model SRIs pinned (i.e. is local voice actually shippable)?
 * Until `scripts/compute-model-sri.sh` is run and the hashes pasted in, every
 * asset's `sri` is null and production REFUSES to download (fail-closed). The
 * engine picker uses this to fall back to Web Speech instead of offering a
 * Moonshine button that throws a developer error. Flips automatically once SRIs
 * are pinned — no other code change needed. Pure.
 *
 * @returns {boolean}
 */
export const hasValidModelSris = () => {
  for (const variant of Object.values(MODEL_VARIANTS)) {
    for (const asset of (variant.assets ?? [])) {
      if (asset.sri != null) return true;
    }
  }
  return false;
};

/**
 * Pluggable factory. Production calls `createModelStore()` and uses
 * the returned object; tests pass in-memory implementations of `idb`
 * and `fetchFn` to drive the logic without touching real APIs.
 *
 * @param {Object} [deps]
 * @param {ReturnType<typeof openDb> | null} [deps.idb]      promise-bound IDB wrapper
 * @param {typeof fetch} [deps.fetchFn]                       default: globalThis.fetch
 * @param {typeof crypto} [deps.cryptoApi]                    default: globalThis.crypto
 * @param {{warn:(...a:any[])=>void}} [deps.logger]          default: console
 * @param {(entry: { url: string, variant: string }) => Promise<void>} [deps.audit]
 *   outbound-fetch audit hook; no-op default
 */
export const createModelStore = (deps = {}) => {
  const {
    fetchFn = (typeof fetch !== 'undefined' ? fetch : null),
    cryptoApi = (typeof crypto !== 'undefined' ? crypto : null),
    logger = console,
    // why (#2): the model download is the one outbound call that doesn't go
    // through peerd-egress (it's a pinned, SRI-verified HF asset, so safeFetch's
    // allowlist / webFetch's denylist don't apply). It's fail-closed today (prod
    // refuses a null SRI) and SRI makes the bytes self-verifying — but "every
    // outbound call is recorded" still wants an audit entry. Injected here; the
    // caller wires it to the audit log. No-op default keeps tests/dev quiet.
    audit = async () => {},
  } = deps;

  let idbPromise = deps.idb !== undefined ? Promise.resolve(deps.idb) : null;
  const idb = () => idbPromise ?? (idbPromise = openDb());

  /**
   * Load the shipped model. Resolves with { files, sizeBytes, variant }
   * once every asset is downloaded, SRI-verified (or sanctioned via
   * dev), and cached.
   *
   * @param {string} [variant]  back-compat arg; coerced to the one shipped
   *   model, so a legacy/bogus value (e.g. 'small') loads `base` instead
   *   of throwing on an unknown variant.
   * @param {Object} [opts]
   * @param {(p:number)=>void} [opts.onProgress]  0..1 fraction across all assets
   * @param {boolean} [opts.dev]   permit null SRI; logs warnings
   * @param {AbortSignal} [opts.signal]
   */
  const getModel = async (variant, opts = {}) => {
    // One model ships; coerce anything to it (see SHIPPED_VARIANT). The
    // returned/audited `variant` is the resolved one so cache keys + the
    // manager's state stay consistent with what was actually fetched.
    const resolved = /** @type {keyof typeof MODEL_VARIANTS} */ (
      variant && MODEL_VARIANTS[/** @type {'base'} */ (variant)] ? variant : SHIPPED_VARIANT
    );
    const spec = MODEL_VARIANTS[resolved];

    const totalBytes = spec.sizeBytes || spec.assets.reduce((s, a) => s + (a.sizeBytes ?? 0), 0) || 1;
    let downloaded = 0;

    /** @type {Record<string, ArrayBuffer>} */
    const files = {};
    for (const asset of spec.assets) {
      const cached = await readAsset(asset.url);
      if (cached && (cached.sri === asset.sri || (asset.sri === null && opts.dev))) {
        files[asset.name] = cached.bytes;
        downloaded += cached.bytes.byteLength;
        opts.onProgress?.(Math.min(1, downloaded / totalBytes));
        continue;
      }
      // SRI changed since this asset was cached → drop the stale copy.
      if (cached) await deleteAsset(asset.url);

      if (asset.sri === null && !opts.dev) {
        throw new VoiceUnsupportedError(
          `Model ${resolved}/${asset.name} has no pinned SRI hash. Run scripts/compute-model-sri.sh `
          + `and paste the result into MODEL_VARIANTS, or pass {dev:true} for local development.`,
        );
      }

      // Record the outbound model fetch before it goes out (#2).
      audit({ url: asset.url, variant: resolved }).catch(() => {});
      const bytes = await downloadAsset(asset, {
        onPartial: (chunkBytes) => {
          downloaded += chunkBytes;
          opts.onProgress?.(Math.min(1, downloaded / totalBytes));
        },
        signal: opts.signal,
      });
      await verifySri(bytes, asset, opts);
      await writeAsset(asset.url, { sri: asset.sri, bytes });
      files[asset.name] = bytes;
    }
    return { files, sizeBytes: downloaded, variant: resolved };
  };

  // ---- helpers --------------------------------------------------------------

  /**
   * @param {AssetSpec} asset
   * @param {{ onPartial?: (n: number) => void, signal?: AbortSignal }} hooks
   * @returns {Promise<ArrayBuffer>}
   */
  const downloadAsset = async (asset, { onPartial, signal }) => {
    if (!fetchFn) throw new ModelDownloadError('no fetch available in this context');
    let res;
    try {
      res = await fetchFn(asset.url, { signal });
    } catch (e) {
      const msg = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
      throw new ModelDownloadError(`network failure for ${asset.url}: ${msg}`);
    }
    if (!res.ok) {
      throw new ModelDownloadError(`HTTP ${res.status} for ${asset.url}`, { status: res.status });
    }
    // Some response bodies (mock test responses, very small payloads on
    // older Safari) lack a stream. Fall through to arrayBuffer().
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
   * @param {AssetSpec} asset
   * @param {{ dev?: boolean }} [opts]
   */
  const verifySri = async (bytes, asset, opts) => {
    if (!asset.sri) {
      if (opts?.dev) {
        logger.warn?.(
          `[voice/model-store] using ${asset.url} without SRI verification (dev mode). `
          + 'Production releases MUST pin a hash.',
        );
        return;
      }
      throw new VoiceUnsupportedError(`Asset ${asset.url} has no pinned SRI hash.`);
    }
    if (!cryptoApi?.subtle?.digest) {
      throw new VoiceUnsupportedError('crypto.subtle.digest is unavailable in this context.');
    }
    const digest = await cryptoApi.subtle.digest('SHA-384', bytes);
    const actual = `sha384-${bytesToBase64(new Uint8Array(digest))}`;
    if (actual !== asset.sri) {
      throw new SriMismatchError({ url: asset.url, expected: asset.sri, actual });
    }
  };

  // IDB helpers — all promise-bound thin wrappers.
  /**
   * @param {string} url
   * @returns {Promise<CachedAsset | null>}
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
      const req = tx.objectStore(STORE_NAME).put({
        url, sri, bytes, sizeBytes: bytes.byteLength, cachedAt: Date.now(),
      });
      req.onsuccess = () => resolve();
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
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }));
  };

  return Object.freeze({
    getModel,
  });
};

/**
 * Open the per-extension IDB used for model caching. Returns null when
 * indexedDB isn't available (offscreen contexts where it's blocked,
 * older browsers); callers degrade gracefully — caching disabled but
 * downloads still work.
 */
const openDb = () => new Promise((resolve) => {
  if (typeof indexedDB === 'undefined') return resolve(null);
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { keyPath: 'url' });
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => resolve(null);
});
