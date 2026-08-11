// @ts-check
// peerd-distributed/self/custody.js — the person-side self-device custody
// composition: everything that must exist on an install for it to be a
// certified member of the person's device set and find its siblings.
//
// Three durable pieces, all vault secrets (IO injected — this file never
// touches the vault directly):
//   device key         distributed/device-key/v1  (device-key.js) — minted
//                      fresh per install, NEVER exported.
//   discovery secret   distributed/self-discovery/v1 — random 32 bytes the
//                      person's devices share, distinct from every other
//                      secret; enrollment RECOVERS it, first-run MINTS it.
//   certificate/roster distributed/self-records/v1 — the device's own
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
//   ensureEnrolledCustody an install that just adopted the person identity
//                         via enrollment: it has the grant (discovery
//                         secret, binding, roster) and the root (recovered
//                         into the identity secret); it mints ITS device
//                         key and — holding the root — self-certifies and
//                         appends itself to a new roster.
//
// Pure-ish: all randomness/crypto is WebCrypto, all storage is injected, so
// the whole composition runs in Bun (self-custody.test.ts).

import { createPersistentIdentity } from '../identity/keypair.js';
import { loadDeviceKeyMaterial, createPersistentDeviceIdentity } from '../identity/device-key.js';
import {
  issueDeviceCertificate, buildDeviceRoster, verifyDeviceRoster, rosterSupersedes,
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
 * ENROLLED device: the identity secret was just written by the enrollment
 * grant adoption, and the grant also carried the discovery secret + roster.
 * This mints the device key and — holding the recovered root — self-issues
 * a certificate and appends itself to a fresh roster (seq+1), which the
 * device will re-publish so its siblings learn of it.
 *
 * @param {Object} args
 * @param {SecretIo} args.io
 * @param {Uint8Array} args.discoverySecret  from the enrollment grant
 * @param {any} args.priorRoster             the grant's roster (may be null)
 * @param {string} [args.label]
 * @param {number} [args.now]
 */
export const ensureEnrolledCustody = async ({ io, discoverySecret, priorRoster, label, now }) => {
  const personIdentity = await createPersistentIdentity(io);
  await storeDiscoverySecret(io, discoverySecret);
  const device = await createPersistentDeviceIdentity(io);
  const certificate = await issueDeviceCertificate({
    personIdentity, deviceDid: device.did, deviceId: device.deviceId, label,
    seq: (priorRoster?.seq ?? 0) + 1, now,
  });
  // Append this device to a fresh roster snapshot (seq+1). Verify the prior
  // roster is actually this person's before extending it — a grant is
  // sender-authenticated end to end, but defense in depth costs nothing.
  /** @type {any[]} */
  let devices = [];
  if (priorRoster) {
    const verdict = await verifyDeviceRoster(priorRoster, { expectedPersonDid: personIdentity.did });
    if (verdict.ok) devices = priorRoster.devices.filter((/** @type {any} */ d) => d.deviceDid !== device.did);
  }
  devices.push({
    deviceDid: device.did, deviceId: device.deviceId,
    ...(label ? { label } : {}), addedAt: now ?? Date.now(), status: 'active',
  });
  const roster = await buildDeviceRoster({
    personIdentity, devices, seq: (priorRoster?.seq ?? 0) + 1,
  });
  await storeSelfRecords(io, { certificate, roster });
  return {
    personDid: personIdentity.did,
    deviceDid: device.did,
    deviceId: device.deviceId,
    certificate,
    roster,
    discoverySecret,
  };
};

/**
 * Load the device SIGNING identity + its cached records + discovery secret —
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
