// @ts-check
// Vault passphrase-KDF policy — the pure half of the vault.v2 wrap
// format (Argon2id).
//
// Threat model (why Argon2id at all)
// ----------------------------------
// This protects exactly one thing: the AT-REST blob against OFFLINE
// brute force of a human-chosen passphrase. An attacker who exfiltrates
// the wrapped DK (stolen disk, profile backup, malware reading the
// profile) gets a free correctness oracle — AES-KW unwrap is
// self-verifying — so per-guess cost IS the KDF. PBKDF2 is
// computation-hard only; GPU/ASIC farms parallelize it cheaply.
// Argon2id forces a large random-access memory buffer per guess,
// collapsing that parallelism advantage. It does NOT protect a live
// unlocked vault, and the WebAuthn PRF wrap (full-entropy key material,
// no KDF) is untouched by all of this.
//
// Wrap format (the only one — the pre-release PBKDF2 v1 format and its
// lazy migration were deleted 2026-06-12; peerd is 0.x with no installs
// in the wild, so backwards compat would be code for users who don't
// exist):
//     { version: 2, wrappedDK,
//       kdf: { algo: 'argon2id', memKiB, iters, parallelism, salt }, ... }
//
// This module is values-in/values-out only (Bun-tested); no crypto, no
// storage, no WASM.

/**
 * @typedef {Object} Argon2Descriptor
 * @property {'argon2id'} algo
 * @property {number} memKiB        memory cost in KiB
 * @property {number} iters         time cost (passes over memory)
 * @property {1} parallelism        single-lane — no SharedArrayBuffer in the SW
 * @property {string} salt          base64, 16 random bytes
 */

// Default Argon2id parameters — DATA, not code: every wrap records the
// params it was created with in its descriptor, so these can be retuned
// without breaking existing blobs.
//
// why these numbers: 64 MiB is the memory-hardness floor that actually
// hurts GPU farms (RFC 9106's second recommended profile is 64 MiB,
// t=3); parallelism is pinned to 1 because the MV3 service worker has
// no SharedArrayBuffer (single lane, lean on memory); iters=3 lands the
// derive at ~150ms on fast 2026 hardware, ~300–500ms on ordinary
// machines — inside the 200–500ms unlock budget.
export const ARGON2_DEFAULT_PARAMS = Object.freeze({
  algo: 'argon2id',
  memKiB: 64 * 1024,
  iters: 3,
  parallelism: 1,
});

// Validation bounds. These are SAFETY rails, not policy: a tampered
// descriptor must not be able to OOM the service worker (absurd memKiB)
// or hang it for hours (absurd iters). Within bounds, the descriptor is
// data we honor; outside them, the unlock plan reports 'unsupported'.
const ARGON2_MIN_MEM_KIB = 8;               // Argon2 spec floor (8 KiB × lanes)
export const ARGON2_MAX_MEM_KIB = 1 << 20;  // 1 GiB — DoS ceiling
const ARGON2_MAX_ITERS = 1024;

/** @param {number} n */
const isPositiveInt = (n) => Number.isInteger(n) && n > 0;

/**
 * Are these usable Argon2id cost parameters (descriptor minus salt)?
 * Used both to validate stored descriptors and to sanity-check the
 * injected `argon2Params` override before a wrap is created with it.
 *
 * @param {any} p
 * @returns {boolean}
 */
export const isArgon2Params = (p) =>
  !!p
  && p.algo === 'argon2id'
  && isPositiveInt(p.memKiB)
  && p.memKiB >= ARGON2_MIN_MEM_KIB && p.memKiB <= ARGON2_MAX_MEM_KIB
  && isPositiveInt(p.iters) && p.iters <= ARGON2_MAX_ITERS
  // why exactly 1: single-lane is a hard constraint (no SAB in the SW),
  // and a tampered descriptor must not be able to demand lanes we can't
  // honestly run — silently serializing p>1 lanes would still derive the
  // correct key, but we'd rather refuse than honor params we never write.
  && p.parallelism === 1;

/**
 * Is this a complete, in-bounds Argon2id wrap descriptor?
 *
 * @param {any} kdf
 * @returns {boolean}
 */
export const isArgon2Descriptor = (kdf) =>
  isArgon2Params(kdf)
  && typeof kdf.salt === 'string' && kdf.salt.length > 0;

/**
 * Does the blob carry a passphrase wrap at all (either format)? PRF-only
 * blobs (passkey-first, no recovery passphrase yet) have neither `salt`
 * nor `kdf`.
 *
 * @param {any} blob
 * @returns {boolean}
 */
export const hasPassphraseWrap = (blob) =>
  !!(blob?.wrappedDK && (blob?.salt || blob?.kdf));

/**
 * @typedef {Object} UnlockPlan
 * @property {'none' | 'argon2id' | 'unsupported' | 'unavailable'} path
 * @property {Argon2Descriptor} [kdf]   present iff path === 'argon2id'
 */

/**
 * Decide how a passphrase unlock should derive its KEK, given the
 * stored blob and whether an Argon2 implementation is wired.
 *
 *   'none'        → no passphrase wrap (passkey-only vault)
 *   'argon2id'    → wrap with a valid descriptor
 *   'unsupported' → descriptor absent/unknown/out-of-bounds — tampered
 *                   storage or a blob written by a different peerd.
 *                   (An ABSENT descriptor was the pre-release PBKDF2
 *                   v1 format; that path was deleted 2026-06-12 —
 *                   peerd is 0.x with no installs, so no compat.)
 *   'unavailable' → valid Argon2 descriptor but no implementation wired
 *
 * @param {{ blob: any, argon2Available: boolean }} args
 * @returns {UnlockPlan}
 */
export const planPassphraseUnlock = ({ blob, argon2Available }) => {
  if (!hasPassphraseWrap(blob)) return { path: 'none' };
  if (!isArgon2Descriptor(blob.kdf)) return { path: 'unsupported' };
  return argon2Available ? { path: 'argon2id', kdf: blob.kdf } : { path: 'unavailable' };
};

/**
 * Pure blob builder: replace (or add) the passphrase wrap on a blob,
 * leaving every other field — the PRF wrap above all — untouched.
 * Scrubs any stray legacy `salt` field so the blob always carries
 * exactly one passphrase-wrap shape.
 *
 * @param {any} blob   existing blob ({} for a fresh vault)
 * @param {{ wrappedDK: string, kdf: Argon2Descriptor }} wrap
 * @returns {any} new blob object (input not mutated)
 */
export const withPassphraseWrap = (blob, { wrappedDK, kdf }) => {
  const next = { ...(blob ?? {}), wrappedDK };
  delete next.salt;
  next.kdf = kdf;
  next.version = 2;
  return next;
};
