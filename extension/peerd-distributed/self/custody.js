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
// The two composition entry points:
//   ensureFounderCustody  the FIRST device of a person: it holds the root,
//                         so it mints the discovery secret, its device key,
//                         self-issues a certificate + roster + passkey
//                         binding, and returns everything the enrollment
//                         sponsor path serves to later devices.
//   ensureEnrolledCustody an install that received a sponsor-issued
//                         certificate + roster for its pre-minted device
//                         key. It stores those records and the discovery
//                         secret, never the permanent person root.
//
// Pure-ish: all randomness/crypto is WebCrypto, all storage is injected, so
// the whole composition runs in Bun (self-custody.test.ts).

import { createPersistentIdentity, IDENTITY_SECRET_NAME } from '../identity/keypair.js';
import { loadDeviceKeyMaterial, createPersistentDeviceIdentity } from '../identity/device-key.js';
import {
  issueDeviceCertificate, buildDeviceRoster, verifyDeviceCertificate,
  verifyDeviceRoster, rosterSupersedes, deviceStatusInRoster,
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

/** Validate an enrollment discovery write without mutating custody. */
const preflightDiscoverySecret = async ({ getSecret }, secret) => {
  if (!(secret instanceof Uint8Array) || secret.length !== DISCOVERY_SECRET_BYTES) {
    throw new Error('discovery secret must be exactly 32 bytes');
  }
  const existing = await getSecret(DISCOVERY_SECRET_NAME);
  if (existing && existing !== toBase64(secret)) {
    throw new Error('a different discovery secret is already stored');
  }
};

/**
 * Atomically replace a held discovery secret after the caller has verified a
 * newer roster/rotation record. Requiring the expected prior value prevents
 * concurrent or stale rotations from silently forking the device set.
 *
 * @param {SecretIo} io
 * @param {{ expected: Uint8Array, next: Uint8Array }} rotation
 */
export const rotateDiscoverySecret = async ({ getSecret, setSecret }, { expected, next }) => {
  if (!(expected instanceof Uint8Array) || expected.length !== DISCOVERY_SECRET_BYTES
      || !(next instanceof Uint8Array) || next.length !== DISCOVERY_SECRET_BYTES) {
    throw new Error('discovery rotation secrets must be exactly 32 bytes');
  }
  const held = await getSecret(DISCOVERY_SECRET_NAME);
  if (!held || held !== toBase64(expected)) throw new Error('discovery secret changed before rotation');
  const replacement = toBase64(next);
  if (replacement === held) return false;
  await setSecret(DISCOVERY_SECRET_NAME, replacement);
  return true;
};

/**
 * Cache the device's own certificate + newest roster for offline
 * handshakes. Rosters are anti-rollback: a stored newer roster is never
 * lowered by an older one.
 * @param {SecretIo} io
 * @param {{ certificate: any, roster: any }} records
 */
export const storeSelfRecords = async ({ getSecret, setSecret }, { certificate, roster }) => {
  const certVerdict = await verifyDeviceCertificate(certificate);
  if (!certVerdict.ok) throw new Error(`refusing invalid self certificate: ${certVerdict.defect}`);
  const rosterVerdict = await verifyDeviceRoster(roster, { expectedPersonDid: certificate.personDid });
  if (!rosterVerdict.ok) throw new Error(`refusing invalid self roster: ${rosterVerdict.defect}`);
  const ownEntry = roster.devices.find((/** @type {any} */ entry) =>
    entry.deviceDid === certificate.deviceDid);
  if (!ownEntry || ownEntry.deviceId !== certificate.deviceId || ownEntry.status !== 'active') {
    throw new Error('self roster does not actively list this certificate');
  }
  let next = { v: 1, certificate, roster };
  const stored = await getSecret(SELF_RECORDS_NAME);
  if (stored) {
    /** @type {any} */
    let prev = null;
    try { prev = JSON.parse(stored); } catch { /* malformed cache is replaced */ }
    if (prev?.roster) {
      const prevVerdict = await verifyDeviceRoster(prev.roster, {
        expectedPersonDid: certificate.personDid,
      });
      if (prevVerdict.ok && !rosterSupersedes(roster, prev.roster)) {
        const previousEntry = prev.roster.devices.find((/** @type {any} */ entry) =>
          entry.deviceDid === certificate.deviceDid);
        if (previousEntry?.deviceId !== certificate.deviceId || previousEntry?.status !== 'active') {
          throw new Error('newer stored roster does not authorize this certificate');
        }
        next = { ...next, roster: prev.roster };
      }
    }
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
  const heldRecords = await loadSelfRecords(io);
  const heldRoot = await io.getSecret(IDENTITY_SECRET_NAME);
  if (heldRecords?.certificate && !heldRoot) {
    throw new Error('this enrolled device is not a person-root authority');
  }
  const personIdentity = await createPersistentIdentity(io);
  const device = await loadDeviceKeyMaterial(io);
  const discoverySecret = await loadDiscoverySecret(io, { mintIfAbsent: true });
  let certificate;
  let roster;
  const existing = heldRecords;
  if (existing?.certificate && existing?.roster) {
    const certVerdict = await verifyDeviceCertificate(existing.certificate, {
      expectedPersonDid: personIdentity.did,
      expectedDeviceDid: device.did,
    });
    const rosterVerdict = await verifyDeviceRoster(existing.roster, {
      expectedPersonDid: personIdentity.did,
    });
    if (!certVerdict.ok || !rosterVerdict.ok
        || deviceStatusInRoster(existing.roster, device.did) !== 'active') {
      throw new Error('stored founder custody records are inconsistent');
    }
    certificate = existing.certificate;
    roster = existing.roster;
  } else {
    certificate = await issueDeviceCertificate({
      personIdentity, deviceDid: device.did, deviceId: device.deviceId, label, seq: 1, now,
    });
    roster = await buildDeviceRoster({
      personIdentity,
      devices: [{
        deviceDid: device.did, deviceId: device.deviceId,
        ...(label ? { label } : {}), addedAt: now ?? Date.now(), status: 'active',
      }],
      seq: 1,
    });
    await storeSelfRecords(io, { certificate, roster });
  }
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
 * Fresh install, before enrollment: mint or reload the device key whose DID
 * the request asks the sponsor to certify. The private half never leaves this
 * vault and retries reuse the same identity.
 *
 * @param {SecretIo} io
 */
export const ensureEnrolleeDevice = async (io) => {
  const device = await createPersistentDeviceIdentity(io);
  return { did: device.did, deviceId: device.deviceId };
};

/**
 * Sponsor-side issuance for a new device. The ordinary enrolled device never
 * receives the person root: the already-active sponsor signs its certificate
 * and the next roster, then includes both in the sealed grant.
 *
 * @param {Object} args
 * @param {{ did: string, sign: (bytes: Uint8Array) => Promise<Uint8Array> }} args.personIdentity
 * @param {any} args.priorRoster
 * @param {string} args.deviceDid
 * @param {string} args.deviceId
 * @param {string} [args.label]
 * @param {number} [args.now]
 */
export const issueEnrolledDeviceRecords = async ({
  personIdentity, priorRoster, deviceDid, deviceId, label, now,
}) => {
  const priorVerdict = await verifyDeviceRoster(priorRoster, {
    expectedPersonDid: personIdentity.did,
  });
  if (!priorVerdict.ok) throw new Error(`enrollment roster is invalid: ${priorVerdict.defect}`);
  const didEntry = priorRoster.devices.find((/** @type {any} */ entry) => entry.deviceDid === deviceDid);
  const idEntry = priorRoster.devices.find((/** @type {any} */ entry) => entry.deviceId === deviceId);
  if (didEntry || idEntry) {
    if (didEntry !== idEntry || didEntry?.status !== 'active') {
      throw new Error('enrollment device conflicts with an existing roster entry');
    }
    // The roster commit may have landed while the sealed grant was lost.
    // Reconstruct the same deterministic certificate instead of stranding
    // this install or growing a ghost row. Ed25519 signatures are deterministic.
    const certificate = await issueDeviceCertificate({
      personIdentity,
      deviceDid,
      deviceId,
      label: didEntry.label,
      seq: priorRoster.seq,
      now: didEntry.addedAt,
    });
    return { certificate, roster: priorRoster, replayed: true };
  }
  const issuedAt = now ?? Date.now();
  const seq = priorRoster.seq + 1;
  const certificate = await issueDeviceCertificate({
    personIdentity, deviceDid, deviceId, label, seq, now: issuedAt,
  });
  const roster = await buildDeviceRoster({
    personIdentity,
    devices: [...priorRoster.devices, {
      deviceDid, deviceId, ...(label ? { label } : {}),
      addedAt: issuedAt, status: 'active',
    }],
    seq,
  });
  return { certificate, roster };
};

/**
 * Root-holding sponsor convenience entry point used by the PR398 host. It
 * refuses ordinary enrolled devices before createPersistentIdentity could
 * mint a disconnected replacement root, signs the enrollee's records, then
 * durably adopts the roster it issued.
 *
 * @param {Object} args
 * @param {SecretIo} args.io
 * @param {any} args.priorRoster
 * @param {string} args.deviceDid
 * @param {string} args.deviceId
 * @param {string} [args.label]
 * @param {number} [args.now]
 */
export const sponsorDeviceEnrollment = async ({
  io, priorRoster, deviceDid, deviceId, label, now,
}) => {
  const heldRoot = await io.getSecret(IDENTITY_SECRET_NAME);
  const heldRecords = await loadSelfRecords(io);
  if (!heldRoot || !heldRecords?.certificate || !heldRecords?.roster) {
    throw new Error('this device is not a person-root enrollment authority');
  }
  const personIdentity = await createPersistentIdentity(io);
  if (heldRecords.certificate.personDid !== personIdentity.did) {
    throw new Error('stored sponsor certificate does not match the person root');
  }
  const alreadyIssued = heldRecords.roster.devices.some((/** @type {any} */ entry) =>
    entry.deviceDid === deviceDid && entry.deviceId === deviceId && entry.status === 'active');
  if (!alreadyIssued
      && (priorRoster?.seq !== heldRecords.roster.seq || priorRoster?.sig !== heldRecords.roster.sig)) {
    throw new Error('enrollment roster is stale relative to sponsor custody');
  }
  const issued = await issueEnrolledDeviceRecords({
    personIdentity, priorRoster: heldRecords.roster, deviceDid, deviceId, label, now,
  });
  if (!issued.replayed) {
    await storeSelfRecords(io, {
      certificate: heldRecords.certificate,
      roster: issued.roster,
    });
  }
  return issued;
};

/**
 * ENROLLED device: adopt sponsor-issued records for the device key minted
 * before ENROLL_REQ. No person-root material is loaded or persisted here.
 *
 * @param {Object} args
 * @param {SecretIo} args.io
 * @param {Uint8Array} args.discoverySecret
 * @param {any} args.certificate
 * @param {any} args.roster
 * @param {string} [args.personDid]
 */
export const ensureEnrolledCustody = async ({
  io, discoverySecret, certificate, roster, personDid = certificate?.personDid,
}) => {
  const device = await createPersistentDeviceIdentity(io);
  const certVerdict = await verifyDeviceCertificate(certificate, {
    expectedPersonDid: personDid,
    expectedDeviceDid: device.did,
  });
  if (!certVerdict.ok || certificate.deviceId !== device.deviceId) {
    throw new Error(`enrollment certificate does not name this device: ${certVerdict.defect ?? 'device-id-mismatch'}`);
  }
  const rosterVerdict = await verifyDeviceRoster(roster, {
    expectedPersonDid: personDid,
  });
  const ownEntry = roster?.devices?.find((/** @type {any} */ entry) => entry.deviceDid === device.did);
  if (!rosterVerdict.ok || deviceStatusInRoster(roster, device.did) !== 'active'
      || ownEntry?.deviceId !== device.deviceId) {
    throw new Error(`enrollment roster does not authorize this device: ${rosterVerdict.defect ?? 'device-not-active'}`);
  }
  // Preflight every key before the first write, then commit the membership
  // marker before discovery. A crash between the two writes cannot leave a
  // discovery-only install that legacy startup mistakes for a new person.
  await preflightDiscoverySecret(io, discoverySecret);
  await storeSelfRecords(io, { certificate, roster });
  await storeDiscoverySecret(io, discoverySecret);
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
