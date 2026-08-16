// @ts-check
// peerd-distributed/identity/capsule.js — the identity capsule.
//
// The portable form of the persistent identity: the vault-random Ed25519
// material sealed
// AES-GCM under a random capsule key (CapK). The capsule ciphertext can
// travel anywhere — export file, hosted record, QR, a peer — because
// opening it requires CapK, and CapK exists only wrapped under
// per-credential KEKs (credential-wrapper.js).
//
// why a random CapK between credential and capsule (not the credential
// KEK directly): adding or revoking a credential then re-wraps 40 bytes
// instead of re-encrypting the capsule. The wrapper list remains sensitive
// because it lets an attacker test passphrase guesses offline. Protect the
// combined record even though every entry is ciphertext.
//
// why NOT the vault's keys.js: that file is the vault DK's audited
// surface and must stay vault-only (its header scopes it explicitly).
// This is the dweb's parallel use of the same primitives — AES-GCM seal,
// AES-KW wrap — with capsule-specific lifetimes: CapK is TRANSIENT by
// contract (minted, used for one seal/open + wrap set, dropped), never a
// resident key like the DK.

import { toBase64, fromBase64, concat } from '/shared/bundle/bytes.js';
import { IdentityCapsuleError } from './errors.js';

const CAPSULE_VERSION = 1;
const IV_BYTES = 12;
export const MAX_CAPSULE_B64_LENGTH = 4096;

/**
 * Mint a fresh capsule key. Extractable — SubtleCrypto.wrapKey refuses a
 * non-extractable key, and every CapK is about to be wrapped for at
 * least one credential. The handle is transient by contract: callers
 * seal/wrap and drop it (same creation-time-vs-residency split the
 * vault documents for its DK; a CapK is never resident anywhere).
 *
 * @returns {Promise<CryptoKey>}
 */
export const generateCapsuleKey = () =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

/**
 * Seal identity material into a capsule: base64(iv || AES-GCM ct) over
 * the canonical JSON plaintext.
 *
 * @param {{ seed: string, pub: string }} material  base64 seed + public key
 *        (the exact shape keypair.js stores under the vault secret)
 * @param {CryptoKey} capsuleKey
 * @returns {Promise<string>} the capsule ciphertext, base64
 */
export const sealCapsule = async ({ seed, pub }, capsuleKey) => {
  if (typeof seed !== 'string' || typeof pub !== 'string'
      || seed.length > 128 || pub.length > 128) {
    throw new IdentityCapsuleError(
      'capsule material must carry bounded base64 seed and pub',
      'bad-material',
    );
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ v: CAPSULE_VERSION, seed, pub }),
  );
  try {
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, capsuleKey, plaintext),
    );
    return toBase64(concat(iv, ct));
  } finally {
    plaintext.fill(0);
  }
};

/**
 * Open a capsule. Throws on tampered ciphertext, a wrong key, or an
 * unknown capsule version — the caller maps all three to "this record
 * cannot be opened with this credential".
 *
 * @param {string} capsuleB64
 * @param {CryptoKey} capsuleKey
 * @returns {Promise<{ seed: string, pub: string }>}
 */
export const openCapsule = async (capsuleB64, capsuleKey) => {
  if (typeof capsuleB64 !== 'string' || capsuleB64.length === 0
      || capsuleB64.length > MAX_CAPSULE_B64_LENGTH) {
    throw new IdentityCapsuleError('capsule ciphertext is missing or too large', 'bad-ciphertext');
  }
  let blob;
  try {
    blob = fromBase64(capsuleB64);
  } catch (cause) {
    throw new IdentityCapsuleError('capsule ciphertext is not base64', 'bad-ciphertext', { cause });
  }
  if (blob.byteLength < IV_BYTES + 16) {
    // AES-GCM carries at least a 16-byte tag; reject malformed input with
    // a clean message instead of an opaque OperationError.
    throw new IdentityCapsuleError('capsule ciphertext is too short', 'bad-ciphertext');
  }
  const iv = blob.slice(0, IV_BYTES);
  const ct = blob.slice(IV_BYTES);
  let parsed;
  /** @type {Uint8Array | null} */
  let plaintext = null;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, capsuleKey, ct),
    );
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch (cause) {
    throw new IdentityCapsuleError('capsule could not be authenticated or decoded', 'open-failed', { cause });
  } finally {
    plaintext?.fill(0);
  }
  if (parsed?.v !== CAPSULE_VERSION || typeof parsed.seed !== 'string' || typeof parsed.pub !== 'string') {
    throw new IdentityCapsuleError(
      `unsupported capsule payload (v=${parsed?.v})`,
      'unsupported-payload',
    );
  }
  return { seed: parsed.seed, pub: parsed.pub };
};
