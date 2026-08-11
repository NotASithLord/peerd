// @ts-check
// peerd-distributed/identity/passkey-binding.js: the record that makes a
// passkey an ENROLLMENT AUTHORITY for a person did.
//
// The statement, signed by the person root: "an assertion by one of these
// WebAuthn credentials, at this relying party, is authorized to enroll or
// recover devices under this did". The passkey never replaces the root and
// never signs peerd records, it only ever proves, to a device that already
// holds this binding, that the human on the other end controls an enrolled
// credential (self/enroll.js consumes it exactly that way).
//
// why the credential public key rides in the record: WebAuthn verification
// needs it, and the RP page must never become the place that stores or
// serves it (the ceremony page is an authenticator front-end, not an
// account system). Carrying it root-signed means any enrolled device can
// verify an assertion offline, and a forged record would need the person
// root to sign it.
//
// Lifecycle: like the device roster, the binding is a monotonically
// sequenced SNAPSHOT of the full credential set. Add / remove / rotate /
// revoke are all "sign a new snapshot with seq+1": the did never changes.

import { canonicalize } from '/shared/bundle/canonical.js';
import { utf8, concat, toBase64, fromBase64 } from '/shared/bundle/bytes.js';
import { decodeDidKey } from './did.js';
import { verifySignature } from './keypair.js';

export const PASSKEY_BINDING_VERSION = 1;
const BINDING_DOMAIN = 'peerd/passkey-binding/v1';

// The canonical relying-party id (docs/design/portable-identity/04). Exactly
// the ceremony host: never the registrable suffix `peerd.ai`, which would
// expose the credential to every sibling origin (a #360 closure blocker).
export const CANONICAL_RP_ID = 'id.peerd.ai';

export const MAX_BINDING_CREDENTIALS = 8;
// COSE algorithm identifiers this build accepts: the same three the vault's
// extension-origin enrollment requests, in the same preference order.
export const BINDING_ALGS = Object.freeze([-8, -7, -257]); // Ed25519, ES256, RS256
const MAX_CREDENTIAL_ID_B64 = 1024;
const MAX_SPKI_B64 = 4096;
const MAX_RP_ID_LENGTH = 253;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * @typedef {{ did: string, sign: (bytes: Uint8Array) => Promise<Uint8Array> }} Signer
 *
 * One enrolled credential. publicKeySpki is the SPKI DER the browser hands
 * back at creation (AuthenticatorAttestationResponse.getPublicKey()), a
 * WebCrypto-importable form, so verification never needs a CBOR/COSE parser.
 * @typedef {{
 *   credentialId: string,
 *   alg: number,
 *   publicKeySpki: string,
 *   addedAt: number,
 *   status: 'active' | 'revoked',
 * }} BindingCredential
 *
 * The signed binding record.
 * @typedef {{
 *   v: number,
 *   personDid: string,
 *   rpId: string,
 *   credentials: BindingCredential[],
 *   seq: number,
 *   sig: string,
 * }} PasskeyBinding
 */

/** @param {Omit<PasskeyBinding, 'sig'>} binding */
const bindingSigningBytes = (binding) =>
  concat(utf8(BINDING_DOMAIN), Uint8Array.from([0]), utf8(canonicalize(binding)));

/**
 * Sign a binding snapshot. personDid comes from the signer: a caller
 * cannot bind credentials to a did it doesn't control.
 *
 * @param {Object} args
 * @param {Signer} args.personIdentity
 * @param {BindingCredential[]} args.credentials
 * @param {number} args.seq
 * @param {string} [args.rpId]
 * @returns {Promise<PasskeyBinding>}
 */
export const buildPasskeyBinding = async ({
  personIdentity, credentials, seq, rpId = CANONICAL_RP_ID,
}) => {
  /** @type {Omit<PasskeyBinding, 'sig'>} */
  const unsigned = {
    v: PASSKEY_BINDING_VERSION, personDid: personIdentity.did, rpId, credentials, seq,
  };
  const defect = validatePasskeyBinding({ ...unsigned, sig: 'A'.repeat(88) });
  if (defect) throw new Error(`refusing to sign an invalid passkey binding: ${defect}`);
  const sig = await personIdentity.sign(bindingSigningBytes(unsigned));
  return { ...unsigned, sig: toBase64(sig) };
};

/**
 * Structural validation, bounds first, before any decode or crypto.
 * @param {any} binding
 * @returns {string | null}
 */
export const validatePasskeyBinding = (binding) => {
  if (!binding || typeof binding !== 'object') return 'not-an-object';
  if (binding.v !== PASSKEY_BINDING_VERSION) return `unsupported-version-${binding.v}`;
  try { decodeDidKey(binding.personDid); } catch { return 'bad-person-did'; }
  if (typeof binding.rpId !== 'string' || binding.rpId.length === 0
      || binding.rpId.length > MAX_RP_ID_LENGTH) return 'bad-rp-id';
  if (!Number.isSafeInteger(binding.seq) || binding.seq < 1) return 'bad-seq';
  if (!Array.isArray(binding.credentials)
      || binding.credentials.length > MAX_BINDING_CREDENTIALS) return 'bad-credentials';
  const seen = new Set();
  for (const credential of binding.credentials) {
    if (!credential || typeof credential !== 'object') return 'bad-credential';
    if (typeof credential.credentialId !== 'string' || credential.credentialId.length === 0
        || credential.credentialId.length > MAX_CREDENTIAL_ID_B64
        || !BASE64_PATTERN.test(credential.credentialId)) return 'bad-credential-id';
    if (seen.has(credential.credentialId)) return 'duplicate-credential';
    seen.add(credential.credentialId);
    if (!BINDING_ALGS.includes(credential.alg)) return 'bad-credential-alg';
    if (typeof credential.publicKeySpki !== 'string' || credential.publicKeySpki.length === 0
        || credential.publicKeySpki.length > MAX_SPKI_B64
        || !BASE64_PATTERN.test(credential.publicKeySpki)) return 'bad-credential-key';
    if (!Number.isSafeInteger(credential.addedAt) || credential.addedAt < 0) return 'bad-credential-added-at';
    if (credential.status !== 'active' && credential.status !== 'revoked') return 'bad-credential-status';
  }
  if (typeof binding.sig !== 'string' || binding.sig.length === 0 || binding.sig.length > 128) return 'bad-sig';
  return null;
};

/**
 * @param {any} binding
 * @param {{ expectedPersonDid?: string }} [expected]
 * @returns {Promise<{ ok: boolean, defect: string | null }>}
 */
export const verifyPasskeyBinding = async (binding, { expectedPersonDid } = {}) => {
  const defect = validatePasskeyBinding(binding);
  if (defect) return { ok: false, defect };
  if (expectedPersonDid !== undefined && binding.personDid !== expectedPersonDid) {
    return { ok: false, defect: 'person-did-mismatch' };
  }
  const { sig, ...unsigned } = binding;
  let verified = false;
  try {
    verified = await verifySignature(binding.personDid, fromBase64(sig), bindingSigningBytes(unsigned));
  } catch {
    return { ok: false, defect: 'bad-sig' };
  }
  return verified ? { ok: true, defect: null } : { ok: false, defect: 'signature-invalid' };
};

/**
 * Same anti-rollback rule as the device roster: strictly higher seq, same
 * person. A revoked credential can only stay revoked.
 *
 * @param {PasskeyBinding} candidate
 * @param {PasskeyBinding | null | undefined} held
 */
export const bindingSupersedes = (candidate, held) => {
  if (!held) return true;
  return candidate.personDid === held.personDid && candidate.seq > held.seq;
};

/**
 * Look an ACTIVE credential up by id. Revoked and unknown credentials both
 * return null: a revoked credential must be exactly as useless as one
 * that was never enrolled.
 *
 * @param {PasskeyBinding} binding
 * @param {string} credentialIdB64
 * @returns {BindingCredential | null}
 */
export const activeBindingCredential = (binding, credentialIdB64) => {
  const credential = binding.credentials.find(
    (row) => row.credentialId === credentialIdB64 && row.status === 'active',
  );
  return credential ?? null;
};
