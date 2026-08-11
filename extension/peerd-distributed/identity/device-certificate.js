// @ts-check
// peerd-distributed/identity/device-certificate.js, person-root-signed
// device certificates and the revocation roster.
//
// The trust statement a certificate makes is deliberately minimal
// (docs/design/portable-identity/03): "this device key is authorized to act
// as a device belonging to this person did": no capabilities, no scopes.
// Anything richer belongs in a later, separately-reviewed record.
//
// Two record kinds, two signature domains:
//   certificate  peerd/device-cert/v1, issued once per device key
//   roster       peerd/device-roster/v1: the person's CURRENT device set,
//                a monotonically-sequenced snapshot whose entries can mark a
//                device revoked without changing the person did
//
// why a roster and not per-cert expiry: a browser extension has no reliable
// wall clock the verifier can trust against a peer's forged timestamp, and
// short-lived certs would need an online issuer (the person root) at renew
// time: exactly the always-on infrastructure peerd doesn't have. Revocation
// by superseding snapshot reuses the DHT records' anti-rollback shape (seq
// only ever rises) and stays verifiable offline.
//
// Everything here is pure: values in, values out, WebCrypto only. IO
// (where certs/rosters are stored, how they travel) belongs to callers.

import { canonicalize } from '/shared/bundle/canonical.js';
import { utf8, concat, toBase64, fromBase64 } from '/shared/bundle/bytes.js';
import { decodeDidKey } from './did.js';
import { verifySignature } from './keypair.js';

export const DEVICE_CERT_VERSION = 1;
export const DEVICE_ROSTER_VERSION = 1;
const CERT_DOMAIN = 'peerd/device-cert/v1';
const ROSTER_DOMAIN = 'peerd/device-roster/v1';

const MAX_LABEL_LENGTH = 64;
const MAX_DEVICE_ID_LENGTH = 64;
export const MAX_ROSTER_DEVICES = 32;

/**
 * @typedef {{ did: string, sign: (bytes: Uint8Array) => Promise<Uint8Array> }} Signer
 *
 * A device certificate. `sig` is the person root's Ed25519 signature over
 * the domain-separated canonical form of the other fields.
 * @typedef {{
 *   v: number,
 *   personDid: string,
 *   deviceDid: string,
 *   deviceId: string,
 *   label?: string,
 *   issuedAt: number,
 *   seq: number,
 *   sig: string,
 * }} DeviceCertificate
 *
 * One roster row. status is the whole revocation mechanism: a revoked row
 * in a NEWER roster supersedes any certificate's standing.
 * @typedef {{ deviceDid: string, deviceId: string, label?: string,
 *   addedAt: number, status: 'active' | 'revoked' }} RosterEntry
 *
 * The person's signed device set.
 * @typedef {{ v: number, personDid: string, seq: number,
 *   devices: RosterEntry[], sig: string }} DeviceRoster
 */

/** @param {Omit<DeviceCertificate, 'sig'>} cert */
const certSigningBytes = (cert) =>
  concat(utf8(CERT_DOMAIN), Uint8Array.from([0]), utf8(canonicalize(cert)));

/** @param {Omit<DeviceRoster, 'sig'>} roster */
const rosterSigningBytes = (roster) =>
  concat(utf8(ROSTER_DOMAIN), Uint8Array.from([0]), utf8(canonicalize(roster)));

/**
 * Issue a certificate for a device key. The signer must BE the person
 * root: the resulting personDid is taken from it, never from an argument,
 * so a caller cannot mint a certificate naming a did it doesn't control.
 *
 * @param {Object} args
 * @param {Signer} args.personIdentity  the person root
 * @param {string} args.deviceDid       did:key of the device public key
 * @param {string} args.deviceId        stable install identifier
 * @param {string} [args.label]         human-readable device name
 * @param {number} [args.seq]           issue sequence (default 1)
 * @param {number} [args.now]           injectable clock for tests
 * @returns {Promise<DeviceCertificate>}
 */
export const issueDeviceCertificate = async ({
  personIdentity, deviceDid, deviceId, label, seq = 1, now,
}) => {
  /** @type {Omit<DeviceCertificate, 'sig'>} */
  const unsigned = {
    v: DEVICE_CERT_VERSION,
    personDid: personIdentity.did,
    deviceDid,
    deviceId,
    ...(typeof label === 'string' && label.length > 0 ? { label } : {}),
    issuedAt: now ?? Date.now(),
    seq,
  };
  const defect = validateDeviceCertificate({ ...unsigned, sig: 'A'.repeat(88) });
  if (defect) throw new Error(`refusing to issue an invalid device certificate: ${defect}`);
  const sig = await personIdentity.sign(certSigningBytes(unsigned));
  return { ...unsigned, sig: toBase64(sig) };
};

/**
 * Structural validation, cheap, pure, no crypto. Returns a defect string
 * or null. Every field an untrusted peer could inflate is bounded here
 * BEFORE any base58/signature work.
 *
 * @param {any} cert
 * @returns {string | null}
 */
export const validateDeviceCertificate = (cert) => {
  if (!cert || typeof cert !== 'object') return 'not-an-object';
  if (cert.v !== DEVICE_CERT_VERSION) return `unsupported-version-${cert.v}`;
  try { decodeDidKey(cert.personDid); } catch { return 'bad-person-did'; }
  try { decodeDidKey(cert.deviceDid); } catch { return 'bad-device-did'; }
  if (cert.personDid === cert.deviceDid) return 'device-is-person';
  if (typeof cert.deviceId !== 'string' || cert.deviceId.length === 0
      || cert.deviceId.length > MAX_DEVICE_ID_LENGTH) return 'bad-device-id';
  if (cert.label !== undefined
      && (typeof cert.label !== 'string' || cert.label.length === 0
        || cert.label.length > MAX_LABEL_LENGTH)) return 'bad-label';
  if (!Number.isSafeInteger(cert.issuedAt) || cert.issuedAt < 0) return 'bad-issued-at';
  if (!Number.isSafeInteger(cert.seq) || cert.seq < 1) return 'bad-seq';
  if (typeof cert.sig !== 'string' || cert.sig.length === 0 || cert.sig.length > 128) return 'bad-sig';
  return null;
};

/**
 * Full verification: structure, the person root's signature, and (when the
 * caller knows them) the bindings that make the certificate mean anything
 * WHICH person it must chain to and WHICH device key the wire actually
 * authenticated. A certificate that verifies in isolation but names a
 * different deviceDid than the link's proven key is an impersonation
 * attempt, not a match.
 *
 * @param {any} cert
 * @param {{ expectedPersonDid?: string, expectedDeviceDid?: string }} [expected]
 * @returns {Promise<{ ok: boolean, defect: string | null }>}
 */
export const verifyDeviceCertificate = async (cert, { expectedPersonDid, expectedDeviceDid } = {}) => {
  const defect = validateDeviceCertificate(cert);
  if (defect) return { ok: false, defect };
  if (expectedPersonDid !== undefined && cert.personDid !== expectedPersonDid) {
    return { ok: false, defect: 'person-did-mismatch' };
  }
  if (expectedDeviceDid !== undefined && cert.deviceDid !== expectedDeviceDid) {
    return { ok: false, defect: 'device-did-mismatch' };
  }
  const { sig, ...unsigned } = cert;
  let verified = false;
  try {
    verified = await verifySignature(cert.personDid, fromBase64(sig), certSigningBytes(unsigned));
  } catch {
    return { ok: false, defect: 'bad-sig' };
  }
  return verified ? { ok: true, defect: null } : { ok: false, defect: 'signature-invalid' };
};

/**
 * Build a signed roster snapshot. Like certificates, personDid comes from
 * the signer. Callers pass the FULL device set every time: a roster is a
 * snapshot, not a diff, so a lost update can never resurrect a revoked
 * device.
 *
 * @param {Object} args
 * @param {Signer} args.personIdentity
 * @param {RosterEntry[]} args.devices
 * @param {number} args.seq  strictly greater than any prior roster's seq
 * @returns {Promise<DeviceRoster>}
 */
export const buildDeviceRoster = async ({ personIdentity, devices, seq }) => {
  /** @type {Omit<DeviceRoster, 'sig'>} */
  const unsigned = { v: DEVICE_ROSTER_VERSION, personDid: personIdentity.did, seq, devices };
  const defect = validateDeviceRoster({ ...unsigned, sig: 'A'.repeat(88) });
  if (defect) throw new Error(`refusing to sign an invalid device roster: ${defect}`);
  const sig = await personIdentity.sign(rosterSigningBytes(unsigned));
  return { ...unsigned, sig: toBase64(sig) };
};

/**
 * @param {any} roster
 * @returns {string | null}
 */
export const validateDeviceRoster = (roster) => {
  if (!roster || typeof roster !== 'object') return 'not-an-object';
  if (roster.v !== DEVICE_ROSTER_VERSION) return `unsupported-version-${roster.v}`;
  try { decodeDidKey(roster.personDid); } catch { return 'bad-person-did'; }
  if (!Number.isSafeInteger(roster.seq) || roster.seq < 1) return 'bad-seq';
  if (!Array.isArray(roster.devices) || roster.devices.length > MAX_ROSTER_DEVICES) return 'bad-devices';
  const seen = new Set();
  for (const entry of roster.devices) {
    if (!entry || typeof entry !== 'object') return 'bad-entry';
    try { decodeDidKey(entry.deviceDid); } catch { return 'bad-entry-device-did'; }
    if (seen.has(entry.deviceDid)) return 'duplicate-device';
    seen.add(entry.deviceDid);
    if (typeof entry.deviceId !== 'string' || entry.deviceId.length === 0
        || entry.deviceId.length > MAX_DEVICE_ID_LENGTH) return 'bad-entry-device-id';
    if (entry.label !== undefined
        && (typeof entry.label !== 'string' || entry.label.length === 0
          || entry.label.length > MAX_LABEL_LENGTH)) return 'bad-entry-label';
    if (!Number.isSafeInteger(entry.addedAt) || entry.addedAt < 0) return 'bad-entry-added-at';
    if (entry.status !== 'active' && entry.status !== 'revoked') return 'bad-entry-status';
  }
  if (typeof roster.sig !== 'string' || roster.sig.length === 0 || roster.sig.length > 128) return 'bad-sig';
  return null;
};

/**
 * @param {any} roster
 * @param {{ expectedPersonDid?: string }} [expected]
 * @returns {Promise<{ ok: boolean, defect: string | null }>}
 */
export const verifyDeviceRoster = async (roster, { expectedPersonDid } = {}) => {
  const defect = validateDeviceRoster(roster);
  if (defect) return { ok: false, defect };
  if (expectedPersonDid !== undefined && roster.personDid !== expectedPersonDid) {
    return { ok: false, defect: 'person-did-mismatch' };
  }
  const { sig, ...unsigned } = roster;
  let verified = false;
  try {
    verified = await verifySignature(roster.personDid, fromBase64(sig), rosterSigningBytes(unsigned));
  } catch {
    return { ok: false, defect: 'bad-sig' };
  }
  return verified ? { ok: true, defect: null } : { ok: false, defect: 'signature-invalid' };
};

/**
 * The anti-rollback rule (same shape as DHT mutable items): a roster
 * replaces a held one only when it names the same person and carries a
 * strictly higher seq. Equal seq is NOT an upgrade, accepting an
 * equal-seq variant would let an attacker who obtained one signed roster
 * fork the view.
 *
 * @param {DeviceRoster} candidate
 * @param {DeviceRoster | null | undefined} held
 */
export const rosterSupersedes = (candidate, held) => {
  if (!held) return true;
  return candidate.personDid === held.personDid && candidate.seq > held.seq;
};

/**
 * A device's standing in a roster. 'unknown' is deliberately distinct from
 * 'revoked': callers decide whether an unknown device may proceed (a roster
 * may legitimately predate a freshly enrolled device), but a revoked verdict
 * is always terminal.
 *
 * @param {DeviceRoster | null | undefined} roster
 * @param {string} deviceDid
 * @returns {'active' | 'revoked' | 'unknown'}
 */
export const deviceStatusInRoster = (roster, deviceDid) => {
  const entry = roster?.devices?.find((row) => row.deviceDid === deviceDid);
  return entry ? entry.status : 'unknown';
};
