// @ts-check
// Cryptographic primitives for the vault.
//
// All of the VAULT's raw SubtleCrypto calls live here — vault.js holds
// state and policy and calls nothing on `crypto.subtle` itself. This is
// the auditable surface for the vault's correctness; changes go through
// extra review (§5.3 of the design doc). (Other modules have their own
// unrelated crypto — the audit chain's SHA-256, the dweb's Ed25519, DPoP
// — none of them touch the vault's keys.)
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
// Wrap algorithm: AES-KW (RFC 3394 key wrap).
//
// Extractability of the DK — the R11 posture
// ------------------------------------------
// A key must be `extractable: true` at the moment it is WRAPPED:
// SubtleCrypto.wrapKey refuses a non-extractable key. That is a
// creation/enrollment-time requirement, not a residency one, so the two
// are split here:
//
//   generateDK / unwrapWrappableDK / importWrappableDK
//       mint an EXTRACTABLE handle. Callers use one for exactly one
//       wrapKey/exportKey and then drop it. Transient by contract.
//   unwrapDK
//       mints a NON-EXTRACTABLE handle. This is the DK the vault keeps
//       RESIDENT and the only one it hands to encryptString /
//       decryptString, so `crypto.subtle.exportKey` on the reference
//       that travels through the vault REJECTS.
//
// why the split matters: it closes the EXPORT half of residual R11 — a
// bug that leaks the live DK reference can no longer turn it into bytes.
// It deliberately does NOT claim more than that. In-origin code can
// still USE a leaked reference to decrypt (R7), and the vault still
// mirrors the DK's raw bytes into chrome.storage.session so an MV3
// service-worker restart resumes unlocked (see the "DK persistence"
// block in vault.js). Those are the honest remaining exposures.
//
// IV layout for AES-GCM secrets: 12 random bytes prepended to the
// ciphertext. Format version is implicit in the storage key
// (`vault.v1` etc.); changing this layout requires bumping that.

import { concat } from '/shared/util.js';

const DK_BITS = 256;
export const IV_BYTES = 12;
export const SALT_BYTES = 16;

/**
 * Generate a fresh data key. `extractable: true` is required for the
 * wrapKey that immediately follows (see file header); the caller adopts
 * the resident, non-extractable copy and drops this handle. usage is
 * encrypt/decrypt only.
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
 * Mint an ephemeral, non-extractable AES-KW key.
 *
 * why: the vault needs to be able to WRAP the live DK long after unlock
 * (enrollPrf, setRecoveryPassphrase) without holding an extractable DK
 * for the whole session. It keeps the DK a second time as ciphertext
 * under one of these, and this key never leaves the vault closure —
 * non-extractable, so it cannot be exported either.
 *
 * @returns {Promise<CryptoKey>}
 */
export const generateRewrapKEK = () =>
  crypto.subtle.generateKey(
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
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
 * @param {Uint8Array | ArrayBuffer} wrapped
 * @param {CryptoKey} kek
 * @param {boolean} extractable
 * @returns {Promise<CryptoKey>}
 */
const _unwrapDK = (wrapped, kek, extractable) =>
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
    extractable,
    ['encrypt', 'decrypt'],
  );

/**
 * Unwrap a previously-wrapped data key into a NON-EXTRACTABLE handle —
 * the resident DK. Throws on tampered ciphertext or wrong KEK (caller
 * should map both to WrongPassphraseError).
 *
 * why non-extractable: this is the handle the vault keeps and passes to
 * encryptString/decryptString, so exportKey on it rejects (R11). Use
 * unwrapWrappableDK when the DK is about to be re-wrapped.
 *
 * @param {Uint8Array | ArrayBuffer} wrapped
 * @param {CryptoKey} kek
 * @returns {Promise<CryptoKey>}
 */
export const unwrapDK = (wrapped, kek) => _unwrapDK(wrapped, kek, false);

/**
 * Unwrap into an EXTRACTABLE handle. Named loudly on purpose: every
 * caller is a place where the DK is about to be fed to wrapKey or
 * exportKey, and the handle must be dropped immediately after.
 *
 * @param {Uint8Array | ArrayBuffer} wrapped
 * @param {CryptoKey} kek
 * @returns {Promise<CryptoKey>}
 */
export const unwrapWrappableDK = (wrapped, kek) => _unwrapDK(wrapped, kek, true);

/**
 * Import raw DK bytes into an EXTRACTABLE handle. The one caller is the
 * chrome.storage.session resume path, which hands the result straight to
 * the same adopt-and-drop treatment as an unwrap.
 *
 * @param {Uint8Array} bytes   exactly 32 bytes (AES-256)
 * @returns {Promise<CryptoKey>}
 */
export const importWrappableDK = (bytes) => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== DK_BITS / 8) {
    // why a guard: the bytes come from storage, so a truncated or
    // corrupted session record should fail here with a clear message
    // rather than as an opaque DataError deep in the resume path.
    throw new Error('crypto: DK material must be exactly 32 bytes');
  }
  return crypto.subtle.importKey(
    'raw',
    // why the cast: see _unwrapDK.
    /** @type {BufferSource} */ (bytes),
    { name: 'AES-GCM', length: DK_BITS },
    true,
    ['encrypt', 'decrypt'],
  );
};

/**
 * Export a data key's raw bytes. The ONLY caller is the vault's
 * chrome.storage.session mirror (`_persistDK`), and it is only ever
 * handed a transient extractable handle — never the resident DK, which
 * would reject.
 *
 * @param {CryptoKey} wrappableDK
 * @returns {Promise<Uint8Array>}
 */
export const exportRawDK = async (wrappableDK) =>
  new Uint8Array(await crypto.subtle.exportKey('raw', wrappableDK));

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
