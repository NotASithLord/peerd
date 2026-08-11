// @ts-check
// peerd-distributed/self/enroll.js: the new-device enrollment protocol.
//
// The exchange runs between a NEW install (the enrollee, "B") and one of
// the person's EXISTING devices (the sponsor, "A"), over the enrollment
// rendezvous room, after the enrollee's passkey ceremony at the canonical
// relying party. It ends with the sponsor releasing the enrollment grant:
// the sealed identity material, the self-device discovery secret, and the
// person's signed records, everything a fresh install needs to become
// this person and find their devices.
//
// What each proof gates (and why all three exist):
//   possession MAC   HMAC keyed by a passkey-PRF-derived secret both ends
//                    hold. Cheap, silent, gates challenge issuance, a
//                    stranger on the topic cannot even make the sponsor
//                    mint challenges (anti-probing, anti-DoS).
//   assertion        a WebAuthn assertion over the sponsor's FRESH
//                    challenge, verified against the root-signed passkey
//                    binding (webauthn-verify.js). This is the load-bearing
//                    "the person is present and approved, now": the MAC
//                    secret alone is a bearer credential and must never be
//                    sufficient for a grant.
//   channel binding  the ceremony challenge is H(sponsor challenge ||
//                    enrollee ECDH key), so the assertion COMMITS to the
//                    key the grant will be sealed to. A relay that swaps
//                    in its own key invalidates the assertion it relays.
//
// The grant seal (ECDH P-256 → HKDF-SHA256 → AES-GCM) binds its KDF salt
// to the whole exchange (challenge, credential, both ephemeral keys), so a
// recorded grant is undecryptable outside the exact exchange it answered
// the #360 closure's "same request key accepts the same response
// repeatedly" cannot recur here.
//
// Pure protocol steps; challenge bookkeeping (single-use, expiry, rate
// caps) and transport belong to the hosts.

import { canonicalize } from '/shared/bundle/canonical.js';
import { utf8, concat, toBase64, fromBase64 } from '/shared/bundle/bytes.js';
import { assertIdentityMaterial } from '../identity/keypair.js';
import { verifyPasskeyBinding, activeBindingCredential } from '../identity/passkey-binding.js';
import { verifyDeviceRoster } from '../identity/device-certificate.js';
import { verifyPasskeyAssertion } from '../identity/webauthn-verify.js';
import { DISCOVERY_SECRET_BYTES } from './rendezvous.js';

export const ENROLL_PROTO = 1;
export const ENROLL_CHALLENGE_BYTES = 32;

// The fixed, purpose-tagged PRF input for enrollment discovery. Fixed is
// REQUIRED here (every device must derive the same secret) and safe
// BECAUSE the derived secret is never grant-sufficient: it gates discovery
// and challenge minting only; the grant additionally demands a fresh
// assertion. Disclosure of one PRF output therefore never becomes
// capsule-opening or enrollment authority on its own.
export const ENROLL_PRF_INPUT_TAG = 'peerd/enroll-discovery-prf/v1';
const ENROLL_TOPIC_INFO = 'peerd/enroll-topic/v1';
const ENROLL_MAC_INFO = 'peerd/enroll-mac/v1';
const CEREMONY_CHALLENGE_DOMAIN = 'peerd/enroll-ceremony-challenge/v1';
const SEAL_DOMAIN = 'peerd/enroll-seal/v1';
const MAC_DOMAIN = 'peerd/enroll-req-mac/v1';

const GRANT_VERSION = 1;
const IV_BYTES = 12;
const MAX_FIELD_B64 = 16 * 1024;
const MAX_GRANT_CT_B64 = 64 * 1024;

/** @param {BufferSource} bytes */
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

/** The PRF input WebAuthn evaluates, fixed bytes, derived from the tag. */
export const enrollPrfInput = () => utf8(ENROLL_PRF_INPUT_TAG);

/**
 * Derive the two enrollment-discovery secrets from a passkey PRF output.
 * Sponsors store exactly this pair at binding time (never the raw PRF
 * output); enrollees derive it fresh in the ceremony.
 *
 * @param {Uint8Array} prfOutput  32 bytes from the authenticator
 * @returns {Promise<{ topicSecret: Uint8Array, macKey: Uint8Array }>}
 */
export const deriveEnrollSecrets = async (prfOutput) => {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.length !== 32) {
    throw new Error('enrollment PRF output must be 32 bytes');
  }
  const key = await crypto.subtle.importKey(
    'raw', /** @type {BufferSource} */ (prfOutput), 'HKDF', false, ['deriveBits'],
  );
  /** @param {string} info */
  const derive = async (info) => new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8(info) },
    key, DISCOVERY_SECRET_BYTES * 8,
  ));
  return { topicSecret: await derive(ENROLL_TOPIC_INFO), macKey: await derive(ENROLL_MAC_INFO) };
};

/** @param {Uint8Array} macKey @param {Uint8Array} message */
const hmac = async (macKey, message) => {
  const key = await crypto.subtle.importKey(
    'raw', /** @type {BufferSource} */ (macKey),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, /** @type {BufferSource} */ (message)));
};

/**
 * The possession MAC over an ENROLL_REQ's identifying fields.
 * @param {Uint8Array} macKey
 * @param {{ credentialId: string, ephemeralKey: string, nonce: string }} fields
 */
const requestMac = (macKey, { credentialId, ephemeralKey, nonce }) =>
  hmac(macKey, concat(utf8(MAC_DOMAIN), Uint8Array.from([0]),
    utf8(canonicalize({ credentialId, ephemeralKey, nonce }))));

/**
 * Enrollee → sponsor: open the exchange.
 * @param {Object} args
 * @param {Uint8Array} args.macKey        deriveEnrollSecrets().macKey
 * @param {string} args.credentialId     base64, from the ceremony
 * @param {string} args.ephemeralKey     base64 SPKI of a fresh P-256 ECDH key
 */
export const buildEnrollRequest = async ({ macKey, credentialId, ephemeralKey }) => {
  const nonce = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  return {
    t: 'ENROLL_REQ',
    proto: ENROLL_PROTO,
    credentialId,
    ephemeralKey,
    nonce,
    mac: toBase64(await requestMac(macKey, { credentialId, ephemeralKey, nonce })),
  };
};

/**
 * Sponsor: admit or refuse an ENROLL_REQ. A bad MAC means the sender never
 * ran the passkey ceremony, refuse before minting any challenge state.
 *
 * @param {any} request
 * @param {{ macKey: Uint8Array, binding: import('../identity/passkey-binding.js').PasskeyBinding }} context
 * @returns {Promise<{ ok: boolean, defect: string | null }>}
 */
export const evaluateEnrollRequest = async (request, { macKey, binding }) => {
  if (!request || typeof request !== 'object' || request.t !== 'ENROLL_REQ') {
    return { ok: false, defect: 'not-enroll-req' };
  }
  if (request.proto !== ENROLL_PROTO) return { ok: false, defect: 'unsupported-proto' };
  for (const field of ['credentialId', 'ephemeralKey', 'nonce', 'mac']) {
    const value = request[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FIELD_B64) {
      return { ok: false, defect: `bad-${field}` };
    }
  }
  if (!activeBindingCredential(binding, request.credentialId)) {
    return { ok: false, defect: 'unknown-credential' };
  }
  let expected;
  try {
    expected = toBase64(await requestMac(macKey, {
      credentialId: request.credentialId,
      ephemeralKey: request.ephemeralKey,
      nonce: request.nonce,
    }));
  } catch {
    return { ok: false, defect: 'bad-mac' };
  }
  if (expected !== request.mac) return { ok: false, defect: 'mac-mismatch' };
  return { ok: true, defect: null };
};

/** Sponsor → enrollee: a fresh, single-use challenge (host tracks expiry). */
export const buildEnrollChallenge = () => ({
  t: 'ENROLL_CHALLENGE',
  proto: ENROLL_PROTO,
  challenge: toBase64(crypto.getRandomValues(new Uint8Array(ENROLL_CHALLENGE_BYTES))),
});

/**
 * The WebAuthn challenge for the ceremony: H(domain || sponsor challenge ||
 * enrollee ECDH key). Both sides compute it: the enrollee to run the
 * ceremony, the sponsor to verify the assertion, which is what welds the
 * assertion to the key the grant will be sealed to.
 *
 * @param {string} challengeB64   the sponsor's ENROLL_CHALLENGE value
 * @param {string} ephemeralKeyB64  the enrollee's P-256 SPKI
 * @returns {Promise<Uint8Array>} 32 bytes for prf-free credentials.get()
 */
export const enrollCeremonyChallenge = (challengeB64, ephemeralKeyB64) =>
  sha256(concat(
    utf8(CEREMONY_CHALLENGE_DOMAIN), Uint8Array.from([0]),
    fromBase64(challengeB64), Uint8Array.from([0]),
    fromBase64(ephemeralKeyB64),
  ));

/**
 * Enrollee → sponsor: the ceremony result.
 * @param {{ assertion: import('../identity/webauthn-verify.js').WirePasskeyAssertion,
 *   ephemeralKey: string }} args
 */
export const buildEnrollProof = ({ assertion, ephemeralKey }) => ({
  t: 'ENROLL_PROOF',
  proto: ENROLL_PROTO,
  assertion,
  ephemeralKey,
});

/**
 * Sponsor: the grant decision. Verifies the assertion against the binding
 * record with the recomputed channel-bound challenge. The caller supplies
 * the challenge IT issued for this link (single-use bookkeeping is the
 * host's) and the ephemeral key from the original ENROLL_REQ: a proof
 * whose key differs from its request's is a splice, refused here.
 *
 * @param {any} proof
 * @param {Object} context
 * @param {import('../identity/passkey-binding.js').PasskeyBinding} context.binding
 * @param {string} context.issuedChallenge  base64, what this sponsor issued
 * @param {string} context.requestEphemeralKey  base64, from the admitted ENROLL_REQ
 * @param {string[]} context.allowedOrigins
 * @returns {Promise<{ ok: boolean, defect: string | null }>}
 */
export const evaluateEnrollProof = async (proof, {
  binding, issuedChallenge, requestEphemeralKey, allowedOrigins,
}) => {
  if (!proof || typeof proof !== 'object' || proof.t !== 'ENROLL_PROOF') {
    return { ok: false, defect: 'not-enroll-proof' };
  }
  if (proof.proto !== ENROLL_PROTO) return { ok: false, defect: 'unsupported-proto' };
  if (typeof proof.ephemeralKey !== 'string' || proof.ephemeralKey !== requestEphemeralKey) {
    return { ok: false, defect: 'ephemeral-key-mismatch' };
  }
  const credentialId = proof.assertion?.credentialId;
  if (typeof credentialId !== 'string') return { ok: false, defect: 'bad-assertion' };
  const credential = activeBindingCredential(binding, credentialId);
  if (!credential) return { ok: false, defect: 'unknown-credential' };
  let expectedChallenge;
  try {
    expectedChallenge = await enrollCeremonyChallenge(issuedChallenge, proof.ephemeralKey);
  } catch {
    return { ok: false, defect: 'bad-challenge' };
  }
  const verdict = await verifyPasskeyAssertion({
    assertion: proof.assertion,
    credential,
    expectedChallenge,
    expectedRpId: binding.rpId,
    allowedOrigins,
  });
  return verdict.ok ? { ok: true, defect: null } : { ok: false, defect: `assertion-${verdict.defect}` };
};

// ── the sealed grant ─────────────────────────────────────────────────

/** @returns {Promise<{ publicKey: CryptoKey, privateKey: CryptoKey }>} */
export const mintEnrollmentKeyPair = () => /** @type {Promise<CryptoKeyPair>} */ (
  crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
);

/** @param {CryptoKey} publicKey */
export const exportEnrollmentPublicKey = async (publicKey) =>
  toBase64(new Uint8Array(await crypto.subtle.exportKey('spki', publicKey)));

/** @param {string} spkiB64 */
const importEnrollmentPublicKey = (spkiB64) => crypto.subtle.importKey(
  'spki', /** @type {BufferSource} */ (fromBase64(spkiB64)),
  { name: 'ECDH', namedCurve: 'P-256' }, false, [],
);

/**
 * The exchange-bound AES-GCM key both ends derive. Salting the HKDF with
 * every identifying element of the exchange means this key exists for ONE
 * (challenge, credential, enrollee key, sponsor key) tuple and no other.
 *
 * @param {CryptoKey} ownPrivateKey
 * @param {string} peerPublicKeyB64
 * @param {{ challenge: string, credentialId: string, enrolleeKey: string, sponsorKey: string }} transcript
 */
const deriveGrantKey = async (ownPrivateKey, peerPublicKeyB64, transcript) => {
  const peerKey = await importEnrollmentPublicKey(peerPublicKeyB64);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerKey }, ownPrivateKey, 256,
  ));
  try {
    const salt = await sha256(concat(
      utf8(SEAL_DOMAIN), Uint8Array.from([0]), utf8(canonicalize(transcript)),
    ));
    const hkdfKey = await crypto.subtle.importKey(
      'raw', /** @type {BufferSource} */ (shared), 'HKDF', false, ['deriveBits'],
    );
    const keyBytes = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: utf8(SEAL_DOMAIN) }, hkdfKey, 256,
    ));
    try {
      return await crypto.subtle.importKey(
        'raw', /** @type {BufferSource} */ (keyBytes),
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
      );
    } finally {
      keyBytes.fill(0);
    }
  } finally {
    shared.fill(0);
  }
};

/**
 * The grant payload, everything a fresh install needs to become this
 * person. Never includes any DEVICE private key: the enrollee mints its
 * own and (holding the root after adoption) certifies it locally.
 *
 * @typedef {{
 *   v: number,
 *   material: { seed: string, pub: string },
 *   discoverySecret: string,
 *   passkeyBinding: import('../identity/passkey-binding.js').PasskeyBinding,
 *   deviceRoster: import('../identity/device-certificate.js').DeviceRoster,
 * }} EnrollmentGrantPayload
 */

/**
 * Sponsor: seal the grant to the (assertion-committed) enrollee key.
 *
 * @param {Object} args
 * @param {EnrollmentGrantPayload} args.payload
 * @param {string} args.enrolleeKey  base64 SPKI from the verified proof
 * @param {string} args.issuedChallenge
 * @param {string} args.credentialId
 * @returns {Promise<{ t: string, proto: number, sponsorKey: string, iv: string, ct: string }>}
 */
export const sealEnrollmentGrant = async ({
  payload, enrolleeKey, issuedChallenge, credentialId,
}) => {
  const sponsorPair = await mintEnrollmentKeyPair();
  const sponsorKey = await exportEnrollmentPublicKey(sponsorPair.publicKey);
  const key = await deriveGrantKey(sponsorPair.privateKey, enrolleeKey, {
    challenge: issuedChallenge, credentialId, enrolleeKey, sponsorKey,
  });
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = utf8(JSON.stringify({ ...payload, v: GRANT_VERSION }));
  try {
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, /** @type {BufferSource} */ (plaintext),
    ));
    return { t: 'ENROLL_GRANT', proto: ENROLL_PROTO, sponsorKey, iv: toBase64(iv), ct: toBase64(ct) };
  } finally {
    plaintext.fill(0);
  }
};

/**
 * Enrollee: open the grant and verify the whole trust chain before
 * anything is adopted. The chain closes only when:
 *   - the material is a real keypair (seed proves control of pub) whose
 *     did we now know;
 *   - the passkey binding VERIFIES UNDER THAT DID and lists, as active,
 *     exactly the credential this enrollee authenticated with, an
 *     attacker without the person root cannot forge that record around
 *     someone else's credential, so a hostile sponsor on the topic cannot
 *     hand over a substitute identity;
 *   - the device roster verifies under the same did;
 *   - the discovery secret is exactly the expected size.
 *
 * @param {any} grant
 * @param {Object} context
 * @param {CryptoKey} context.enrolleePrivateKey
 * @param {string} context.enrolleeKey     our SPKI b64 (transcript element)
 * @param {string} context.issuedChallenge the sponsor challenge we answered
 * @param {string} context.credentialId    the credential we asserted with
 * @returns {Promise<{ ok: boolean, defect: string | null, payload: EnrollmentGrantPayload | null, did: string | null }>}
 */
export const openEnrollmentGrant = async (grant, {
  enrolleePrivateKey, enrolleeKey, issuedChallenge, credentialId,
}) => {
  /** @param {string} defect */
  const refuse = (defect) => ({ ok: false, defect, payload: null, did: null });
  if (!grant || typeof grant !== 'object' || grant.t !== 'ENROLL_GRANT') return refuse('not-enroll-grant');
  if (grant.proto !== ENROLL_PROTO) return refuse('unsupported-proto');
  for (const field of ['sponsorKey', 'iv', 'ct']) {
    const value = grant[field];
    const cap = field === 'ct' ? MAX_GRANT_CT_B64 : MAX_FIELD_B64;
    if (typeof value !== 'string' || value.length === 0 || value.length > cap) {
      return refuse(`bad-${field}`);
    }
  }
  /** @type {any} */
  let payload;
  try {
    const key = await deriveGrantKey(enrolleePrivateKey, grant.sponsorKey, {
      challenge: issuedChallenge, credentialId, enrolleeKey, sponsorKey: grant.sponsorKey,
    });
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: /** @type {BufferSource} */ (fromBase64(grant.iv)) },
      key, /** @type {BufferSource} */ (fromBase64(grant.ct)),
    ));
    try {
      payload = JSON.parse(new TextDecoder().decode(plaintext));
    } finally {
      plaintext.fill(0);
    }
  } catch {
    return refuse('open-failed');
  }
  if (payload?.v !== GRANT_VERSION) return refuse('unsupported-payload');

  let did;
  try {
    did = await assertIdentityMaterial(payload.material);
  } catch {
    return refuse('bad-material');
  }
  const bindingVerdict = await verifyPasskeyBinding(payload.passkeyBinding, { expectedPersonDid: did });
  if (!bindingVerdict.ok) return refuse(`binding-${bindingVerdict.defect}`);
  if (!activeBindingCredential(payload.passkeyBinding, credentialId)) {
    return refuse('credential-not-bound');
  }
  const rosterVerdict = await verifyDeviceRoster(payload.deviceRoster, { expectedPersonDid: did });
  if (!rosterVerdict.ok) return refuse(`roster-${rosterVerdict.defect}`);
  let secretBytes;
  try {
    secretBytes = fromBase64(payload.discoverySecret);
  } catch {
    return refuse('bad-discovery-secret');
  }
  if (secretBytes.length !== DISCOVERY_SECRET_BYTES) return refuse('bad-discovery-secret');
  return { ok: true, defect: null, payload, did };
};
