import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { buildDeviceRoster } from '../../extension/peerd-distributed/identity/device-certificate.js';
import { mintDiscoverySecret } from '../../extension/peerd-distributed/self/rendezvous.js';
import {
  buildDiscoveryRotation, verifyDiscoveryRotation,
} from '../../extension/peerd-distributed/self/discovery-rotation.js';

describe('discovery-secret revocation rotation', () => {
  test('only a still-active device can adopt a root-signed rotation tied to revocation', async () => {
    const person = await generateIdentity();
    const desktop = await generateIdentity();
    const stolen = await generateIdentity();
    const desktopEntry = { deviceDid: desktop.did, deviceId: 'desktop', addedAt: 1, status: 'active' as const };
    const stolenEntry = { deviceDid: stolen.did, deviceId: 'stolen', addedAt: 2, status: 'active' as const };
    const priorRoster = await buildDeviceRoster({
      personIdentity: person, devices: [desktopEntry, stolenEntry], seq: 1,
    });
    const nextRoster = await buildDeviceRoster({
      personIdentity: person,
      devices: [desktopEntry, { ...stolenEntry, status: 'revoked' as const }], seq: 2,
    });
    const previousSecret = mintDiscoverySecret();
    const nextSecret = mintDiscoverySecret();
    const record = await buildDiscoveryRotation({
      personIdentity: person, priorRoster, nextRoster, previousSecret, nextSecret,
    });

    const accepted = await verifyDiscoveryRotation(record, {
      heldRoster: priorRoster, nextRoster, heldSecret: previousSecret,
      selfDeviceDid: desktop.did,
    });
    expect(accepted).toEqual({ ok: true, defect: null, nextSecret });

    const revoked = await verifyDiscoveryRotation(record, {
      heldRoster: priorRoster, nextRoster, heldSecret: previousSecret,
      selfDeviceDid: stolen.did,
    });
    expect(revoked).toMatchObject({ ok: false, defect: 'recipient-not-active' });

    const staleSecret = await verifyDiscoveryRotation(record, {
      heldRoster: priorRoster, nextRoster, heldSecret: mintDiscoverySecret(),
      selfDeviceDid: desktop.did,
    });
    expect(staleSecret).toMatchObject({ ok: false, defect: 'previous-secret-mismatch' });
  });

  test('refuses a rotation without a revocation', async () => {
    const person = await generateIdentity();
    const device = await generateIdentity();
    const entry = { deviceDid: device.did, deviceId: 'desktop', addedAt: 1, status: 'active' as const };
    const v1 = await buildDeviceRoster({ personIdentity: person, devices: [entry], seq: 1 });
    const v2 = await buildDeviceRoster({ personIdentity: person, devices: [entry], seq: 2 });
    await expect(buildDiscoveryRotation({
      personIdentity: person, priorRoster: v1, nextRoster: v2,
      previousSecret: mintDiscoverySecret(), nextSecret: mintDiscoverySecret(),
    })).rejects.toThrow(/revocation/);
  });
});
