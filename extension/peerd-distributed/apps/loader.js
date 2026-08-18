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

import { assertBundleWithinLimits, manifestHash, verifyManifest } from '../content/manifest.js';
import { unpackTransportBundle } from '../content/bundle.js';
import { chunkBytes, sha256hex } from '../content/chunk.js';
import { parsePeerdUri } from '../content/uri.js';

// The peer-install rails are enforced both before bundle decoding and again on
// the decoded file tree. Keep the live values beside the checks rather than in
// prose that drifts from the storage and publishing layers.
const MAX_TOTAL_BYTES = 50_000_000;
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
 *     files: Record<string, Uint8Array>,
 *     fileKinds: Record<string, 'text' | 'binary'>,
 *     entryFile: string,
 *     dweb: { uri: string, publisher: string | null, hash: string,
 *             version_id: string, dwapp_id?: string, slug?: string, seq?: number,
 *             published_hashes?: string[], previous_version_id?: string,
 *             source_git_oid?: string, changelog?: string },
 *   }) => Promise<any>,
 *   name?: string,
 *   dwappId?: string | null,
 *   slug?: string | null,
 *   seq?: number | null,
 *   expectedPublisher?: string | null,
 * }} opts
 * @returns {Promise<any>} whatever `install` resolves to (the app record)
 */
export const installAppBundle = async ({ uri, manifest, payload, install, name, dwappId = null, slug = null, seq = null, expectedPublisher = null }) => {
  // Re-verify the commitment chain even though fetchBundle already did.
  assertBundleWithinLimits(manifest);
  const hash = await manifestHash(manifest);
  const v = await verifyManifest(manifest);
  if (!v.ok) throw new BundleRejectedError(`manifest signature invalid: ${v.reason}`);
  if (manifest.type !== 'app') throw new BundleRejectedError(`not an app bundle: ${manifest.type}`);
  let addressedPublisher = null;
  let addressedHash = null;
  try {
    const addressed = parsePeerdUri(uri);
    addressedPublisher = addressed.did ?? null;
    addressedHash = addressed.hash ?? null;
  }
  catch (error) { throw new BundleRejectedError(/** @type {{message?:string}} */ (error)?.message ?? 'invalid URI'); }
  if (!addressedPublisher || typeof manifest.publisher !== 'string' || typeof manifest.sig !== 'string') {
    throw new BundleRejectedError('executable apps require an authored URI and signed publisher manifest');
  }
  if (addressedHash !== hash) throw new BundleRejectedError('manifest hash does not match its content address');
  const payloadChunks = chunkBytes(payload);
  if (payload.byteLength !== manifest.size || payloadChunks.length !== manifest.chunks.length) {
    throw new BundleRejectedError('payload does not match the signed manifest shape');
  }
  for (const [index, chunk] of payloadChunks.entries()) {
    if (chunk.byteLength !== manifest.chunks[index].size || await sha256hex(chunk) !== manifest.chunks[index].hash) {
      throw new BundleRejectedError(`payload chunk ${index} does not match the signed manifest`);
    }
  }
  // A signed card names an author namespace and an authored peerd:// URI names
  // the same signer. Refuse curator/payload substitution: otherwise a card from
  // A could silently install executable bytes signed by B while retaining A's
  // stable dwapp_id and future update stream.
  if (manifest.publisher !== addressedPublisher) {
    throw new BundleRejectedError('manifest publisher does not match its content address');
  }
  if (expectedPublisher && manifest.publisher !== expectedPublisher) {
    throw new BundleRejectedError('manifest publisher does not match the discovery card');
  }
  const release = manifest.meta?.release;
  if (release?.previousVersionId != null && !/^[a-f0-9]{64}$/.test(release.previousVersionId)) {
    throw new BundleRejectedError('release predecessor identity invalid');
  }
  if (release?.gitCommitOid != null && !/^[a-f0-9]{40}$/.test(release.gitCommitOid)) {
    throw new BundleRejectedError('release Git commit identity invalid');
  }
  if (release?.changelog != null && typeof release.changelog !== 'string') {
    throw new BundleRejectedError('release changelog invalid');
  }

  let unpacked;
  try {
    unpacked = await unpackTransportBundle({ manifest, payload, limits: {
      // v2's canonical JSON/base64 container is larger than the decoded OPFS
      // tree; transport.js owns its separately bounded framing ceiling.
      maxDecodedBytes: MAX_TOTAL_BYTES,
      maxFileBytes: MAX_TOTAL_BYTES,
      maxFiles: MAX_FILES,
      maxPathChars: 512,
    } });
  } catch (e) {
    throw new BundleRejectedError(`malformed bundle: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`);
  }
  const { entry, files, fileKinds } = unpacked;
  const paths = Object.keys(files);
  if (!paths.length) throw new BundleRejectedError('empty bundle');
  if (paths.length > MAX_FILES) throw new BundleRejectedError(`too many files: ${paths.length} > ${MAX_FILES}`);
  // why the explicit !entry: an undefined entry was already rejected by the
  // `in` check (no "undefined" key); naming it lets TS narrow entry to string.
  if (!entry || !Object.hasOwn(files, entry)) throw new BundleRejectedError(`entry file missing: ${entry}`);
  for (const p of paths) {
    // OPFS paths are flat-relative; a bundle must not climb out of its dir.
    if (p.startsWith('/') || p.split('/').includes('..')) {
      throw new BundleRejectedError(`unsafe path in bundle: ${p}`);
    }
  }
  const total = Object.values(files).reduce((n, bytes) => n + bytes.byteLength, 0);
  if (total > MAX_TOTAL_BYTES) throw new BundleRejectedError(`bundle too large: ${total} bytes`);

  return install({
    name: name ?? manifest.name ?? `peerd app ${hash.slice(0, 8)}`,
    files,
    fileKinds,
    entryFile: entry,
    // hash IS the version id (the bundle's manifest hash). dwapp_id/slug/seq come
    // from the discovery card the user installed FROM — persisting them lets the
    // Library spot a newer card (same dwapp_id, higher seq, different version_id)
    // and offer an update. They're optional: a cold DHT install (no card) still
    // works, it just can't be version-tracked until a card arrives.
    dweb: {
      uri, publisher: manifest.publisher ?? null, hash, version_id: hash,
      published_hashes: [hash],
      ...(dwappId ? { dwapp_id: dwappId } : {}),
      ...(slug ? { slug } : {}),
      ...(Number.isInteger(seq) ? { seq: /** @type {number} */ (seq) } : {}),
      ...(typeof manifest.meta?.release?.previousVersionId === 'string'
        ? { previous_version_id: manifest.meta.release.previousVersionId } : {}),
      ...(typeof manifest.meta?.release?.gitCommitOid === 'string'
        ? { source_git_oid: manifest.meta.release.gitCommitOid } : {}),
      ...(typeof manifest.meta?.release?.changelog === 'string'
        ? { changelog: manifest.meta.release.changelog.slice(0, 1200) } : {}),
    },
  });
};
