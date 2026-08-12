// @ts-check
// Root-signed discovery-secret rotation, tied to a monotone revocation roster.
// The record is sent only over an already-authenticated direct self-device
// link: it contains the next secret, so it must never be gossiped or stored in
// a public DHT. Verification still fails closed on the receiving device.

import { canonicalize } from '/shared/bundle/canonical.js';
import { utf8, concat, toBase64, fromBase64 } from '/shared/bundle/bytes.js';
import { verifySignature } from '../identity/keypair.js';
import {
  verifyDeviceRoster, rosterSupersedes, deviceStatusInRoster,
} from '../identity/device-certificate.js';
import { DISCOVERY_SECRET_BYTES } from './rendezvous.js';

export const DISCOVERY_ROTATION_VERSION = 1;
const DOMAIN = 'peerd/self-discovery-rotation/v1';

/** @param {any} unsigned */
const signingBytes = (unsigned) => concat(
  utf8(DOMAIN), Uint8Array.from([0]), utf8(canonicalize(unsigned)),
);

/** @param {Uint8Array} secret */
const secretHash = async (secret) => toBase64(new Uint8Array(
  await crypto.subtle.digest('SHA-256', /** @type {BufferSource} */ (secret)),
));

/**
 * @param {Object} args
 * @param {{ did: string, sign: (bytes: Uint8Array) => Promise<Uint8Array> }} args.personIdentity
 * @param {any} args.priorRoster
 * @param {any} args.nextRoster
 * @param {Uint8Array} args.previousSecret
 * @param {Uint8Array} args.nextSecret
 */
export const buildDiscoveryRotation = async ({
  personIdentity, priorRoster, nextRoster, previousSecret, nextSecret,
}) => {
  if (!(previousSecret instanceof Uint8Array) || previousSecret.length !== DISCOVERY_SECRET_BYTES
      || !(nextSecret instanceof Uint8Array) || nextSecret.length !== DISCOVERY_SECRET_BYTES) {
    throw new Error('discovery rotation secrets must be exactly 32 bytes');
  }
  if (toBase64(previousSecret) === toBase64(nextSecret)) throw new Error('discovery rotation must change the secret');
  const priorVerdict = await verifyDeviceRoster(priorRoster, { expectedPersonDid: personIdentity.did });
  const nextVerdict = await verifyDeviceRoster(nextRoster, { expectedPersonDid: personIdentity.did });
  if (!priorVerdict.ok || !nextVerdict.ok || !rosterSupersedes(nextRoster, priorRoster)) {
    throw new Error('discovery rotation requires a valid monotone roster update');
  }
  const revoked = priorRoster.devices.filter((/** @type {any} */ entry) =>
    entry.status === 'active' && deviceStatusInRoster(nextRoster, entry.deviceDid) === 'revoked');
  if (revoked.length === 0) throw new Error('discovery rotation must accompany a device revocation');
  const unsigned = {
    v: DISCOVERY_ROTATION_VERSION,
    personDid: personIdentity.did,
    fromRosterSeq: priorRoster.seq,
    toRosterSeq: nextRoster.seq,
    previousSecretHash: await secretHash(previousSecret),
    nextSecret: toBase64(nextSecret),
  };
  return { ...unsigned, sig: toBase64(await personIdentity.sign(signingBytes(unsigned))) };
};

/**
 * Verify a direct rotation before changing local custody.
 * @param {any} record
 * @param {{ heldRoster: any, nextRoster: any, heldSecret: Uint8Array,
 *   selfDeviceDid: string }} context
 * @returns {Promise<{ ok: boolean, defect: string | null, nextSecret: Uint8Array | null }>}
 */
export const verifyDiscoveryRotation = async (record, {
  heldRoster, nextRoster, heldSecret, selfDeviceDid,
}) => {
  /** @param {string} defect */
  const refuse = (defect) => ({ ok: false, defect, nextSecret: null });
  if (!record || typeof record !== 'object' || record.v !== DISCOVERY_ROTATION_VERSION) return refuse('bad-record');
  if (record.personDid !== heldRoster?.personDid || nextRoster?.personDid !== record.personDid) {
    return refuse('person-mismatch');
  }
  if (record.fromRosterSeq !== heldRoster.seq || record.toRosterSeq !== nextRoster.seq
      || !rosterSupersedes(nextRoster, heldRoster)) return refuse('roster-mismatch');
  if (deviceStatusInRoster(nextRoster, selfDeviceDid) !== 'active') return refuse('recipient-not-active');
  const nextVerdict = await verifyDeviceRoster(nextRoster, { expectedPersonDid: record.personDid });
  if (!nextVerdict.ok) return refuse(`roster-${nextVerdict.defect}`);
  const { sig, ...unsigned } = record;
  try {
    if (typeof sig !== 'string'
        || !(await verifySignature(record.personDid, fromBase64(sig), signingBytes(unsigned)))) {
      return refuse('signature-invalid');
    }
    if (await secretHash(heldSecret) !== record.previousSecretHash) return refuse('previous-secret-mismatch');
    const nextSecret = fromBase64(record.nextSecret);
    if (nextSecret.length !== DISCOVERY_SECRET_BYTES) return refuse('bad-next-secret');
    return { ok: true, defect: null, nextSecret };
  } catch {
    return refuse('malformed-record');
  }
};
