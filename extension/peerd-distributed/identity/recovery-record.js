// @ts-check
// peerd-distributed/identity/recovery-record.js — the portable identity
// record: everything a fresh install needs to become this did EXCEPT the
// credential itself.
//
// Sensitive recovery ciphertext: the capsule is AES-GCM ciphertext and each
// wrapper is AES-KW ciphertext under a credential-derived KEK, but a stolen
// record still permits offline passphrase guessing. This implementation carries
// the record only in the explicit backup file; hosted lookup and passkey
// ceremonies remain proposals.
//
// This file also owns the ADOPTION decision — what an import does when a
// record meets whatever identity the receiving install already has. The
// rule is explicit: the same did is accepted without a write, a different did
// is refused by default, and replacement requires an explicit user decision.

import { decodeDidKey } from './did.js';
import { assertIdentityMaterial } from './keypair.js';
import { generateCapsuleKey, sealCapsule, openCapsule, MAX_CAPSULE_B64_LENGTH } from './capsule.js';
import { IdentityRecordError } from './errors.js';
import {
  makePassphraseWrapper, openPassphraseWrapper,
  validateCredentialWrapper,
  WRAPPER_KIND_PASSPHRASE,
} from './credential-wrapper.js';

export const RECORD_FORMAT = 'peerd-identity-record';
export const RECORD_VERSION = 1;
const MAX_WRAPPERS = 8;

/**
 * @typedef {import('./credential-wrapper.js').CredentialWrapper} CredentialWrapper
 * @typedef {{
 *   format: string,
 *   version: number,
 *   did: string,
 *   capsule: string,
 *   wrappers: CredentialWrapper[],
 *   updatedAt: number,
 * }} IdentityRecord
 */

/**
 * A wrapper spec for buildIdentityRecord — the credential material to
 * enroll, by kind.
 * @typedef {{ kind: 'passphrase', passphrase: string }} WrapperSpec
 */

/**
 * Build a record around existing identity material. The material is the
 * caller's (typically read from the vault secret keypair.js owns); this
 * function never persists anything.
 *
 * @param {Object} args
 * @param {{ seed: string, pub: string }} args.material
 * @param {WrapperSpec[]} args.wrappers  at least one
 * @param {number} [args.now]  injectable clock for tests
 * @returns {Promise<IdentityRecord>}
 */
export const buildIdentityRecord = async ({ material, wrappers, now }) => {
  if (!Array.isArray(wrappers) || wrappers.length === 0) {
    throw new IdentityRecordError('at least one wrapper is required', 'no-wrappers');
  }
  if (wrappers.length > MAX_WRAPPERS) {
    throw new IdentityRecordError(`at most ${MAX_WRAPPERS} wrappers are supported`, 'too-many-wrappers');
  }
  if (wrappers.filter((wrapper) => wrapper.kind === WRAPPER_KIND_PASSPHRASE).length > 1) {
    throw new IdentityRecordError(
      'version 1 supports one passphrase wrapper', 'too-many-passphrase-wrappers',
    );
  }
  const did = await assertIdentityMaterial(material)
    .catch((cause) => { throw new IdentityRecordError('identity material is not a valid keypair', 'bad-material', { cause }); });
  const capsuleKey = await generateCapsuleKey();
  const capsule = await sealCapsule(material, capsuleKey);
  /** @type {CredentialWrapper[]} */
  const built = [];
  for (const spec of wrappers) {
    if (spec.kind === WRAPPER_KIND_PASSPHRASE) {
      built.push(await makePassphraseWrapper(capsuleKey, spec.passphrase));
    } else {
      throw new IdentityRecordError(`unknown wrapper kind ${/** @type {any} */ (spec).kind}`, 'unknown-wrapper');
    }
  }
  return {
    format: RECORD_FORMAT,
    version: RECORD_VERSION,
    did,
    capsule,
    wrappers: built,
    updatedAt: now ?? Date.now(),
  };
};

/**
 * Structural validation — cheap, pure, no crypto. Returns an error
 * string (for the import notice) or null when the record is usable.
 *
 * @param {any} record
 * @returns {string | null}
 */
export const validateIdentityRecord = (record) => {
  if (!record || typeof record !== 'object') return 'not-a-record';
  if (record.format !== RECORD_FORMAT) return 'wrong-format';
  if (record.version !== RECORD_VERSION) return `unsupported-version-${record.version}`;
  try { decodeDidKey(record.did); } catch { return 'bad-did'; }
  if (typeof record.capsule !== 'string' || record.capsule.length === 0) return 'missing-capsule';
  if (record.capsule.length > MAX_CAPSULE_B64_LENGTH) return 'capsule-too-large';
  if (!Array.isArray(record.wrappers) || record.wrappers.length === 0) return 'no-wrappers';
  if (record.wrappers.length > MAX_WRAPPERS) return 'too-many-wrappers';
  let passphraseWrappers = 0;
  for (const wrapper of record.wrappers) {
    const defect = validateCredentialWrapper(wrapper);
    if (defect) return `bad-wrapper-${defect}`;
    if (wrapper.kind === WRAPPER_KIND_PASSPHRASE) passphraseWrappers++;
  }
  if (passphraseWrappers > 1) return 'too-many-passphrase-wrappers';
  if (!Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) return 'bad-updated-at';
  return null;
};

/**
 * Open a record with whatever credentials the caller holds. Tries every
 * wrapper whose kind matches a supplied credential; unknown kinds are
 * skipped (forward compatibility — a future record may carry wrapper
 * kinds this build can't open, beside ones it can).
 *
 * why the did re-check after decryption: the did in the record is
 * plaintext metadata anyone could edit. The capsule's AES-GCM tag
 * already proves integrity of the MATERIAL, but binding material to the
 * ADVERTISED did catches a swapped capsule/did pairing before the
 * caller trusts it.
 *
 * @param {IdentityRecord} record
 * @param {{ passphrase?: string }} credentials
 * @returns {Promise<{ seed: string, pub: string, did: string }>}
 */
export const openIdentityRecord = async (record, { passphrase } = {}) => {
  const invalid = validateIdentityRecord(record);
  if (invalid) throw new IdentityRecordError(`identity record is invalid: ${invalid}`, invalid);
  /** @type {Error | null} */
  let lastFailure = null;
  for (const wrapper of record.wrappers) {
    try {
      let capsuleKey = null;
      if (wrapper.kind === WRAPPER_KIND_PASSPHRASE && typeof passphrase === 'string' && passphrase.length > 0) {
        capsuleKey = await openPassphraseWrapper(wrapper, passphrase);
      }
      if (!capsuleKey) continue;
      const material = await openCapsule(record.capsule, capsuleKey);
      const did = await assertIdentityMaterial(material)
        .catch((cause) => { throw new IdentityRecordError('capsule does not contain a valid keypair', 'bad-material', { cause }); });
      if (did !== record.did) {
        throw new IdentityRecordError('capsule material does not match the advertised did', 'did-mismatch');
      }
      return { ...material, did };
    } catch (e) {
      // A wrong passphrase (or a stale wrapper) fails at unwrap/decrypt;
      // keep trying the remaining wrappers before giving up.
      lastFailure = /** @type {Error} */ (e);
    }
  }
  throw lastFailure ?? new IdentityRecordError(
    'no wrapper matches the supplied credentials',
    'no-matching-wrapper',
  );
};

/**
 * The import-side decision (see the file header for the rule).
 *
 * @param {Object} args
 * @param {any} args.record  the record arriving from an export payload
 * @param {string} [args.passphrase]
 * @param {string | null} [args.existingMaterial]  the receiving install's
 *        current identity secret value (JSON string), or null
 * @param {boolean} [args.replaceExisting] explicit user-approved replacement
 * @returns {Promise<{
 *   adopted: boolean, did: string | null,
 *   material: string | null, reason: string,
 *   existingDid?: string | null, incomingDid?: string | null,
 * }>}  material is the JSON string to store as the identity secret when
 *      the record supplied a new identity; null when nothing changes.
 */
export const adoptIdentityRecord = async ({
  record, passphrase, existingMaterial = null, replaceExisting = false,
}) => {
  const invalid = validateIdentityRecord(record);
  if (invalid) return { adopted: false, did: null, material: null, reason: invalid };

  let recovered;
  try {
    recovered = await openIdentityRecord(record, { passphrase });
  } catch {
    return { adopted: false, did: null, material: null, reason: 'no-openable-wrapper' };
  }

  let existingDid = null;
  if (typeof existingMaterial === 'string' && existingMaterial.length > 0) {
    try {
      const existing = JSON.parse(existingMaterial);
      existingDid = await assertIdentityMaterial(existing);
    } catch {
      if (!replaceExisting) {
        return {
          adopted: false, did: null, material: null, reason: 'invalid-local-identity',
          existingDid: null, incomingDid: recovered.did,
        };
      }
      const { seed, pub, did } = recovered;
      return {
        adopted: true,
        did,
        material: JSON.stringify({ v: 1, seed, pub }),
        reason: 'replaced-invalid-local',
        existingDid: null,
        incomingDid: did,
      };
    }
    if (existingDid === recovered.did) {
      return {
        adopted: true, did: existingDid, material: null, reason: 'already-present',
        existingDid, incomingDid: recovered.did,
      };
    }
    if (!replaceExisting) {
      return {
        adopted: false, did: existingDid, material: null, reason: 'did-conflict',
        existingDid, incomingDid: recovered.did,
      };
    }
  }

  const { seed, pub, did } = recovered;
  // The stored shape mirrors keypair.js's first-run write exactly, so
  // loadIdentityMaterial reloads an adopted identity indistinguishably.
  return {
    adopted: true,
    did,
    material: JSON.stringify({ v: 1, seed, pub }),
    reason: existingDid ? 'replaced' : 'recovered',
    existingDid,
    incomingDid: did,
  };
};
