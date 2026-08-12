// @ts-check
// peerd-distributed/self/enroll.js: the new-device enrollment protocol.
//
// The exchange runs between a NEW install (the enrollee, "B") and one of
// the person's EXISTING devices (the sponsor, "A"), over the enrollment
// rendezvous room, after the enrollee's passkey ceremony at the canonical
// relying party. It ends with the sponsor releasing a grant containing the
// certificate for the enrollee's pre-minted device key, the self-device
// discovery secret, and the person's signed public records. The permanent
// person-root seed is never copied to an ordinary enrolled device.
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
import {
  verifyPasskeyBinding, validatePasskeyBinding, activeBindingCredential,
} from '../identity/passkey-binding.js';
import {
  verifyDeviceCertificate, validateDeviceCertificate,
  verifyDeviceRoster, validateDeviceRoster, deviceStatusInRoster,
} from '../identity/device-certificate.js';
import { verifyPasskeyAssertion } from '../identity/webauthn-verify.js';
import { decodeDidKey } from '../identity/did.js';
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
const ENROLL_IDENTITY_BINDING_INFO = 'peerd/enroll-identity-binding-key/v1';
const ENROLL_IDENTITY_BINDING_DOMAIN = 'peerd/enroll-identity-binding/v1';
const CEREMONY_CHALLENGE_DOMAIN = 'peerd/enroll-ceremony-challenge/v1';
const SEAL_DOMAIN = 'peerd/enroll-seal/v1';
const MAC_DOMAIN = 'peerd/enroll-req-mac/v1';

const GRANT_VERSION = 1;
const IV_BYTES = 12;
const MAX_FIELD_B64 = 16 * 1024;
const MAX_GRANT_CT_B64 = 64 * 1024;
const GRANT_PAYLOAD_FIELDS = Object.freeze([
  'v', 'personDid', 'deviceCertificate', 'deviceRoster',
  'discoverySecret', 'passkeyBinding',
]);

/** @param {any} payload */
const unexpectedGrantPayloadField = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'not-an-object';
  const allowed = new Set(GRANT_PAYLOAD_FIELDS);
  return Object.keys(payload).find((field) => !allowed.has(field)) ?? null;
};

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

/**
 * Derive the sponsor-independent commitment that binds one passkey
 * credential to the person root. The founder stores only the commitment in
 * the root-signed binding. Sponsors keep topicSecret/macKey, never this
 * domain's key, so a hostile sponsor cannot copy a credential's public row
 * into a binding for a substitute root.
 *
 * @param {Uint8Array} prfOutput
 * @param {{ personDid: string, credentialId: string, alg: number,
 *   publicKeySpki: string }} record
 * @returns {Promise<string>} padded standard base64, 32-byte HMAC
 */
export const deriveEnrollIdentityCommitment = async (prfOutput, record) => {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.length !== 32) {
    throw new Error('enrollment PRF output must be 32 bytes');
  }
  const source = await crypto.subtle.importKey(
    'raw', /** @type {BufferSource} */ (prfOutput), 'HKDF', false, ['deriveBits'],
  );
  const commitmentKey = new Uint8Array(await crypto.subtle.deriveBits(
    {
      name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32),
      info: utf8(ENROLL_IDENTITY_BINDING_INFO),
    },
    source, 256,
  ));
  try {
    const message = concat(
      utf8(ENROLL_IDENTITY_BINDING_DOMAIN), Uint8Array.from([0]),
      utf8(canonicalize({
        personDid: record.personDid,
        credentialId: record.credentialId,
        alg: record.alg,
        publicKeySpki: record.publicKeySpki,
      })),
    );
    return toBase64(await hmac(commitmentKey, message));
  } finally {
    commitmentKey.fill(0);
  }
};

/**
 * @param {Uint8Array} prfOutput
 * @param {import('../identity/passkey-binding.js').PasskeyBinding} binding
 * @param {import('../identity/passkey-binding.js').BindingCredential} credential
 */
export const verifyEnrollIdentityCommitment = async (prfOutput, binding, credential) => {
  try {
    const expected = await deriveEnrollIdentityCommitment(prfOutput, {
      personDid: binding.personDid,
      credentialId: credential.credentialId,
      alg: credential.alg,
      publicKeySpki: credential.publicKeySpki,
    });
    // Both values are fixed-length HMACs. WebCrypto already computed the
    // secret-dependent half; compare without early exit for consistency.
    const actual = fromBase64(credential.identityCommitment);
    const want = fromBase64(expected);
    if (actual.length !== want.length) return false;
    let mismatch = 0;
    for (let i = 0; i < want.length; i++) mismatch |= actual[i] ^ want[i];
    return mismatch === 0;
  } catch {
    return false;
  }
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
 * @param {{ credentialId: string, ephemeralKey: string, nonce: string,
 *   deviceDid: string, deviceId: string }} fields
 */
const requestMac = (macKey, { credentialId, ephemeralKey, nonce, deviceDid, deviceId }) =>
  hmac(macKey, concat(utf8(MAC_DOMAIN), Uint8Array.from([0]),
    utf8(canonicalize({ credentialId, ephemeralKey, nonce, deviceDid, deviceId }))));

/**
 * Enrollee → sponsor: open the exchange.
 * @param {Object} args
 * @param {Uint8Array} args.macKey        deriveEnrollSecrets().macKey
 * @param {string} args.credentialId     base64, from the ceremony
 * @param {string} args.ephemeralKey     base64 SPKI of a fresh P-256 ECDH key
 * @param {string} args.deviceDid        pre-minted device signing key
 * @param {string} args.deviceId         local stable installation id
 */
export const buildEnrollRequest = async ({
  macKey, credentialId, ephemeralKey, deviceDid, deviceId,
}) => {
  const nonce = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  if (typeof deviceDid !== 'string' || typeof deviceId !== 'string'
      || deviceId.length === 0 || deviceId.length > 64) {
    throw new Error('enrollment request requires a bounded device identity');
  }
  return {
    t: 'ENROLL_REQ',
    proto: ENROLL_PROTO,
    credentialId,
    ephemeralKey,
    deviceDid,
    deviceId,
    nonce,
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
  for (const field of ['credentialId', 'ephemeralKey', 'deviceDid', 'deviceId', 'nonce', 'mac']) {
    const value = request[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FIELD_B64) {
      return { ok: false, defect: `bad-${field}` };
    }
  }
  try { decodeDidKey(request.deviceDid); } catch { return { ok: false, defect: 'bad-deviceDid' }; }
  if (request.deviceId.length > 64) return { ok: false, defect: 'bad-deviceId' };
  if (!activeBindingCredential(binding, request.credentialId)) {
    return { ok: false, defect: 'unknown-credential' };
  }
  let expected;
  try {
    expected = toBase64(await requestMac(macKey, {
      credentialId: request.credentialId,
      ephemeralKey: request.ephemeralKey,
      deviceDid: request.deviceDid,
      deviceId: request.deviceId,
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
 * enrollee ECDH key || device key). Both sides compute it: the enrollee to run the
 * ceremony, the sponsor to verify the assertion, which is what welds the
 * assertion to the key the grant will be sealed to.
 *
 * @param {string} challengeB64   the sponsor's ENROLL_CHALLENGE value
 * @param {string} ephemeralKeyB64  the enrollee's P-256 SPKI
 * @param {string} deviceDid  the device signing key the sponsor will certify
 * @returns {Promise<Uint8Array>} 32 bytes for prf-free credentials.get()
 */
export const enrollCeremonyChallenge = (challengeB64, ephemeralKeyB64, deviceDid) =>
  sha256(concat(
    utf8(CEREMONY_CHALLENGE_DOMAIN), Uint8Array.from([0]),
    fromBase64(challengeB64), Uint8Array.from([0]),
    fromBase64(ephemeralKeyB64), Uint8Array.from([0]), utf8(deviceDid),
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
 * @param {string} context.requestDeviceDid  device did from the admitted ENROLL_REQ
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
 * The grant payload, everything a fresh install needs to act as a certified
 * device of this person. It carries no private signing key: the enrollee
 * minted its device key locally and the sponsor certified only its public DID.
 *
 * @typedef {{
 *   v: number,
 *   personDid: string,
 *   deviceCertificate: import('../identity/device-certificate.js').DeviceCertificate,
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
  // Version 1 grants are certificate-only. Exact-field validation prevents a
  // caller from accidentally reintroducing the person seed under any extension
  // field without a protocol/version review.
  const unexpected = unexpectedGrantPayloadField(payload);
  if (unexpected) throw new Error(`enrollment grant payload field is not allowed: ${unexpected}`);
  const certDefect = validateDeviceCertificate(payload.deviceCertificate);
  const rosterDefect = validateDeviceRoster(payload.deviceRoster);
  const bindingDefect = validatePasskeyBinding(payload.passkeyBinding);
  if (certDefect) throw new Error(`enrollment grant certificate is malformed: ${certDefect}`);
  if (rosterDefect) throw new Error(`enrollment grant roster is malformed: ${rosterDefect}`);
  if (bindingDefect) throw new Error(`enrollment grant binding is malformed: ${bindingDefect}`);
  let discoveryBytes;
  try { discoveryBytes = fromBase64(payload.discoverySecret); } catch { discoveryBytes = null; }
  if (discoveryBytes?.length !== DISCOVERY_SECRET_BYTES) {
    throw new Error('enrollment grant discovery secret is invalid');
  }
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
 *   - the sponsor-issued certificate names the device key minted locally;
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
 * @param {Uint8Array} context.prfOutput   fresh output from that assertion;
 *        never supplied by or recovered from the sponsor
 * @param {string} context.expectedDeviceDid local device signing DID
 * @param {string} [context.deviceDid] PR398 alias for expectedDeviceDid
 * @param {string} [context.expectedDeviceId] local stable installation id
 * @returns {Promise<{ ok: boolean, defect: string | null, payload: EnrollmentGrantPayload | null, did: string | null }>}
 */
export const openEnrollmentGrant = async (grant, {
  enrolleePrivateKey, enrolleeKey, issuedChallenge, credentialId, prfOutput,
  expectedDeviceDid, deviceDid, expectedDeviceId,
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
  const unexpected = unexpectedGrantPayloadField(payload);
  if (unexpected === 'material') return refuse('root-material-present');
  if (unexpected) return refuse('unexpected-payload-field');

  const did = payload.personDid;
  try { decodeDidKey(did); } catch { return refuse('bad-person-did'); }
  const localDeviceDid = expectedDeviceDid ?? deviceDid;
  if (typeof localDeviceDid !== 'string') return refuse('expected-device-did-required');
  const bindingVerdict = await verifyPasskeyBinding(payload.passkeyBinding, { expectedPersonDid: did });
  if (!bindingVerdict.ok) return refuse(`binding-${bindingVerdict.defect}`);
  const credential = activeBindingCredential(payload.passkeyBinding, credentialId);
  if (!credential) {
    return refuse('credential-not-bound');
  }
  if (!(await verifyEnrollIdentityCommitment(prfOutput, payload.passkeyBinding, credential))) {
    return refuse('identity-commitment-mismatch');
  }
  const certificateVerdict = await verifyDeviceCertificate(payload.deviceCertificate, {
    expectedPersonDid: did, expectedDeviceDid: localDeviceDid,
  });
  if (!certificateVerdict.ok
      || (expectedDeviceId !== undefined && payload.deviceCertificate.deviceId !== expectedDeviceId)) {
    return refuse(`certificate-${certificateVerdict.defect ?? 'device-id-mismatch'}`);
  }
  const rosterVerdict = await verifyDeviceRoster(payload.deviceRoster, { expectedPersonDid: did });
  if (!rosterVerdict.ok) return refuse(`roster-${rosterVerdict.defect}`);
  const rosterEntry = payload.deviceRoster.devices.find((/** @type {any} */ entry) =>
    entry.deviceDid === localDeviceDid);
  const expectedRosterDeviceId = expectedDeviceId ?? payload.deviceCertificate.deviceId;
  if (deviceStatusInRoster(payload.deviceRoster, localDeviceDid) !== 'active'
      || rosterEntry?.deviceId !== expectedRosterDeviceId) return refuse('roster-device-not-active');
  let secretBytes;
  try {
    secretBytes = fromBase64(payload.discoverySecret);
  } catch {
    return refuse('bad-discovery-secret');
  }
  if (secretBytes.length !== DISCOVERY_SECRET_BYTES) return refuse('bad-discovery-secret');
  return { ok: true, defect: null, payload, did };
};
