// @ts-check
// peerd-distributed/identity/credential-wrapper.js - per-credential unlock
// onto the identity capsule: the passphrase wrapper (manual backup) and the
// passkey-PRF wrapper (the id.peerd.ai ceremony - web-identity/ hosts the
// page source; docs/design/portable-identity/ 04 records the decided RP).
//
// A wrapper is ciphertext, but it is also a sensitive offline verifier:
// AES-KW integrity tells an attacker when a guessed passphrase re-derives the
// correct KEK. Passphrase kind: Argon2id(passphrase, salt, bounded
// parameters). Passkey kind: HKDF over the authenticator's PRF output - no
// stretch needed (the credential secret is uniform; presence + user
// verification is the work factor). Hosted lookup remains a proposal.
//
// why Argon2id for passphrases: a carried record gives an attacker an offline
// correctness oracle against a permanent signing root. Reuse the vault's
// audited, vendored memory-hard implementation instead of treating this like
// a low-value settings file.
//
// FROZEN protocol constants (orphaning surface - changing any of these after
// credentials exist makes every passkey wrapper unopenable; the KAT vectors
// in tests/peerd-distributed/identity-prf-vectors.test.ts lock them in CI):
// the PRF input tag, the zero HKDF salt, and the HKDF info string below.
// why a protocol-FIXED PRF input (unlike the vault's random per-enrollment
// salt): a portable credential must be evaluable on a machine holding no
// local state yet - the input has to be knowable from the protocol alone.
// Uniqueness comes from the authenticator's per-credential secret; purpose
// separation happens AFTER the PRF via HKDF info strings.

import { toBase64, fromBase64 } from '/shared/bundle/bytes.js';
import {
  BACKUP_ARGON2ID_PARAMS, BACKUP_ARGON2ID_SALT_BYTES,
  deriveBackupPassphraseBytes,
} from '/shared/backup-passphrase.js';
import { IdentityCredentialError } from './errors.js';

export const WRAPPER_KIND_PASSPHRASE = 'passphrase';
export const WRAPPER_KIND_PRF = 'passkey-prf';

const WRAPPED_KEY_BYTES = 40;
const WRAPPED_KEY_B64_LENGTH = 56;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

// The frozen KEK-derivation constant (see the file header). Its sibling -
// the PRF INPUT the ceremony evaluates - lives in handoff.js, the
// self-contained module the ceremony page runs a byte-copy of.
const HKDF_INFO_WRAPPER = 'peerd/capsule-wrapper/v1';
const PRF_OUTPUT_BYTES = 32;
// WebAuthn credential IDs are at most 1023 bytes; base64 of that is 1368
// chars. Bound with headroom, exact charset.
const CREDENTIAL_ID_B64_MAX = 2048;
const TRANSPORTS_MAX = 8;
const TRANSPORT_NAME_MAX = 32;

/** @param {string} message @param {string} [code] @param {unknown} [cause] */
const credentialFailure = (message, code = 'malformed-wrapper', cause) =>
  new IdentityCredentialError(message, code, cause === undefined ? {} : { cause });

/** @param {Uint8Array} bytes  exactly 32 - imported as a non-extractable AES-KW KEK */
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

/**
 * HKDF-SHA256 → 32 bytes. Zero salt by design: the PRF output is already
 * uniform, and a fixed salt keeps the derivation reproducible from the
 * protocol constants alone (a random salt here would just be one more
 * piece of local state a fresh install doesn't have).
 * @param {Uint8Array} ikm @param {string} info
 */
const hkdf32 = async (ikm, info) => {
  const key = await crypto.subtle.importKey(
    'raw', /** @type {BufferSource} */ (ikm), 'HKDF', false, ['deriveBits'],
  );
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(info) },
    key,
    256,
  ));
};

/** @param {Uint8Array} prfOutput  the authenticator's 32-byte PRF result */
const kekFromPrf = async (prfOutput) => {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.byteLength !== PRF_OUTPUT_BYTES) {
    throw credentialFailure('PRF output must be exactly 32 bytes', 'bad-prf-output');
  }
  const raw = await hkdf32(prfOutput, HKDF_INFO_WRAPPER);
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
 * Unwrap a wrapped CapK into a non-extractable AES-GCM handle - enough
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
 *   credentialId?: string | null,
 *   transports?: string[] | null,
 * }} CredentialWrapper
 */

/**
 * Wrap CapK for a passkey's PRF output (evaluated over identityPrfInput()
 * at the canonical RP - the ceremony runs at id.peerd.ai, never in an
 * extension context, so the credential is portable across installs).
 *
 * @param {CryptoKey} capsuleKey
 * @param {Uint8Array} prfOutput
 * @param {{ credentialId?: string | null, transports?: string[] | null }} [meta]
 *        enrollment metadata (base64 credential ID + transport hints) so a
 *        later unlock can route straight to the right authenticator - the
 *        same role the vault's PrfContext plays locally.
 * @returns {Promise<CredentialWrapper>}
 */
export const makePrfWrapper = async (capsuleKey, prfOutput, { credentialId = null, transports = null } = {}) => {
  const kek = await kekFromPrf(prfOutput);
  const wrapper = {
    kind: WRAPPER_KIND_PRF,
    wrappedKey: await wrapCapK(capsuleKey, kek),
    credentialId: credentialId ?? null,
    transports: transports ?? null,
  };
  const defect = validateCredentialWrapper(wrapper);
  if (defect) throw credentialFailure(`refusing to emit an invalid passkey wrapper: ${defect}`);
  return wrapper;
};

/** @param {CredentialWrapper} wrapper @param {Uint8Array} prfOutput */
export const openPrfWrapper = async (wrapper, prfOutput) => {
  const defect = validateCredentialWrapper(wrapper);
  if (defect || wrapper.kind !== WRAPPER_KIND_PRF) {
    throw credentialFailure(`invalid passkey wrapper: ${defect ?? 'wrong-kind'}`);
  }
  return unwrapCapK(wrapper.wrappedKey, await kekFromPrf(prfOutput));
};

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
  const known = wrapper.kind === WRAPPER_KIND_PASSPHRASE || wrapper.kind === WRAPPER_KIND_PRF;
  if (typeof wrapper.wrappedKey !== 'string' || wrapper.wrappedKey.length === 0
      || (known ? wrapper.wrappedKey.length !== WRAPPED_KEY_B64_LENGTH : wrapper.wrappedKey.length > 4096)
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
  if (wrapper.kind === WRAPPER_KIND_PRF) {
    // No KDF descriptor: the derivation is the frozen protocol constant, so
    // an untrusted record has no work-factor knob here at all.
    if (wrapper.kdf !== undefined) return 'unexpected-kdf';
    if (wrapper.credentialId != null
        && (typeof wrapper.credentialId !== 'string'
          || wrapper.credentialId.length === 0
          || wrapper.credentialId.length > CREDENTIAL_ID_B64_MAX
          || !BASE64_PATTERN.test(wrapper.credentialId))) return 'bad-credential-id';
    if (wrapper.transports != null) {
      if (!Array.isArray(wrapper.transports) || wrapper.transports.length > TRANSPORTS_MAX) return 'bad-transports';
      for (const transport of wrapper.transports) {
        if (typeof transport !== 'string' || transport.length === 0
            || transport.length > TRANSPORT_NAME_MAX) return 'bad-transports';
      }
    }
  }
  return null;
};
