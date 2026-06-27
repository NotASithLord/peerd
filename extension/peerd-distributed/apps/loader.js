// @ts-check
// peerd-distributed/apps/loader.js — verified bundle → engine App.
//
// Phase 0 built fetch + verify; this is the missing last mile: turn a
// verified `app`-type bundle into an installed App the existing engine
// runtime opens in its sandbox (NORTH-STAR beat 1 — install-from-peer).
// The single biggest reuse in the module: we do not build an app runtime,
// we feed the existing one (ARCHITECTURE §4.4).
//
// Trust posture: fetchBundle already verified the manifest hash, the
// manifest signature, and every chunk hash. This file RE-verifies the
// manifest commitment anyway (cheap, and fail-closed against a future
// caller that skips fetchBundle), then validates the SHAPE: an `app`
// bundle with a present entry file, bounded file count and size. The
// install itself is INJECTED — the SW route or page supplies it — so the
// loader stays pure logic over bytes.

import { manifestHash, verifyManifest } from '../content/manifest.js';
import { unpackBundleText } from '../content/bundle.js';

// The dweb-install ceiling is SEPARATE from the agent's app_create cap (2 MB /
// 64 files): a peer-installed app may carry WASM + assets, so it gets a larger
// bound (the "big apps" case). It is still bounded — a malicious bundle
// can't be unbounded — and the Library warns from the card's `size` before the
// fetch even starts. why 50 MB / 256 files: WASM-friendly, still well under what
// a swarm fetch + OPFS store handle comfortably.
const MAX_TOTAL_CHARS = 50_000_000;
const MAX_FILES = 256;

export class BundleRejectedError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`app bundle rejected: ${reason}`);
    this.name = 'BundleRejectedError';
  }
}

/**
 * Validate a fetched bundle and hand it to `install`.
 *
 * @param {{
 *   uri: string,
 *   manifest: any,
 *   payload: Uint8Array,
 *   install: (app: {
 *     name: string,
 *     files: Record<string, string>,
 *     entryFile: string,
 *     dweb: { uri: string, publisher: string | null, hash: string,
 *             version_id: string, dwapp_id?: string, slug?: string, seq?: number },
 *   }) => Promise<any>,
 *   name?: string,
 *   dwappId?: string | null,
 *   slug?: string | null,
 *   seq?: number | null,
 * }} opts
 * @returns {Promise<any>} whatever `install` resolves to (the app record)
 */
export const installAppBundle = async ({ uri, manifest, payload, install, name, dwappId = null, slug = null, seq = null }) => {
  // Re-verify the commitment chain even though fetchBundle already did.
  const hash = await manifestHash(manifest);
  const v = await verifyManifest(manifest);
  if (!v.ok) throw new BundleRejectedError(`manifest signature invalid: ${v.reason}`);
  if (manifest.type !== 'app') throw new BundleRejectedError(`not an app bundle: ${manifest.type}`);

  let unpacked;
  try {
    unpacked = unpackBundleText(payload);
  } catch (e) {
    throw new BundleRejectedError(`malformed bundle: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
  }
  const { entry, files } = unpacked;
  const paths = Object.keys(files);
  if (!paths.length) throw new BundleRejectedError('empty bundle');
  if (paths.length > MAX_FILES) throw new BundleRejectedError(`too many files: ${paths.length} > ${MAX_FILES}`);
  // why the explicit !entry: an undefined entry was already rejected by the
  // `in` check (no "undefined" key); naming it lets TS narrow entry to string.
  if (!entry || !(entry in files)) throw new BundleRejectedError(`entry file missing: ${entry}`);
  for (const p of paths) {
    // OPFS paths are flat-relative; a bundle must not climb out of its dir.
    if (p.startsWith('/') || p.split('/').includes('..')) {
      throw new BundleRejectedError(`unsafe path in bundle: ${p}`);
    }
  }
  const total = Object.values(files).reduce((n, c) => n + c.length, 0);
  if (total > MAX_TOTAL_CHARS) throw new BundleRejectedError(`bundle too large: ${total} chars`);

  return install({
    name: name ?? manifest.name ?? `peerd app ${hash.slice(0, 8)}`,
    files,
    entryFile: entry,
    // hash IS the version id (the bundle's manifest hash). dwapp_id/slug/seq come
    // from the discovery card the user installed FROM — persisting them lets the
    // Library spot a newer card (same dwapp_id, higher seq, different version_id)
    // and offer an update. They're optional: a cold DHT install (no card) still
    // works, it just can't be version-tracked until a card arrives.
    dweb: {
      uri, publisher: manifest.publisher ?? null, hash, version_id: hash,
      ...(dwappId ? { dwapp_id: dwappId } : {}),
      ...(slug ? { slug } : {}),
      ...(Number.isInteger(seq) ? { seq: /** @type {number} */ (seq) } : {}),
    },
  });
};
