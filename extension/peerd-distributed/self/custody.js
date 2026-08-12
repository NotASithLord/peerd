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
  if (priorRoster.devices.some((/** @type {any} */ entry) =>
    entry.deviceDid === deviceDid || entry.deviceId === deviceId)) {
    throw new Error('enrollment device is already present in the roster');
  }
  const seq = priorRoster.seq + 1;
  const certificate = await issueDeviceCertificate({
    personIdentity, deviceDid, deviceId, label, seq, now,
  });
  const roster = await buildDeviceRoster({
    personIdentity,
    devices: [...priorRoster.devices, {
      deviceDid, deviceId, ...(label ? { label } : {}),
      addedAt: now ?? Date.now(), status: 'active',
    }],
    seq,
  });
  return { certificate, roster };
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
 */
export const ensureEnrolledCustody = async ({ io, discoverySecret, certificate, roster }) => {
  await storeDiscoverySecret(io, discoverySecret);
  const device = await createPersistentDeviceIdentity(io);
  const certVerdict = await verifyDeviceCertificate(certificate, {
    expectedDeviceDid: device.did,
  });
  if (!certVerdict.ok || certificate.deviceId !== device.deviceId) {
    throw new Error(`enrollment certificate does not name this device: ${certVerdict.defect ?? 'device-id-mismatch'}`);
  }
  const rosterVerdict = await verifyDeviceRoster(roster, {
    expectedPersonDid: certificate.personDid,
  });
  if (!rosterVerdict.ok || deviceStatusInRoster(roster, device.did) !== 'active') {
    throw new Error(`enrollment roster does not authorize this device: ${rosterVerdict.defect ?? 'device-not-active'}`);
  }
  await storeSelfRecords(io, { certificate, roster });
  return {
    personDid: certificate.personDid,
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
