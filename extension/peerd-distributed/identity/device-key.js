// @ts-check
// peerd-distributed/identity/device-key.js — the per-install device key.
//
// why a second Ed25519 keypair: the person root (keypair.js) is PORTABLE —
// backup, recovery, and enrollment deliberately move it between installs.
// A portable root is exactly the wrong key to prove "this specific
// installation": every enrolled device could impersonate every other, and a
// stolen backup would impersonate them all. The device key is the opposite
// contract — minted fresh on this install, never exported, never enrolled
// anywhere. Its authority comes from a person-root-signed certificate
// (device-certificate.js), not from being carried around.
//
// Custody mirrors keypair.js exactly: material lives as a vault secret and
// IO is injected. The secret name sits under the 'distributed/device-key/'
// prefix that transfer.js structurally excludes from every export payload
// (NON_EXPORTABLE_SECRET_PREFIXES) — the "never leaves the installation"
// rule is mechanism, not caller discipline.

import {
  mintKeypairMaterial, identityFromMaterial, assertIdentityMaterial,
} from './keypair.js';

export const DEVICE_KEY_SECRET_NAME = 'distributed/device-key/v1';

const MAX_DEVICE_ID_LENGTH = 64;

/**
 * Stored shape: the keypair material plus a stable install identifier the
 * device certificate names. deviceId is minted once with the key — a fresh
 * key is a fresh device, so the two share one lifecycle.
 * @typedef {{ seed: string, pub: string, deviceId: string }} DeviceKeyMaterial
 */

/**
 * Load (or first-create) this install's device-key material. Same
 * verify-on-load posture as loadIdentityMaterial: stored material must
 * prove seed↔pub consistency before anything trusts its did.
 *
 * @param {{
 *   getSecret: (name: string) => Promise<string | null>,
 *   setSecret: (name: string, value: string) => Promise<void>,
 * }} io — the vault's secret surface (or any same-shaped store in tests)
 * @param {{ newDeviceId?: () => string }} [opts]
 * @returns {Promise<DeviceKeyMaterial & { did: string }>}
 */
export const loadDeviceKeyMaterial = async (
  { getSecret, setSecret },
  { newDeviceId = () => crypto.randomUUID() } = {},
) => {
  const stored = await getSecret(DEVICE_KEY_SECRET_NAME);
  if (stored) {
    const { seed, pub, deviceId } = JSON.parse(stored);
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > MAX_DEVICE_ID_LENGTH) {
      throw new Error('stored device key carries no valid device id');
    }
    const did = await assertIdentityMaterial({ seed, pub });
    return { seed, pub, deviceId, did };
  }
  const material = await mintKeypairMaterial();
  const deviceId = newDeviceId();
  await setSecret(DEVICE_KEY_SECRET_NAME, JSON.stringify({
    v: 1, seed: material.seed, pub: material.pub, deviceId,
  }));
  return { seed: material.seed, pub: material.pub, deviceId, did: material.did };
};

/**
 * Load the device signing identity, creating it on first use. Returns the
 * identity plus the stable deviceId the certificate names.
 *
 * @param {{
 *   getSecret: (name: string) => Promise<string | null>,
 *   setSecret: (name: string, value: string) => Promise<void>,
 * }} io
 * @param {{ newDeviceId?: () => string }} [opts]
 */
export const createPersistentDeviceIdentity = async (io, opts) => {
  const { seed, pub, deviceId } = await loadDeviceKeyMaterial(io, opts);
  const identity = await identityFromMaterial({ seed, pub });
  return { ...identity, deviceId };
};
