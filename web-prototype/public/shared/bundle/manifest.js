// shared/bundle/manifest.js — content-addressed manifests, minus signing.
//
// The manifest is the addressable root of a bundle. It commits to the
// ordered list of chunk hashes, so the manifest hash transitively covers
// every byte. The content hash (the peerd:// address) is
// SHA-256(JCS(manifest without sig)) — stable whether or not the bundle
// is signed.
//
// why signing is NOT here: identity (Ed25519/did:key) is the dweb wedge
// and stays in the dweb module — store packages prune that module, and
// .peerd artifact exports (DESIGN-10) are deliberately UNSIGNED in v1
// (publisher/sig already optional in the manifest shape). The dweb's
// content/manifest.js layers the signature over the base built here.

import { canonicalize } from './canonical.js';
import { utf8 } from './bytes.js';
import { chunkBytes, sha256hex } from './chunk.js';

const withoutSig = (manifest) => {
  const { sig, ...rest } = manifest;
  return rest;
};

// The canonical bytes the hash (and, distribution-side, the signature)
// commits to: JCS of the manifest sans sig. Exported so the signing
// layer strips `sig` exactly the way hashing does.
export const canonicalManifestBytes = (manifest) =>
  utf8(canonicalize(withoutSig(manifest)));

// The peerd:// content hash: SHA-256 of the canonical manifest sans sig.
export const manifestHash = async (manifest) =>
  sha256hex(canonicalManifestBytes(manifest));

/**
 * Build an UNSIGNED manifest for a payload.
 *
 * Returns { manifest, hash, chunks } where chunks are the Uint8Array
 * pieces to hand to a content store or an export envelope.
 *
 * @param {{
 *   payload: Uint8Array,
 *   type?: string,
 *   mime?: string,
 *   entry?: string,
 *   meta?: Record<string, any>,
 *   now?: () => number,
 * }} opts     required — payload has no default; a zero-arg call crashes
 *   payload  — the bundle bytes
 *   meta     — small artifact-kind specifics (DESIGN-10); additive and
 *              optional, canonicalized + hashed like every other field
 *   now      — injected clock (testability)
 */
export const buildManifest = async ({
  payload,
  type = 'app',
  mime = 'application/peerd-app',
  entry,
  meta,
  now = Date.now,
} = {}) => {
  const pieces = chunkBytes(payload);
  const chunkMeta = await Promise.all(
    pieces.map(async (c) => ({ hash: await sha256hex(c), size: c.length })),
  );

  const manifest = {
    v: 1,
    type,
    mime,
    size: payload.length,
    ...(entry ? { entry } : {}),
    ...(meta ? { meta } : {}),
    chunks: chunkMeta,
    created: now(),
  };

  const hash = await manifestHash(manifest);
  return { manifest, hash, chunks: pieces };
};

/**
 * Verify a chunk list against the manifest's commitments: count, per-
 * chunk size + SHA-256, and the total payload size. This is the
 * signature-free half of bundle verification (the self-verifying part
 * of a .peerd file); authorship, when present, is checked by the
 * distribution-side verifyManifest.
 *
 * @param {{ size?: number, chunks?: Array<{ hash: string, size: number }> }} manifest
 * @param {Uint8Array[]} chunks
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export const verifyManifestChunks = async (manifest, chunks) => {
  if (!manifest || !Array.isArray(manifest.chunks) || !Number.isInteger(manifest.size)) {
    return { ok: false, reason: 'malformed-manifest' };
  }
  if (chunks.length !== manifest.chunks.length) {
    return { ok: false, reason: 'chunk-count-mismatch' };
  }
  let total = 0;
  for (let i = 0; i < chunks.length; i++) {
    const committed = manifest.chunks[i];
    if (!committed || chunks[i].length !== committed.size) {
      return { ok: false, reason: `chunk-size-mismatch:${i}` };
    }
    if (await sha256hex(chunks[i]) !== committed.hash) {
      return { ok: false, reason: `chunk-hash-mismatch:${i}` };
    }
    total += chunks[i].length;
  }
  if (total !== manifest.size) return { ok: false, reason: 'size-mismatch' };
  return { ok: true };
};
