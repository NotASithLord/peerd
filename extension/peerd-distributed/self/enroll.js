// @ts-check
// peerd-distributed/self/enroll.js: the new-device enrollment protocol.
//
// The exchange runs between a NEW install (the enrollee, "B") and one of
// the person's EXISTING devices (the sponsor, "A"), over the enrollment
// rendezvous room, after the enrollee's passkey ceremony at the canonical
// relying party. It ends with the sponsor releasing the enrollment grant:
// a certificate for the enrollee's OWN device key, the roster that now
// names it, the self-device discovery secret, and the person's signed
// binding, everything a fresh install needs to act as one of this person's
// devices and find the others.
//
// What the grant deliberately does NOT contain: the person root seed.
//
// why, and it is the load-bearing decision in this file: the roster is a
// revocation mechanism, and revocation is only real if a revoked device
// cannot re-authorize itself. A device holding the root could mint a fresh
// device key, self-certify it, and sign a seq+1 roster marking itself
// active again, and every peer would accept it, because rosterSupersedes
// is "strictly higher seq under the same person" and the signature would be
// genuinely the person's. Distributing the root and claiming roster-based
// revocation are mutually exclusive designs; this one keeps revocation.
//
// So enrollment grants BOUNDED DEVICE AUTHORITY. The enrollee mints its own
// device key before the exchange and names it in the request; the sponsor,
// which does hold the root, is the only party that can certify it and issue
// the roster that includes it. An enrolled device can therefore prove
// same-person, discover its siblings, and sync state, and cannot enroll a
// further device, re-issue a roster, or survive its own revocation.
//
// Moving the ROOT between installs is a separate, explicit, user-driven act
// with its own consent surface: the encrypted recovery record
// (identity/recovery-record.js). It is not a side effect of adding a device.
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
import { decodeDidKey } from '../identity/did.js';
import { verifyPasskeyBinding, activeBindingCredential } from '../identity/passkey-binding.js';
import {
  verifyDeviceRoster, verifyDeviceCertificate, deviceStatusInRoster,
} from '../identity/device-certificate.js';
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
const MAX_DEVICE_ID = 64; // matches device-key.js's stored bound

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
 * The possession MAC over an ENROLL_REQ's identifying fields, including
 * the device the request asks to have certified. A relay that keeps the
 * MAC but swaps in its own device did produces a MAC mismatch, so it cannot
 * get an attacker-held key certified off the back of the person's ceremony.
 *
 * @param {Uint8Array} macKey
 * @param {{ credentialId: string, ephemeralKey: string, nonce: string,
 *   deviceDid: string, deviceId: string }} fields
 */
const requestMac = (macKey, { credentialId, ephemeralKey, nonce, deviceDid, deviceId }) =>
  hmac(macKey, concat(utf8(MAC_DOMAIN), Uint8Array.from([0]),
    utf8(canonicalize({ credentialId, ephemeralKey, nonce, deviceDid, deviceId }))));

/**
 * Enrollee → sponsor: open the exchange.
 *
 * The device did is minted BEFORE the request (custody.ensureEnrolleeDevice)
 * and named here: the sponsor certifies exactly this key, and this install
 * never sends the private half anywhere.
 *
 * @param {Object} args
 * @param {Uint8Array} args.macKey        deriveEnrollSecrets().macKey
 * @param {string} args.credentialId     base64, from the ceremony
 * @param {string} args.ephemeralKey     base64 SPKI of a fresh P-256 ECDH key
 * @param {string} args.deviceDid        this install's own device did:key
 * @param {string} args.deviceId         its stable install identifier
 */
export const buildEnrollRequest = async ({
  macKey, credentialId, ephemeralKey, deviceDid, deviceId,
}) => {
  const nonce = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  return {
    t: 'ENROLL_REQ',
    proto: ENROLL_PROTO,
    credentialId,
    ephemeralKey,
    nonce,
    deviceDid,
    deviceId,
    mac: toBase64(await requestMac(macKey, {
      credentialId, ephemeralKey, nonce, deviceDid, deviceId,
    })),
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
  for (const field of ['credentialId', 'ephemeralKey', 'nonce', 'mac', 'deviceDid', 'deviceId']) {
    const value = request[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FIELD_B64) {
      return { ok: false, defect: `bad-${field}` };
    }
  }
  if (request.deviceId.length > MAX_DEVICE_ID) return { ok: false, defect: 'bad-deviceId' };
  // The sponsor is about to SIGN a certificate naming this did; it must be a
  // real did:key before it can end up in a person-signed record.
  try { decodeDidKey(request.deviceDid); } catch { return { ok: false, defect: 'bad-deviceDid' }; }
  if (!activeBindingCredential(binding, request.credentialId)) {
    return { ok: false, defect: 'unknown-credential' };
  }
  let expected;
  try {
    expected = toBase64(await requestMac(macKey, {
      credentialId: request.credentialId,
      ephemeralKey: request.ephemeralKey,
      nonce: request.nonce,
      deviceDid: request.deviceDid,
      deviceId: request.deviceId,
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
 * enrollee ECDH key || enrollee device did). Both sides compute it: the
 * enrollee to run the ceremony, the sponsor to verify the assertion.
 *
 * It welds the assertion to two things at once: the key the grant will be
 * sealed TO, and the device key the grant will certify. A relay that swaps
 * either one invalidates the assertion it is relaying, so the person's
 * single Touch ID approval cannot be redirected into certifying somebody
 * else's device.
 *
 * @param {string} challengeB64   the sponsor's ENROLL_CHALLENGE value
 * @param {string} ephemeralKeyB64  the enrollee's P-256 SPKI
 * @param {string} deviceDid      the enrollee's device did:key
 * @returns {Promise<Uint8Array>} 32 bytes for prf-free credentials.get()
 */
export const enrollCeremonyChallenge = (challengeB64, ephemeralKeyB64, deviceDid) =>
  sha256(concat(
    utf8(CEREMONY_CHALLENGE_DOMAIN), Uint8Array.from([0]),
    fromBase64(challengeB64), Uint8Array.from([0]),
    fromBase64(ephemeralKeyB64), Uint8Array.from([0]),
    utf8(String(deviceDid)),
  ));

/**
 * Enrollee → sponsor: the ceremony result.
 * @param {{ assertion: import('../identity/webauthn-verify.js').WirePasskeyAssertion,
 *   ephemeralKey: string, deviceDid: string }} args
 */
export const buildEnrollProof = ({ assertion, ephemeralKey, deviceDid }) => ({
  t: 'ENROLL_PROOF',
  proto: ENROLL_PROTO,
  assertion,
  ephemeralKey,
  deviceDid,
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
 * @param {string} context.requestDeviceDid  from the same admitted ENROLL_REQ
 * @param {string[]} context.allowedOrigins
 * @returns {Promise<{ ok: boolean, defect: string | null }>}
 */
export const evaluateEnrollProof = async (proof, {
  binding, issuedChallenge, requestEphemeralKey, requestDeviceDid, allowedOrigins,
}) => {
  if (!proof || typeof proof !== 'object' || proof.t !== 'ENROLL_PROOF') {
    return { ok: false, defect: 'not-enroll-proof' };
  }
  if (proof.proto !== ENROLL_PROTO) return { ok: false, defect: 'unsupported-proto' };
  if (typeof proof.ephemeralKey !== 'string' || proof.ephemeralKey !== requestEphemeralKey) {
    return { ok: false, defect: 'ephemeral-key-mismatch' };
  }
  // The proof must name the same device the request did: the certificate the
  // sponsor is about to sign is for THAT key, so a proof that quietly
  // re-points it is a splice, refused here rather than certified.
  if (typeof proof.deviceDid !== 'string' || proof.deviceDid !== requestDeviceDid) {
    return { ok: false, defect: 'device-did-mismatch' };
  }
  const credentialId = proof.assertion?.credentialId;
  if (typeof credentialId !== 'string') return { ok: false, defect: 'bad-assertion' };
  const credential = activeBindingCredential(binding, credentialId);
  if (!credential) return { ok: false, defect: 'unknown-credential' };
  let expectedChallenge;
  try {
    expectedChallenge = await enrollCeremonyChallenge(
      issuedChallenge, proof.ephemeralKey, proof.deviceDid,
    );
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
 * The grant payload: everything a fresh install needs to ACT AS one of this
 * person's devices. It carries no private key of any kind: not the person
 * root (see the header: that is what makes revocation real), and not a
 * device key either, since the enrollee minted its own and the sponsor only
 * ever saw the public did.
 *
 * What it does carry is bounded, public, and revocable: the person's did,
 * a certificate binding the ENROLLEE'S device key to it, the roster that
 * now names that device, the person's signed passkey binding, and the
 * shared discovery secret that lets the devices find each other.
 *
 * @typedef {{
 *   v: number,
 *   personDid: string,
 *   deviceCertificate: import('../identity/device-certificate.js').DeviceCertificate,
 *   deviceRoster: import('../identity/device-certificate.js').DeviceRoster,
 *   discoverySecret: string,
 *   passkeyBinding: import('../identity/passkey-binding.js').PasskeyBinding,
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
 * anything is adopted. The chain is rooted in the person did the grant
 * names, and closes only when every record independently verifies UNDER
 * THAT DID, which an attacker without the person root cannot forge:
 *   - the certificate verifies under the claimed person did AND names OUR
 *     device did, so a hostile sponsor cannot hand back a certificate for
 *     some other key (nor for a device we do not hold the key to);
 *   - the roster verifies under the same did and lists our device ACTIVE,
 *     so an enrollment that is dead on arrival is refused here rather than
 *     discovered later at the first handshake;
 *   - the passkey binding verifies under the same did and lists, as
 *     active, exactly the credential this enrollee authenticated with, so
 *     a hostile sponsor on the topic cannot hand over a substitute
 *     identity built around someone else's credential;
 *   - the discovery secret is exactly the expected size.
 *
 * Note what is NOT checked, because it is not present: there is no root
 * material to validate. The enrollee never learns the person's signing
 * seed, and the did it adopts is the one every record above agrees on.
 *
 * @param {any} grant
 * @param {Object} context
 * @param {CryptoKey} context.enrolleePrivateKey
 * @param {string} context.enrolleeKey     our SPKI b64 (transcript element)
 * @param {string} context.issuedChallenge the sponsor challenge we answered
 * @param {string} context.credentialId    the credential we asserted with
 * @param {string} context.deviceDid       our own device did, the one we asked to have certified
 * @returns {Promise<{ ok: boolean, defect: string | null, payload: EnrollmentGrantPayload | null, did: string | null }>}
 */
export const openEnrollmentGrant = async (grant, {
  enrolleePrivateKey, enrolleeKey, issuedChallenge, credentialId, deviceDid,
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
  // A grant that still carries root material is a downgrade to the design
  // this version replaced: refuse it outright rather than quietly ignoring
  // the field, so an old or hostile sponsor cannot hand a new install the
  // person's signing seed.
  if (payload.material !== undefined) return refuse('root-material-present');

  const did = payload.personDid;
  try { decodeDidKey(did); } catch { return refuse('bad-person-did'); }

  const certVerdict = await verifyDeviceCertificate(payload.deviceCertificate, {
    expectedPersonDid: did, expectedDeviceDid: deviceDid,
  });
  if (!certVerdict.ok) return refuse(`certificate-${certVerdict.defect}`);
  const bindingVerdict = await verifyPasskeyBinding(payload.passkeyBinding, { expectedPersonDid: did });
  if (!bindingVerdict.ok) return refuse(`binding-${bindingVerdict.defect}`);
  if (!activeBindingCredential(payload.passkeyBinding, credentialId)) {
    return refuse('credential-not-bound');
  }
  const rosterVerdict = await verifyDeviceRoster(payload.deviceRoster, { expectedPersonDid: did });
  if (!rosterVerdict.ok) return refuse(`roster-${rosterVerdict.defect}`);
  if (deviceStatusInRoster(payload.deviceRoster, deviceDid) !== 'active') {
    return refuse('device-not-active-in-roster');
  }
  let secretBytes;
  try {
    secretBytes = fromBase64(payload.discoverySecret);
  } catch {
    return refuse('bad-discovery-secret');
  }
  if (secretBytes.length !== DISCOVERY_SECRET_BYTES) return refuse('bad-discovery-secret');
  return { ok: true, defect: null, payload, did };
};
