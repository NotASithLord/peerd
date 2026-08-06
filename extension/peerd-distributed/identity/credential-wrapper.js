// @ts-check
// peerd-distributed/identity/credential-wrapper.js — the passphrase wrapper
// used by manual portable-identity backup and restore.
//
// A wrapper is ciphertext, but it is also a sensitive offline verifier:
// AES-KW integrity tells an attacker when a guessed passphrase re-derives the
// correct KEK. The shipped kind is Argon2id(passphrase, salt, bounded
// parameters). Passkey PRF and hosted lookup remain design proposals until
// their ceremonies and relying-party boundary are implemented end to end.
//
// why Argon2id: a carried record gives an attacker an offline correctness
// oracle against a permanent signing root. Reuse the vault's audited,
// vendored memory-hard implementation instead of treating this like a
// low-value settings file.

import { toBase64, fromBase64 } from '/shared/bundle/bytes.js';
import {
  BACKUP_ARGON2ID_PARAMS, BACKUP_ARGON2ID_SALT_BYTES,
  deriveBackupPassphraseBytes,
} from '/shared/backup-passphrase.js';
import { IdentityCredentialError } from './errors.js';

export const WRAPPER_KIND_PASSPHRASE = 'passphrase';

const WRAPPED_KEY_BYTES = 40;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** @param {string} message @param {string} [code] @param {unknown} [cause] */
const credentialFailure = (message, code = 'malformed-wrapper', cause) =>
  new IdentityCredentialError(message, code, cause === undefined ? {} : { cause });

/** @param {Uint8Array} bytes  exactly 32 — imported as a non-extractable AES-KW KEK */
const importKek = (bytes) =>
  crypto.subtle.importKey(
    'raw', /** @type {BufferSource} */ (bytes), { name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey'],
  );

/**
 * @param {string} passphrase
 * @param {Uint8Array} salt
 * @param {{ name: string, memKiB: number, iters: number, parallelism: number }} kdf
 */
const kekFromPassphrase = async (passphrase, salt, kdf) => {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw credentialFailure('passphrase required', 'passphrase-required');
  }
  if (!(salt instanceof Uint8Array) || salt.byteLength !== BACKUP_ARGON2ID_SALT_BYTES) {
    throw credentialFailure('Argon2id salt must be exactly 16 bytes');
  }
  // Version 1 accepts exactly the parameters it emits. A future tuning uses a
  // new wrapper version instead of letting an untrusted record choose memory or
  // CPU work and turn import into a denial-of-service primitive.
  if (kdf?.name !== 'Argon2id'
      || kdf.memKiB !== BACKUP_ARGON2ID_PARAMS.memKiB
      || kdf.iters !== BACKUP_ARGON2ID_PARAMS.iters
      || kdf.parallelism !== BACKUP_ARGON2ID_PARAMS.parallelism) {
    throw credentialFailure(`unsupported passphrase KDF ${kdf?.name ?? '(missing)'}`, 'unsupported-kdf');
  }
  const raw = await deriveBackupPassphraseBytes(passphrase, salt);
  try {
    return await importKek(raw);
  } finally {
    raw.fill(0);
  }
};

/** @param {CryptoKey} capsuleKey @param {CryptoKey} kek */
const wrapCapK = async (capsuleKey, kek) =>
  toBase64(new Uint8Array(await crypto.subtle.wrapKey('raw', capsuleKey, kek, { name: 'AES-KW' })));

/**
 * Unwrap a wrapped CapK into a non-extractable AES-GCM handle — enough
 * to open (or re-seal) the capsule, never to export the key bytes.
 * @param {string} wrappedB64 @param {CryptoKey} kek
 */
const unwrapCapK = (wrappedB64, kek) => {
  let wrapped;
  try { wrapped = fromBase64(wrappedB64); }
  catch (cause) { throw credentialFailure('wrapped key is not base64', 'malformed-wrapper', cause); }
  if (wrapped.byteLength !== WRAPPED_KEY_BYTES) {
    throw credentialFailure(`wrapped key must be exactly ${WRAPPED_KEY_BYTES} bytes`);
  }
  return crypto.subtle.unwrapKey(
    'raw', /** @type {BufferSource} */ (wrapped), kek, { name: 'AES-KW' },
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
};

/**
 * A wrapper record is ciphertext but remains a sensitive offline passphrase
 * verifier. Protect the combined recovery record.
 * @typedef {{
 *   kind: string,
 *   wrappedKey: string,
 *   kdf?: { name: string, memKiB: number, iters: number, parallelism: number, salt: string },
 * }} CredentialWrapper
 */

/**
 * Wrap CapK under a passphrase.
 * @param {CryptoKey} capsuleKey @param {string} passphrase
 * @returns {Promise<CredentialWrapper>}
 */
export const makePassphraseWrapper = async (capsuleKey, passphrase) => {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw credentialFailure('passphrase required', 'passphrase-required');
  }
  const salt = crypto.getRandomValues(new Uint8Array(BACKUP_ARGON2ID_SALT_BYTES));
  const kdf = {
    name: 'Argon2id',
    memKiB: BACKUP_ARGON2ID_PARAMS.memKiB,
    iters: BACKUP_ARGON2ID_PARAMS.iters,
    parallelism: BACKUP_ARGON2ID_PARAMS.parallelism,
    salt: toBase64(salt),
  };
  const kek = await kekFromPassphrase(passphrase, salt, kdf);
  return {
    kind: WRAPPER_KIND_PASSPHRASE,
    kdf,
    wrappedKey: await wrapCapK(capsuleKey, kek),
  };
};

/** @param {CredentialWrapper} wrapper @param {string} passphrase */
export const openPassphraseWrapper = async (wrapper, passphrase) => {
  const defect = validateCredentialWrapper(wrapper);
  if (defect || wrapper.kind !== WRAPPER_KIND_PASSPHRASE || !wrapper.kdf) {
    throw credentialFailure(`invalid passphrase wrapper: ${defect ?? 'wrong-kind'}`);
  }
  const salt = fromBase64(wrapper.kdf.salt);
  const kek = await kekFromPassphrase(passphrase, salt, wrapper.kdf);
  return unwrapCapK(wrapper.wrappedKey, kek);
};

/**
 * Bound and validate one untrusted wrapper before any KDF or base64 decode.
 * Unknown kinds remain skippable for forward compatibility, but are bounded.
 * @param {any} wrapper
 * @returns {string | null}
 */
export const validateCredentialWrapper = (wrapper) => {
  if (!wrapper || typeof wrapper !== 'object') return 'not-an-object';
  if (typeof wrapper.kind !== 'string' || wrapper.kind.length === 0 || wrapper.kind.length > 64) return 'bad-kind';
  const known = wrapper.kind === WRAPPER_KIND_PASSPHRASE;
  if (typeof wrapper.wrappedKey !== 'string' || wrapper.wrappedKey.length === 0
      || (known ? wrapper.wrappedKey.length !== 56 : wrapper.wrappedKey.length > 4096)
      || (known && !BASE64_PATTERN.test(wrapper.wrappedKey))) return 'bad-wrapped-key';
  if (wrapper.kind === WRAPPER_KIND_PASSPHRASE) {
    const kdf = wrapper.kdf;
    if (!kdf || kdf.name !== 'Argon2id') return 'bad-kdf';
    if (kdf.memKiB !== BACKUP_ARGON2ID_PARAMS.memKiB
        || kdf.iters !== BACKUP_ARGON2ID_PARAMS.iters
        || kdf.parallelism !== BACKUP_ARGON2ID_PARAMS.parallelism) return 'unsupported-kdf';
    if (typeof kdf.salt !== 'string' || kdf.salt.length !== 24
        || !BASE64_PATTERN.test(kdf.salt)) return 'bad-salt';
  }
  return null;
};
