// @ts-check
// peerd-distributed/self/rendezvous.js — private rendezvous topic
// derivation for a person's own devices.
//
// The problem this solves (issue: portable identity §5): the user's devices
// must FIND each other on the open network without announcing "this is
// <did>'s meeting point". So the meeting point is derived from a secret
// only the person's enrolled devices hold:
//
//   topic = HMAC-SHA256(discovery_secret, domain || 0x00 || epoch)
//
// Properties the derivation must keep (each has an adversarial test):
//   - the topic reveals nothing about the did (HMAC with an unrelated key);
//   - knowing the did reveals nothing about the topic (the secret is random,
//     never derived from identity material);
//   - topics ROTATE by epoch, bounding passive linkability of one topic id;
//   - a bounded skew window keeps devices with drifting clocks meeting;
//   - rotating the SECRET (re-issued via self-device sync) needs no did
//     change.
//
// Two derivation domains, one mechanism:
//   self     'peerd/self-rendezvous/v1'   — steady-state device meeting
//   enroll   'peerd/enroll-rendezvous/v1' — where a NOT-YET-ENROLLED install
//            meets an existing device. Its secret is derived from the
//            portable passkey (self/enroll.js), because a fresh install
//            holds nothing else; the domains keep the two spaces disjoint
//            even if the secrets ever coincided.
//
// Pure derivation only. Which room to join, and that joining a topic grants
// NOTHING (candidates still complete mutual authentication — handshake.js),
// live with the callers.

import { utf8, concat, toHex } from '/shared/bundle/bytes.js';

export const SELF_RENDEZVOUS_DOMAIN = 'peerd/self-rendezvous/v1';
export const ENROLL_RENDEZVOUS_DOMAIN = 'peerd/enroll-rendezvous/v1';

export const DISCOVERY_SECRET_BYTES = 32;
// why 6 hours: rotation is about bounding how long one opaque id stays
// linkable across observations, not about key freshness — the id derives no
// key material. 4 epochs/day keeps ids short-lived while the ±1-epoch skew
// window still tolerates hours of clock drift.
export const RENDEZVOUS_EPOCH_MS = 6 * 60 * 60 * 1000;

/** @param {number} epochIndex  little-endian u64 as 8 bytes */
const epochBytes = (epochIndex) => {
  const out = new Uint8Array(8);
  let rest = epochIndex;
  for (let i = 0; i < 8; i++) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return out;
};

/** @param {number} nowMs @param {number} [epochMs] */
export const epochIndexFor = (nowMs, epochMs = RENDEZVOUS_EPOCH_MS) =>
  Math.floor(nowMs / epochMs);

/**
 * Derive ONE epoch's opaque topic id.
 *
 * @param {Uint8Array} secret  32 random bytes (never identity material)
 * @param {number} epochIndex
 * @param {string} [domain]
 * @returns {Promise<string>} 64 hex chars, safe to use as a room id
 */
export const deriveRendezvousTopic = async (secret, epochIndex, domain = SELF_RENDEZVOUS_DOMAIN) => {
  if (!(secret instanceof Uint8Array) || secret.length !== DISCOVERY_SECRET_BYTES) {
    throw new Error(`rendezvous secret must be exactly ${DISCOVERY_SECRET_BYTES} bytes`);
  }
  if (!Number.isSafeInteger(epochIndex) || epochIndex < 0) {
    throw new Error('rendezvous epoch index must be a non-negative integer');
  }
  const key = await crypto.subtle.importKey(
    'raw', /** @type {BufferSource} */ (secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const message = concat(utf8(domain), Uint8Array.from([0]), epochBytes(epochIndex));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, /** @type {BufferSource} */ (message)));
  return toHex(mac);
};

/**
 * The topics a device should be REACHABLE on right now: the current epoch
 * plus `skew` epochs either side. Listeners join all of them; a dialer
 * needs only the current one to meet any listener within the window.
 *
 * @param {Uint8Array} secret
 * @param {{ now?: number, skew?: number, epochMs?: number, domain?: string }} [opts]
 * @returns {Promise<Array<{ epochIndex: number, topic: string }>>}
 */
export const rendezvousWindow = async (secret, {
  now = Date.now(), skew = 1, epochMs = RENDEZVOUS_EPOCH_MS, domain = SELF_RENDEZVOUS_DOMAIN,
} = {}) => {
  if (!Number.isInteger(skew) || skew < 0 || skew > 2) {
    throw new Error('rendezvous skew window must be 0..2 epochs');
  }
  const center = epochIndexFor(now, epochMs);
  /** @type {Array<{ epochIndex: number, topic: string }>} */
  const window = [];
  for (let offset = -skew; offset <= skew; offset++) {
    const epochIndex = center + offset;
    if (epochIndex < 0) continue;
    window.push({ epochIndex, topic: await deriveRendezvousTopic(secret, epochIndex, domain) });
  }
  return window;
};

/** Mint a fresh discovery secret (enrollment issues it; rotation re-issues). */
export const mintDiscoverySecret = () =>
  crypto.getRandomValues(new Uint8Array(DISCOVERY_SECRET_BYTES));
