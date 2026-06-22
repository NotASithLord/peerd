// @ts-check
// Cryptographic primitives for the vault.
//
// All raw SubtleCrypto calls in this codebase live here. No other file
// touches `crypto.subtle.*`. This is the auditable surface for the
// vault's correctness — changes go through extra review (§5.3 of the
// design doc).
//
// Algorithm choices and rationale
// -------------------------------
// KEK derivation: Argon2id (memory-hard) — the only passphrase KDF.
// The hash itself runs in the vendored WASM OUTSIDE this file
// (vault/argon2.js — not a SubtleCrypto primitive); keys.js only
// imports its 32-byte output as an AES-KW key via importRawKEK below.
// (The pre-release PBKDF2 path was deleted 2026-06-12 — 0.x, no
// installs, no compat.) The derived key is an AES-KW key, used only to
// wrap the data key.
//
// DK type: AES-GCM, 256-bit. Used to encrypt all stored secrets with
// per-secret random 96-bit IVs.
//
// Wrap algorithm: AES-KW (RFC 3394 key wrap). The DK is generated with
// `extractable: true` because SubtleCrypto.wrapKey throws on
// non-extractable keys. This is a small but real deviation from the
// instinct to make the DK fully non-extractable: in practice the bytes
// never leave the JS engine (we call wrapKey, not exportKey, and the
// codebase has no other exportKey calls — see grep), so the practical
// security delta is small. The migration to a hardware-bound, truly
// non-extractable DK happens with the WebAuthn unlock work in V1.1.
//
// IV layout for AES-GCM secrets: 12 random bytes prepended to the
// ciphertext. Format version is implicit in the storage key
// (`vault.v1` etc.); changing this layout requires bumping that.

import { concat } from '/shared/util.js';

const DK_BITS = 256;
export const IV_BYTES = 12;
export const SALT_BYTES = 16;

/**
 * Generate a fresh data key. `extractable: true` is required for
 * wrapKey to work (see file header). usage is encrypt/decrypt only.
 *
 * @returns {Promise<CryptoKey>}
 */
export const generateDK = () =>
  crypto.subtle.generateKey(
    { name: 'AES-GCM', length: DK_BITS },
    true,
    ['encrypt', 'decrypt'],
  );

/**
 * Wrap a data key with a key-encryption key. Returns the wrapped bytes;
 * caller is responsible for persisting them.
 *
 * @param {CryptoKey} dk
 * @param {CryptoKey} kek
 * @returns {Promise<Uint8Array>}
 */
export const wrapDK = async (dk, kek) => {
  const wrapped = await crypto.subtle.wrapKey('raw', dk, kek, { name: 'AES-KW' });
  return new Uint8Array(wrapped);
};

/**
 * Unwrap a previously-wrapped data key. Throws on tampered ciphertext
 * or wrong KEK (caller should map both to WrongPassphraseError).
 *
 * @param {Uint8Array | ArrayBuffer} wrapped
 * @param {CryptoKey} kek
 * @returns {Promise<CryptoKey>}
 */
export const unwrapDK = (wrapped, kek) =>
  crypto.subtle.unwrapKey(
    'raw',
    // why the cast: callers feed a plain Uint8Array (base64-decoded bytes),
    // which the DOM types model as Uint8Array<ArrayBufferLike> — not a
    // BufferSource, since that admits SharedArrayBuffer. The vault never
    // uses an SAB-backed view (parallelism is pinned to 1, no SAB in the
    // SW), so the runtime backing is always a plain ArrayBuffer.
    /** @type {BufferSource} */ (wrapped),
    kek,
    { name: 'AES-KW' },
    { name: 'AES-GCM', length: DK_BITS },
    true,
    ['encrypt', 'decrypt'],
  );

/**
 * Encrypt a UTF-8 string with the DK. Output layout: IV (12 bytes) ||
 * ciphertext+authTag.
 *
 * @param {CryptoKey} dk
 * @param {string} plaintext
 * @returns {Promise<Uint8Array>}
 */
export const encryptString = async (dk, plaintext) => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    dk,
    new TextEncoder().encode(plaintext),
  );
  return concat(iv, new Uint8Array(ct));
};

/**
 * Decrypt a blob produced by encryptString.
 *
 * @param {CryptoKey} dk
 * @param {Uint8Array} blob
 * @returns {Promise<string>}
 */
export const decryptString = async (dk, blob) => {
  if (blob.byteLength < IV_BYTES + 16) {
    // AES-GCM ciphertext is at least 16 bytes (auth tag). Reject obviously
    // malformed input early with a clean error.
    throw new Error('crypto: ciphertext too short');
  }
  const iv = blob.slice(0, IV_BYTES);
  const ct = blob.slice(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, dk, ct);
  return new TextDecoder().decode(pt);
};

/**
 * Generate a salt for the KEK derivation. Wrapped because we want a
 * single seam to swap in fixture bytes during tests.
 *
 * @param {(n: number) => Uint8Array} [randomBytes]
 */
export const generateSalt = (randomBytes) =>
  (randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(SALT_BYTES);

/**
 * Import 32 bytes of raw key material as an AES-KW key-encryption key.
 * Shared by the two no-PBKDF2 KEK paths: WebAuthn PRF output
 * (importPrfKEK) and the Argon2id derive (vault.js, via the injected
 * argon2 dep). Non-extractable, wrap/unwrap only — even if a bug
 * elsewhere captured the reference, an attacker couldn't exportKey() it.
 *
 * @param {Uint8Array} bytes   exactly 32 bytes
 * @returns {Promise<CryptoKey>}
 */
export const importRawKEK = (bytes) => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new Error('crypto: KEK material must be exactly 32 bytes');
  }
  return crypto.subtle.importKey(
    'raw',
    // why the cast: see unwrapDK — a plain Uint8Array's ArrayBufferLike
    // backing isn't a BufferSource to the DOM types, but the vault never
    // produces an SAB-backed view.
    /** @type {BufferSource} */ (bytes),
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  );
};

/**
 * Import 32 bytes of WebAuthn PRF output as an AES-KW key-encryption key.
 *
 * The PRF output is the HMAC-SHA-256 output of the authenticator's
 * per-credential secret over our chosen salt. It's a 256-bit string
 * indistinguishable from random to anything without access to the
 * authenticator, so we use it directly as AES-KW key material — no
 * KDF stretch needed (the entropy is already there) and no PBKDF2
 * iteration count to tune (the authenticator already imposes a
 * presence/UV check, which is the analog of work).
 *
 * The resulting KEK is non-extractable and wraps the same DK that the
 * passphrase-KEK wraps. Either path produces an equivalent unwrapped
 * DK; the two paths are alternatives, not a 2FA composition.
 *
 * @param {Uint8Array} prfOutput   exactly 32 bytes (PRF output length)
 * @returns {Promise<CryptoKey>}
 */
export const importPrfKEK = (prfOutput) => {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.byteLength !== 32) {
    // why a distinct message: a wrong-length PRF output means the
    // WebAuthn ceremony glue broke, not the KEK plumbing.
    throw new Error('crypto: PRF output must be exactly 32 bytes');
  }
  return importRawKEK(prfOutput);
};
