// @ts-check
// peerd-distributed/identity/webauthn-verify.js — pure WebAuthn assertion
// verification against a passkey-binding credential.
//
// why peerd verifies assertions ITSELF: in the enrollment protocol
// (self/enroll.js) the verifier is another of the user's devices, not a
// server. The desktop holds the root-signed passkey binding (credential id +
// SPKI public key) and must check, offline, that the laptop's ceremony
// output really is a fresh, user-verified assertion by that credential at
// the canonical relying party. There is no backend to delegate to — the
// whole point is that there isn't one.
//
// Scope: assertion (navigator.credentials.get) verification only. Peerd
// never parses attestation objects — enrollment records the credential's
// public key via getPublicKey() SPKI at creation time on the device that
// created it, so no CBOR/COSE surface exists here at all.
//
// Everything is values-in/values-out WebCrypto; Bun runs the same code the
// browser does, so the adversarial suite exercises the real verifier.

import { toBase64, fromBase64, concat, utf8 } from '/shared/bundle/bytes.js';

// COSE → WebCrypto import/verify parameters. Only the three algorithms the
// binding record admits (passkey-binding.js BINDING_ALGS).
const ALG_ED25519 = -8;
const ALG_ES256 = -7;
const ALG_RS256 = -257;

const MAX_ASSERTION_FIELD_B64 = 16 * 1024;
// rpIdHash(32) + flags(1) + signCount(4); assertions may append extensions.
const MIN_AUTH_DATA_BYTES = 37;

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

/** @param {Uint8Array} bytes */
const toBase64Url = (bytes) =>
  toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/** @param {BufferSource} bytes */
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

/**
 * Parse the fixed head of authenticatorData. Extension/attested-credential
 * bytes past the head are ignored — the signature covers them, and this
 * verifier keys only on rpIdHash and the flags.
 *
 * @param {Uint8Array} authData
 * @returns {{ rpIdHash: Uint8Array, userPresent: boolean, userVerified: boolean,
 *   signCount: number } | null}
 */
export const parseAuthenticatorData = (authData) => {
  if (!(authData instanceof Uint8Array) || authData.length < MIN_AUTH_DATA_BYTES) return null;
  const flags = authData[32];
  const signCount = (authData[33] << 24 | authData[34] << 16 | authData[35] << 8 | authData[36]) >>> 0;
  return {
    rpIdHash: authData.slice(0, 32),
    userPresent: (flags & FLAG_USER_PRESENT) !== 0,
    userVerified: (flags & FLAG_USER_VERIFIED) !== 0,
    signCount,
  };
};

/**
 * WebAuthn ECDSA signatures arrive ASN.1 DER-encoded; WebCrypto verifies
 * raw r||s. Bounded structural parse — returns null on anything that is
 * not exactly SEQUENCE { INTEGER r, INTEGER s } with P-256-sized values.
 *
 * @param {Uint8Array} der
 * @returns {Uint8Array | null} 64 bytes (r||s, each left-padded to 32)
 */
export const ecdsaDerToRaw = (der) => {
  if (!(der instanceof Uint8Array) || der.length < 8 || der.length > 72) return null;
  if (der[0] !== 0x30) return null;
  if (der[1] !== der.length - 2) return null; // single-byte length only (≤ 70)
  /** @param {number} offset */
  const readInteger = (offset) => {
    if (der[offset] !== 0x02) return null;
    const length = der[offset + 1];
    if (!Number.isInteger(length) || length < 1 || length > 33) return null;
    const start = offset + 2;
    const end = start + length;
    if (end > der.length) return null;
    let value = der.slice(start, end);
    // A leading zero is DER's high-bit escape; more than one is malformed.
    if (value.length === 33) {
      if (value[0] !== 0x00) return null;
      value = value.slice(1);
    }
    if (value.length > 1 && value[0] === 0x00 && (value[1] & 0x80) === 0) return null;
    if (value.length > 32) return null;
    return { value, end };
  };
  const r = readInteger(2);
  if (!r) return null;
  const s = readInteger(r.end);
  if (!s || s.end !== der.length) return null;
  const raw = new Uint8Array(64);
  raw.set(r.value, 32 - r.value.length);
  raw.set(s.value, 64 - s.value.length);
  return raw;
};

/** @param {number} alg @param {Uint8Array} spki */
const importVerificationKey = (alg, spki) => {
  if (alg === ALG_ED25519) {
    return crypto.subtle.importKey('spki', /** @type {BufferSource} */ (spki), { name: 'Ed25519' }, false, ['verify']);
  }
  if (alg === ALG_ES256) {
    return crypto.subtle.importKey(
      'spki', /** @type {BufferSource} */ (spki), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    );
  }
  if (alg === ALG_RS256) {
    return crypto.subtle.importKey(
      'spki', /** @type {BufferSource} */ (spki),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
    );
  }
  throw new Error(`unsupported assertion algorithm ${alg}`);
};

/**
 * The wire shape of a ceremony result, every field base64 (the relay
 * serializes ArrayBuffers this way).
 * @typedef {{
 *   credentialId: string,
 *   authenticatorData: string,
 *   clientDataJSON: string,
 *   signature: string,
 * }} WirePasskeyAssertion
 */

/**
 * Verify a WebAuthn assertion against one binding credential.
 *
 * The checks, in dependency order — each names the exact trust property it
 * enforces:
 *   structure      bounded base64 fields, parseable authenticatorData
 *   credential     the assertion names the credential the caller resolved
 *   client data    type is webauthn.get (not a create() replay), the
 *                  challenge is OUR fresh challenge (replay resistance),
 *                  the origin is an allowed ceremony origin (no cross-site
 *                  relay), crossOrigin is not set (no embedded-frame relay)
 *   rp binding     rpIdHash is SHA-256 of the expected RP id
 *   user           user-verified flag set (Touch ID class verification,
 *                  not mere presence)
 *   signature      the credential's key signed authData || H(clientData)
 *
 * @param {Object} args
 * @param {WirePasskeyAssertion} args.assertion
 * @param {{ alg: number, publicKeySpki: string, credentialId: string }} args.credential
 *        the binding-record credential (passkey-binding.js shape)
 * @param {Uint8Array} args.expectedChallenge  the fresh challenge this
 *        verifier issued for this exact exchange
 * @param {string} args.expectedRpId
 * @param {string[]} args.allowedOrigins  exact ceremony origins
 * @returns {Promise<{ ok: boolean, defect: string | null }>}
 */
export const verifyPasskeyAssertion = async ({
  assertion, credential, expectedChallenge, expectedRpId, allowedOrigins,
}) => {
  if (!assertion || typeof assertion !== 'object') return { ok: false, defect: 'not-an-object' };
  for (const field of ['credentialId', 'authenticatorData', 'clientDataJSON', 'signature']) {
    const value = /** @type {any} */ (assertion)[field];
    if (typeof value !== 'string' || value.length === 0
        || value.length > MAX_ASSERTION_FIELD_B64) return { ok: false, defect: `bad-${field}` };
  }
  if (!(expectedChallenge instanceof Uint8Array) || expectedChallenge.length < 16) {
    return { ok: false, defect: 'bad-expected-challenge' };
  }
  if (assertion.credentialId !== credential.credentialId) {
    return { ok: false, defect: 'credential-mismatch' };
  }

  /** @type {Uint8Array} */
  let authData;
  /** @type {Uint8Array} */
  let clientDataBytes;
  /** @type {Uint8Array} */
  let signature;
  try {
    authData = fromBase64(assertion.authenticatorData);
    clientDataBytes = fromBase64(assertion.clientDataJSON);
    signature = fromBase64(assertion.signature);
  } catch {
    return { ok: false, defect: 'bad-base64' };
  }

  /** @type {any} */
  let clientData;
  try {
    clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
  } catch {
    return { ok: false, defect: 'bad-client-data' };
  }
  if (clientData?.type !== 'webauthn.get') return { ok: false, defect: 'not-an-assertion' };
  if (clientData.challenge !== toBase64Url(expectedChallenge)) {
    return { ok: false, defect: 'challenge-mismatch' };
  }
  if (typeof clientData.origin !== 'string' || !allowedOrigins.includes(clientData.origin)) {
    return { ok: false, defect: 'origin-not-allowed' };
  }
  if (clientData.crossOrigin === true) return { ok: false, defect: 'cross-origin-ceremony' };

  const parsed = parseAuthenticatorData(authData);
  if (!parsed) return { ok: false, defect: 'bad-authenticator-data' };
  const expectedRpIdHash = await sha256(utf8(expectedRpId));
  if (toBase64(parsed.rpIdHash) !== toBase64(expectedRpIdHash)) {
    return { ok: false, defect: 'rp-id-mismatch' };
  }
  if (!parsed.userPresent) return { ok: false, defect: 'user-not-present' };
  if (!parsed.userVerified) return { ok: false, defect: 'user-not-verified' };

  let signatureBytes = signature;
  if (credential.alg === ALG_ES256) {
    const raw = ecdsaDerToRaw(signature);
    if (!raw) return { ok: false, defect: 'bad-ecdsa-signature-encoding' };
    signatureBytes = raw;
  }

  const signedBytes = concat(authData, await sha256(/** @type {BufferSource} */ (clientDataBytes)));
  try {
    const key = await importVerificationKey(credential.alg, fromBase64(credential.publicKeySpki));
    const verifyParams = credential.alg === ALG_ES256
      ? { name: 'ECDSA', hash: 'SHA-256' }
      : credential.alg === ALG_ED25519 ? { name: 'Ed25519' } : { name: 'RSASSA-PKCS1-v1_5' };
    const verified = await crypto.subtle.verify(
      verifyParams, key,
      /** @type {BufferSource} */ (signatureBytes),
      /** @type {BufferSource} */ (signedBytes),
    );
    return verified ? { ok: true, defect: null } : { ok: false, defect: 'signature-invalid' };
  } catch {
    return { ok: false, defect: 'bad-credential-key' };
  }
};
