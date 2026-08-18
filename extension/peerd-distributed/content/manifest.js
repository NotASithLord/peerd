// @ts-check
// peerd-distributed/content/manifest.js — signed manifests (PROTOCOL §4.2).
//
// The manifest is the addressable root of a bundle. It commits to the
// ordered list of chunk hashes, so the manifest signature transitively
// covers every byte. The content hash (the peerd:// address) is
// SHA-256(JCS(manifest without sig)) — stable whether or not the bundle
// is signed.
//
// The unsigned build + hash moved to /shared/bundle/manifest.js
// (DESIGN-10: .peerd exports must work in store packages, which prune
// this module). What stays HERE is exactly the identity layer: signing
// during build, and signature verification — the dweb wedge.
//
// why a domain tag: every signature in peerd is over
// `ASCII(tag) || 0x00 || payload` so a signature for one purpose can't be
// replayed as another (PROTOCOL "conventions").

import {
  utf8, concat, toBase64, fromBase64, base64ByteLength,
} from '/shared/bundle/bytes.js';
import { CHUNK_SIZE } from '/shared/bundle/chunk.js';
import {
  buildManifest as buildUnsignedManifest,
  canonicalManifestBytes,
  manifestHash,
} from '/shared/bundle/manifest.js';
import { MAX_NETWORK_BUNDLE_BYTES } from '/shared/bundle/bundle.js';
import { assertBundleTransportDescriptor } from '/shared/bundle/transport.js';
import { verifySignature } from '../identity/keypair.js';

/** @typedef {import('/shared/bundle/manifest.js').Manifest} Manifest */

/** @param {Manifest} manifest */
const signingBytes = (manifest) =>
  concat(
    utf8(manifest.v === 2 ? 'peerd/manifest/v2' : 'peerd/manifest/v1'),
    Uint8Array.from([0]),
    canonicalManifestBytes(manifest),
  );

export { manifestHash };

// why a cap before buffering: a bundle is fetched and reassembled fully in
// memory before the loader's decoded storage checks can fire. The publisher
// signs their OWN manifest, so the hash + signature checks do NOT bound its
// size — a hostile manifest can declare a multi-GB payload, or a short chunk
// list whose entries all reference ONE chunk so reassembly amplifies it
// thousand-fold. Bound it on the FETCH path, before any chunk is pulled.
// The shared bundle codec owns this packed network limit. The App loader owns
// the separate decoded storage limits applied after bounded unpacking.
export const MAX_BUNDLE_BYTES = MAX_NETWORK_BUNDLE_BYTES;
export const MAX_BUNDLE_CHUNKS = Math.ceil(MAX_BUNDLE_BYTES / CHUNK_SIZE);
export const MAX_MANIFEST_BYTES = 256_000;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/** @param {Uint8Array} payload @param {number} [maxBytes] */
export const assertBundlePayloadWithinLimits = (payload, maxBytes = MAX_BUNDLE_BYTES) => {
  if (!(payload instanceof Uint8Array)) throw new Error('bundle payload must be bytes');
  if (payload.byteLength > maxBytes) {
    throw new Error(`bundle too large: payload is ${payload.byteLength} > ${maxBytes} bytes`);
  }
  return payload.byteLength;
};

/**
 * Reject an over-large or amplified manifest BEFORE any chunk is fetched or the
 * payload is reassembled. Sums the declared chunk sizes over EVERY entry
 * (duplicates included — reassembly maps over all of manifest.chunks, so N refs
 * to one chunk reassemble to N×size even though the chunk is fetched once), and
 * binds manifest.size to that sum so the size field cannot under-report to slip
 * past a naive size check. A legit manifest never trips this: chunks are
 * non-overlapping slices, so size === sum(chunk.size) by construction.
 *
 * @param {Manifest} manifest
 */
export const assertBundleWithinLimits = (manifest) => {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest malformed');
  let encoded;
  try { encoded = JSON.stringify(manifest); }
  catch { throw new Error('manifest is not JSON-serializable'); }
  if (new TextEncoder().encode(encoded).byteLength > MAX_MANIFEST_BYTES) {
    throw new Error('manifest exceeds the wire ceiling');
  }
  const chunks = manifest?.chunks;
  if (!Array.isArray(chunks)) throw new Error('manifest has no chunk list');
  if (chunks.length > MAX_BUNDLE_CHUNKS) {
    throw new Error(`bundle has too many chunks: ${chunks.length} > ${MAX_BUNDLE_CHUNKS}`);
  }
  /** @type {Array<[string, number]>} */
  const stringFields = [['type', 32], ['mime', 128], ['entry', 512], ['publisher', 256], ['sig', 512]];
  for (const [field, cap] of stringFields) {
    const value = manifest[field];
    if (value != null && (typeof value !== 'string' || value.length > cap)) {
      throw new Error(`manifest ${field} invalid`);
    }
  }
  let declared = 0;
  /** @type {Map<string, number>} */
  const sizesByHash = new Map();
  for (const c of chunks) {
    if (!c || typeof c !== 'object' || !SHA256_HEX.test(c.hash)) throw new Error('manifest chunk hash invalid');
    const size = c?.size;
    if (!Number.isSafeInteger(size) || size <= 0 || size > CHUNK_SIZE) {
      throw new Error('manifest chunk size invalid');
    }
    const hash = c?.hash;
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error('manifest chunk hash invalid');
    }
    const priorSize = sizesByHash.get(hash);
    if (priorSize !== undefined && priorSize !== size) {
      throw new Error('duplicate manifest chunk has inconsistent sizes');
    }
    sizesByHash.set(hash, size);
    declared += size;
    if (declared > MAX_BUNDLE_BYTES) {
      throw new Error(`bundle too large: chunks declare more than ${MAX_BUNDLE_BYTES} bytes`);
    }
  }
  if (typeof manifest.size !== 'number' || !Number.isSafeInteger(manifest.size) || manifest.size < 0 || manifest.size !== declared) {
    throw new Error(`manifest size ${manifest?.size} does not match its chunk list (${declared})`);
  }
  if (manifest.v === 2) {
    assertBundleTransportDescriptor(manifest.bundle, {
      compressedSize: manifest.size,
      maxCompressedBytes: MAX_BUNDLE_BYTES,
    });
  } else if ((manifest.v !== undefined && manifest.v !== 1) || manifest.bundle !== undefined) {
    throw new Error('manifest bundle transport version invalid');
  }
};

/**
 * Decode one wire chunk only after its cheap string-length commitment passes.
 * This keeps a hostile base64 string from reaching the validator or allocator
 * when its manifest claims a much smaller chunk.
 *
 * @param {unknown} encoded
 * @param {number} expectedSize
 */
export const decodeCommittedChunk = (encoded, expectedSize) => {
  if (!Number.isInteger(expectedSize) || expectedSize <= 0 || expectedSize > CHUNK_SIZE) {
    throw new Error('committed chunk size invalid');
  }
  if (typeof encoded !== 'string') throw new Error('chunk bytes must be base64');
  const expectedCharacters = 4 * Math.ceil(expectedSize / 3);
  if (encoded.length !== expectedCharacters) throw new Error('chunk encoded length mismatch');
  if (base64ByteLength(encoded) !== expectedSize) throw new Error('chunk decoded length mismatch');
  const bytes = fromBase64(encoded);
  if (bytes.byteLength !== expectedSize) throw new Error('chunk decoded length mismatch');
  return bytes;
};

/**
 * Build (and optionally sign) a manifest for a payload.
 *
 * Returns { manifest, hash, chunks } where chunks are the Uint8Array
 * pieces to hand to the content store.
 *
 * @param {{
 *   payload: Uint8Array,
 *   type?: 'app' | 'data' | 'message',
 *   mime?: string,
 *   entry?: string,
 *   meta?: Record<string, any>,
 *   bundle?: import('/shared/bundle/transport.js').BundleTransportDescriptor,
 *   identity?: { did: string, sign: (bytes: Uint8Array) => Promise<Uint8Array> } | null,
 *   now?: () => number,
 * }} opts     required — payload has no default; a zero-arg call crashes
 *   payload  — the bundle bytes
 *   identity — omit (null) for a pure content-addressed manifest
 *   now      — injected clock (testability)
 */
export const buildManifest = async ({
  payload,
  type,
  mime,
  entry,
  meta,
  bundle,
  identity = null,
  now,
} = /** @type {{ payload: Uint8Array }} */ ({})) => {
  const { manifest: unsigned, chunks } = await buildUnsignedManifest({
    payload, type, mime, entry, meta, bundle, now,
  });

  // why publisher rides the BASE before signing: the signature must
  // cover the publisher claim itself, or anyone could re-attribute a
  // signed manifest.
  const base = {
    ...unsigned,
    ...(identity ? { publisher: identity.did } : {}),
  };

  /** @type {typeof base & { publisher?: string, sig?: string }} */
  let manifest = base;
  if (identity) {
    const sig = await identity.sign(signingBytes(base));
    manifest = { ...base, sig: toBase64(sig) };
  }

  const hash = await manifestHash(manifest);
  return { manifest, hash, chunks };
};

// Verify a manifest's signature. Pure content-addressed manifests (no
// publisher) are trivially "ok" — there is no author to authenticate;
// integrity comes from the content hash matching (checked by the caller).
/**
 * @param {Manifest | null | undefined} manifest
 * @returns {Promise<{ ok: true, publisher: string | null } | { ok: false, reason: string }>}
 */
export const verifyManifest = async (manifest) => {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, reason: 'malformed' };
  }
  if (!manifest.publisher) return { ok: true, publisher: null };
  if (!manifest.sig) return { ok: false, reason: 'missing_sig' };
  let ok = false;
  // why casts: publisher/sig are wire-decoded fields (open Manifest type);
  // a bad shape just throws into the catch below — validation IS runtime.
  const publisher = /** @type {string} */ (manifest.publisher);
  try {
    ok = await verifySignature(
      publisher,
      fromBase64(/** @type {string} */ (manifest.sig)),
      signingBytes(manifest),
    );
  } catch {
    return { ok: false, reason: 'verify_threw' };
  }
  return ok ? { ok: true, publisher } : { ok: false, reason: 'bad_sig' };
};
