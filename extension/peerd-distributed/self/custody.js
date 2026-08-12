// @ts-check
// peerd-distributed/self/custody.js: the person-side self-device custody
// composition: everything that must exist on an install for it to be a
// certified member of the person's device set and find its siblings.
//
// Three durable pieces, all vault secrets (IO injected, this file never
// touches the vault directly):
//   device key         distributed/device-key/v1  (device-key.js), minted
//                      fresh per install, NEVER exported.
//   discovery secret   distributed/self-discovery/v1, random 32 bytes the
//                      person's devices share, distinct from every other
//                      secret; enrollment RECOVERS it, first-run MINTS it.
//   certificate/roster distributed/self-records/v1: the device's own
//                      root-signed certificate plus the newest roster it
//                      holds (public records, but cached here for offline
//                      handshakes).
//
// The composition entry points, split by WHO HOLDS THE ROOT:
//   ensureFounderCustody   the FIRST device of a person: it holds the root,
//                          so it mints the discovery secret, its device key,
//                          self-issues a certificate + roster + passkey
//                          binding, and returns everything the enrollment
//                          sponsor path serves to later devices.
//   ensureEnrolleeDevice   a fresh install, BEFORE enrollment: mints its own
//                          device key so it can name that did in the request.
//   sponsorDeviceEnrollment  a root-holding device certifying somebody else's
//                          device did and extending the roster to include it.
//                          This is the only way a new device gains authority.
//   ensureEnrolledCustody  the enrollee, AFTER a verified grant: it stores
//                          the certificate, roster and discovery secret it
//                          was given. It signs nothing, because it holds no
//                          root, which is exactly why revoking it works.
//
// why the enrollee no longer self-certifies: it used to receive the person
// root in the grant and mint its own certificate + seq+1 roster. That made
// roster revocation decorative: a revoked device still held the root, so
// it could re-certify a fresh key and sign itself back to active under the
// unchanged person did. Authority to issue now lives only where the root
// does (enroll.js's header carries the full argument).
//
// Pure-ish: all randomness/crypto is WebCrypto, all storage is injected, so
// the whole composition runs in Bun (self-custody.test.ts).

import { createPersistentIdentity } from '../identity/keypair.js';
import { loadDeviceKeyMaterial, createPersistentDeviceIdentity } from '../identity/device-key.js';
import {
  issueDeviceCertificate, buildDeviceRoster, verifyDeviceRoster, verifyDeviceCertificate,
  rosterSupersedes,
} from '../identity/device-certificate.js';
import { toBase64, fromBase64 } from '/shared/bundle/bytes.js';
import { mintDiscoverySecret, DISCOVERY_SECRET_BYTES } from './rendezvous.js';

export const DISCOVERY_SECRET_NAME = 'distributed/self-discovery/v1';
export const SELF_RECORDS_NAME = 'distributed/self-records/v1';

/**
 * @typedef {{ getSecret: (name: string) => Promise<string | null>,
 *   setSecret: (name: string, value: string) => Promise<void> }} SecretIo
 */

/**
 * Load (or, if allowed, mint) the discovery secret. First-run founder MINTS;
 * an enrolled device receives it and calls storeDiscoverySecret instead.
 * @param {SecretIo} io
 * @param {{ mintIfAbsent?: boolean }} [opts]
 * @returns {Promise<Uint8Array | null>}
 */
export const loadDiscoverySecret = async ({ getSecret, setSecret }, { mintIfAbsent = false } = {}) => {
  const stored = await getSecret(DISCOVERY_SECRET_NAME);
  if (stored) {
    const bytes = fromBase64(stored);
    if (bytes.length !== DISCOVERY_SECRET_BYTES) throw new Error('stored discovery secret is malformed');
    return bytes;
  }
  if (!mintIfAbsent) return null;
  const secret = mintDiscoverySecret();
  await setSecret(DISCOVERY_SECRET_NAME, toBase64(secret));
  return secret;
};

/**
 * Persist a discovery secret recovered during enrollment. Refuses to
 * overwrite a DIFFERENT existing secret (an enrolled device joining a
 * person it already belongs to must converge, not fork).
 * @param {SecretIo} io
 * @param {Uint8Array} secret
 */
export const storeDiscoverySecret = async ({ getSecret, setSecret }, secret) => {
  if (!(secret instanceof Uint8Array) || secret.length !== DISCOVERY_SECRET_BYTES) {
    throw new Error('discovery secret must be exactly 32 bytes');
  }
  const existing = await getSecret(DISCOVERY_SECRET_NAME);
  const b64 = toBase64(secret);
  if (existing && existing !== b64) throw new Error('a different discovery secret is already stored');
  if (!existing) await setSecret(DISCOVERY_SECRET_NAME, b64);
};

/**
 * Cache the device's own certificate + newest roster for offline
 * handshakes. Rosters are anti-rollback: a stored newer roster is never
 * lowered by an older one.
 * @param {SecretIo} io
 * @param {{ certificate: any, roster: any }} records
 */
export const storeSelfRecords = async ({ getSecret, setSecret }, { certificate, roster }) => {
  let next = { v: 1, certificate, roster };
  const stored = await getSecret(SELF_RECORDS_NAME);
  if (stored) {
    try {
      const prev = JSON.parse(stored);
      if (prev?.roster && !rosterSupersedes(roster, prev.roster)) next = { ...next, roster: prev.roster };
    } catch { /* malformed cache is replaced */ }
  }
  await setSecret(SELF_RECORDS_NAME, JSON.stringify(next));
};

/** @param {SecretIo} io */
export const loadSelfRecords = async ({ getSecret }) => {
  const stored = await getSecret(SELF_RECORDS_NAME);
  if (!stored) return null;
  try { return JSON.parse(stored); } catch { return null; }
};

/**
 * FIRST device: it holds the person root, so it bootstraps the whole
 * self-device world.
 *
 * @param {Object} args
 * @param {SecretIo} args.io  the vault secret surface (used for identity,
 *        device key, discovery secret, and self-records)
 * @param {(binding: { personIdentity: any }) => Promise<any>} [args.buildBinding]
 *        optional passkey-binding builder (the SW supplies it after a
 *        ceremony; absent on a headless bootstrap)
 * @param {string} [args.label]
 * @param {number} [args.now]
 */
export const ensureFounderCustody = async ({ io, buildBinding, label, now }) => {
  const personIdentity = await createPersistentIdentity(io);
  const device = await loadDeviceKeyMaterial(io);
  const discoverySecret = await loadDiscoverySecret(io, { mintIfAbsent: true });
  const certificate = await issueDeviceCertificate({
    personIdentity, deviceDid: device.did, deviceId: device.deviceId, label, seq: 1, now,
  });
  const roster = await buildDeviceRoster({
    personIdentity,
    devices: [{
      deviceDid: device.did, deviceId: device.deviceId,
      ...(label ? { label } : {}), addedAt: now ?? Date.now(), status: 'active',
    }],
    seq: 1,
  });
  await storeSelfRecords(io, { certificate, roster });
  const passkeyBinding = buildBinding ? await buildBinding({ personIdentity }) : null;
  return {
    personDid: personIdentity.did,
    deviceDid: device.did,
    deviceId: device.deviceId,
    certificate,
    roster,
    discoverySecret,
    passkeyBinding,
  };
};

/**
 * A fresh install, BEFORE it asks to be enrolled. Mints (or reloads) this
 * install's own device key so the enrollment request can name its did.
 * Idempotent: a retried enrollment reuses the same device identity rather
 * than littering the person's roster with a new entry per attempt.
 *
 * @param {SecretIo} io
 * @returns {Promise<{ did: string, deviceId: string }>}
 */
export const ensureEnrolleeDevice = async (io) => {
  const device = await createPersistentDeviceIdentity(io);
  return { did: device.did, deviceId: device.deviceId };
};

/**
 * SPONSOR side, and the only place device authority is minted: a device
 * that holds the person root certifies an enrollee's device did and signs
 * the roster snapshot that names it.
 *
 * The enrollee's device PUBLIC did is all that crosses the wire, in either
 * direction. The sponsor never sees the enrollee's private key, and the
 * enrollee never sees the root that signs these records.
 *
 * @param {Object} args
 * @param {SecretIo} args.io                the sponsor's own vault surface
 * @param {string} args.deviceDid           the ENROLLEE's device did:key
 * @param {string} args.deviceId            the ENROLLEE's install id
 * @param {any} args.priorRoster            newest roster the sponsor holds
 * @param {string} [args.label]             the enrollee's human label
 * @param {number} [args.now]
 * @returns {Promise<{ certificate: any, roster: any }>}
 */
export const sponsorDeviceEnrollment = async ({
  io, deviceDid, deviceId, priorRoster, label, now,
}) => {
  const personIdentity = await createPersistentIdentity(io);
  const seq = (priorRoster?.seq ?? 0) + 1;
  const certificate = await issueDeviceCertificate({
    personIdentity, deviceDid, deviceId, label, seq, now,
  });
  // Extend the prior snapshot, having checked it is actually this person's:
  // signing a roster built from an unverified input would let a corrupted
  // cache launder entries into a genuinely person-signed record.
  /** @type {any[]} */
  let devices = [];
  if (priorRoster) {
    const verdict = await verifyDeviceRoster(priorRoster, { expectedPersonDid: personIdentity.did });
    if (!verdict.ok) throw new Error(`refusing to extend an unverifiable roster: ${verdict.defect}`);
    devices = priorRoster.devices.filter((/** @type {any} */ row) => row.deviceDid !== deviceDid);
  }
  devices.push({
    deviceDid, deviceId,
    ...(label ? { label } : {}), addedAt: now ?? Date.now(), status: 'active',
  });
  const roster = await buildDeviceRoster({ personIdentity, devices, seq });
  // The sponsor adopts the roster it just signed, so its own view already
  // includes the new device when the enrollee first calls.
  await storeSelfRecords(io, { certificate: (await loadSelfRecords(io))?.certificate, roster });
  return { certificate, roster };
};

/**
 * ENROLLED device, after openEnrollmentGrant verified the chain. It stores
 * what it was granted and nothing more: the discovery secret, its own
 * sponsor-issued certificate, and the roster naming it.
 *
 * It issues no records, because it holds no root to sign them with. That is the
 * point: a device whose entry is later revoked has no way to write itself
 * back in, so a newer roster from the person is the last word.
 *
 * @param {Object} args
 * @param {SecretIo} args.io
 * @param {Uint8Array} args.discoverySecret  from the verified grant
 * @param {any} args.certificate             this device's sponsor-issued certificate
 * @param {any} args.roster                  the roster that names it
 * @param {string} args.personDid            the did every record above verified under
 */
export const ensureEnrolledCustody = async ({
  io, discoverySecret, certificate, roster, personDid,
}) => {
  const device = await createPersistentDeviceIdentity(io);
  // Re-check the grant's records against the key this install actually
  // holds. openEnrollmentGrant already did; doing it again here means no
  // future caller can write unverified records into custody by mistake.
  const certVerdict = await verifyDeviceCertificate(certificate, {
    expectedPersonDid: personDid, expectedDeviceDid: device.did,
  });
  if (!certVerdict.ok) throw new Error(`refusing an unverifiable device certificate: ${certVerdict.defect}`);
  const rosterVerdict = await verifyDeviceRoster(roster, { expectedPersonDid: personDid });
  if (!rosterVerdict.ok) throw new Error(`refusing an unverifiable device roster: ${rosterVerdict.defect}`);
  await storeDiscoverySecret(io, discoverySecret);
  await storeSelfRecords(io, { certificate, roster });
  return {
    personDid,
    deviceDid: device.did,
    deviceId: device.deviceId,
    certificate,
    roster,
    discoverySecret,
  };
};

/**
 * Load the device SIGNING identity + its cached records + discovery secret
 * everything the coordinator needs to run, with no root access. Returns null
 * if the install isn't a self-device member yet (no discovery secret).
 *
 * @param {SecretIo} io
 */
export const loadCoordinatorInputs = async (io) => {
  const discoverySecret = await loadDiscoverySecret(io);
  if (!discoverySecret) return null;
  const records = await loadSelfRecords(io);
  if (!records?.certificate) return null;
  const deviceIdentity = await createPersistentDeviceIdentity(io);
  return {
    deviceIdentity,
    deviceCert: records.certificate,
    roster: records.roster ?? null,
    discoverySecret,
    personDid: records.certificate.personDid,
  };
};
