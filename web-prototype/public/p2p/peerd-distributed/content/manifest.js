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

import { utf8, concat, toBase64, fromBase64 } from '/shared/bundle/bytes.js';
import {
  buildManifest as buildUnsignedManifest,
  canonicalManifestBytes,
  manifestHash,
} from '/shared/bundle/manifest.js';
import { verifySignature } from '../identity/keypair.js';

const DOMAIN = 'peerd/manifest/v1';

const signingBytes = (manifest) =>
  concat(utf8(DOMAIN), Uint8Array.from([0]), canonicalManifestBytes(manifest));

export { manifestHash };

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
  identity = null,
  now,
} = {}) => {
  const { manifest: unsigned, chunks } = await buildUnsignedManifest({
    payload, type, mime, entry, meta, now,
  });

  // why publisher rides the BASE before signing: the signature must
  // cover the publisher claim itself, or anyone could re-attribute a
  // signed manifest.
  const base = {
    ...unsigned,
    ...(identity ? { publisher: identity.did } : {}),
  };

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
export const verifyManifest = async (manifest) => {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, reason: 'malformed' };
  }
  if (!manifest.publisher) return { ok: true, publisher: null };
  if (!manifest.sig) return { ok: false, reason: 'missing_sig' };
  let ok = false;
  try {
    ok = await verifySignature(
      manifest.publisher,
      fromBase64(manifest.sig),
      signingBytes(manifest),
    );
  } catch {
    return { ok: false, reason: 'verify_threw' };
  }
  return ok ? { ok: true, publisher: manifest.publisher } : { ok: false, reason: 'bad_sig' };
};
