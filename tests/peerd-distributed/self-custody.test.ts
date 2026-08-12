// The custody composition: a founder bootstraps the self-device world, an
// enrolled device joins it, and both end up able to run the coordinator and
// mutually authenticate: the whole "device key + certificate + discovery
// secret" chain, end to end, over a fake vault secret store.

import { describe, test, expect } from 'bun:test';
import {
  ensureFounderCustody, ensureEnrolleeDevice, sponsorDeviceEnrollment,
  ensureEnrolledCustody, loadCoordinatorInputs,
  loadDiscoverySecret, storeDiscoverySecret, DISCOVERY_SECRET_NAME,
} from '../../extension/peerd-distributed/self/custody.js';

// The person root's vault secret name (private to keypair.js; named here so
// the tests can assert an enrolled device never acquires it).
const IDENTITY_SECRET_NAME = 'distributed/identity/v1';
import { verifyDeviceCertificate, verifyDeviceRoster, rosterSupersedes } from '../../extension/peerd-distributed/identity/device-certificate.js';
import { createSelfDeviceCoordinator } from '../../extension/peerd-distributed/self/coordinator.js';
import { deviceStatusInRoster } from '../../extension/peerd-distributed/identity/device-certificate.js';
import { mintDiscoverySecret } from '../../extension/peerd-distributed/self/rendezvous.js';

const fakeVault = (seed: Record<string, string> = {}) => {
  const m = new Map(Object.entries(seed));
  return {
    getSecret: async (name: string) => m.get(name) ?? null,
    setSecret: async (name: string, value: string) => { m.set(name, value); },
    map: m,
  };
};

describe('self-device custody', () => {
  test('founder bootstraps a self-consistent identity: cert verifies under root, roster lists the device', async () => {
    const io = fakeVault();
    const founder = await ensureFounderCustody({ io, label: 'Desktop', now: 1_700_000_000_000 });
    // The device certificate chains to the person root…
    expect((await verifyDeviceCertificate(founder.certificate, {
      expectedPersonDid: founder.personDid, expectedDeviceDid: founder.deviceDid,
    })).ok).toBe(true);
    // …the roster verifies and lists this device active…
    expect((await verifyDeviceRoster(founder.roster, { expectedPersonDid: founder.personDid })).ok).toBe(true);
    expect(deviceStatusInRoster(founder.roster, founder.deviceDid)).toBe('active');
    // …the device key never equals the person root…
    expect(founder.deviceDid).not.toBe(founder.personDid);
    // …and the discovery secret is stored under its own name.
    expect(founder.discoverySecret?.length).toBe(32);
    expect(io.map.has(DISCOVERY_SECRET_NAME)).toBe(true);
    // The device secret is under the export-excluded prefix.
    expect([...io.map.keys()]).toContain('distributed/device-key/v1');
  });

  test('founder is idempotent: re-running keeps the same person + device dids', async () => {
    const io = fakeVault();
    const first = await ensureFounderCustody({ io, label: 'Desktop' });
    const second = await ensureFounderCustody({ io, label: 'Desktop' });
    expect(second.personDid).toBe(first.personDid);
    expect(second.deviceDid).toBe(first.deviceDid);
  });

  test('enrolled device: mints its own key, the SPONSOR certifies it, and it never sees the root', async () => {
    // The founder (Desktop) exists and holds the person identity + secret.
    const desktopVault = fakeVault();
    const founder = await ensureFounderCustody({ io: desktopVault, label: 'Desktop', now: 1 });

    // The enrollee (Laptop) mints its own device key FIRST: that did is
    // what it names in the enrollment request.
    const laptopVault = fakeVault();
    const laptopDevice = await ensureEnrolleeDevice(laptopVault);
    expect(laptopDevice.did).not.toBe(founder.deviceDid);

    // The sponsor, which holds the root, is what turns that did into
    // authority: a certificate plus the roster snapshot naming it.
    const issued = await sponsorDeviceEnrollment({
      io: desktopVault,
      deviceDid: laptopDevice.did,
      deviceId: laptopDevice.deviceId,
      priorRoster: founder.roster,
      label: 'Laptop',
      now: 2,
    });

    // The enrollee stores what it was granted. It signs nothing.
    const enrolled = await ensureEnrolledCustody({
      io: laptopVault,
      discoverySecret: founder.discoverySecret!,
      certificate: issued.certificate,
      roster: issued.roster,
      personDid: founder.personDid,
    });

    expect(enrolled.personDid).toBe(founder.personDid);       // same person
    expect(enrolled.deviceDid).toBe(laptopDevice.did);        // its own key, unchanged
    // The laptop's cert chains to the SAME root.
    expect((await verifyDeviceCertificate(enrolled.certificate, {
      expectedPersonDid: founder.personDid, expectedDeviceDid: enrolled.deviceDid,
    })).ok).toBe(true);
    // The roster supersedes the founder's and lists BOTH devices.
    expect(rosterSupersedes(enrolled.roster, founder.roster)).toBe(true);
    expect(deviceStatusInRoster(enrolled.roster, founder.deviceDid)).toBe('active');
    expect(deviceStatusInRoster(enrolled.roster, enrolled.deviceDid)).toBe('active');
    // The laptop shares the discovery secret.
    expect(await loadDiscoverySecret(laptopVault)).toEqual(founder.discoverySecret!);

    // THE invariant: the person root never landed in the enrollee's vault,
    // so a later revocation of this device is not something it can undo.
    expect(laptopVault.map.has(IDENTITY_SECRET_NAME)).toBe(false);
    expect([...laptopVault.map.values()].join('|'))
      .not.toContain(JSON.parse(desktopVault.map.get(IDENTITY_SECRET_NAME)!).seed);
  });

  test('the enrollee refuses records that do not verify against the key it holds', async () => {
    const desktopVault = fakeVault();
    const founder = await ensureFounderCustody({ io: desktopVault, label: 'Desktop', now: 1 });
    const laptopVault = fakeVault();
    await ensureEnrolleeDevice(laptopVault);

    // A certificate for a DIFFERENT device, genuinely signed by the person.
    const otherVault = fakeVault();
    const other = await ensureEnrolleeDevice(otherVault);
    const issued = await sponsorDeviceEnrollment({
      io: desktopVault, deviceDid: other.did, deviceId: other.deviceId,
      priorRoster: founder.roster, now: 2,
    });
    await expect(ensureEnrolledCustody({
      io: laptopVault,
      discoverySecret: founder.discoverySecret!,
      certificate: issued.certificate,
      roster: issued.roster,
      personDid: founder.personDid,
    })).rejects.toThrow(/unverifiable device certificate/);
  });

  test('a sponsor refuses to extend a roster it cannot verify', async () => {
    const desktopVault = fakeVault();
    const founder = await ensureFounderCustody({ io: desktopVault, label: 'Desktop', now: 1 });
    const laptop = await ensureEnrolleeDevice(fakeVault());
    // A corrupted cache must not launder entries into a person-signed record.
    const tampered = { ...founder.roster, devices: [...founder.roster.devices], seq: 1, sig: 'A'.repeat(88) };
    await expect(sponsorDeviceEnrollment({
      io: desktopVault, deviceDid: laptop.did, deviceId: laptop.deviceId,
      priorRoster: tampered, now: 2,
    })).rejects.toThrow(/unverifiable roster/);
  });

  test('loadCoordinatorInputs yields a runnable, root-free coordinator input set', async () => {
    const io = fakeVault();
    await ensureFounderCustody({ io, label: 'Desktop' });
    const inputs = await loadCoordinatorInputs(io);
    expect(inputs).not.toBeNull();
    expect(inputs!.deviceIdentity.did).toBeString();
    expect(typeof inputs!.deviceIdentity.sign).toBe('function');
    // The coordinator constructs from these without ever seeing the root.
    const coordinator = createSelfDeviceCoordinator({
      personDid: inputs!.personDid,
      deviceIdentity: inputs!.deviceIdentity,
      deviceCert: inputs!.deviceCert,
      roster: inputs!.roster,
      discoverySecret: inputs!.discoverySecret,
      mesh: { did: inputs!.deviceIdentity.did, openRoom: () => ({ roomId: 'x', direct: { send: () => {}, onMessage: () => () => {} }, onPeer: () => () => {}, peers: () => [], leave: () => {} }) },
    });
    expect(coordinator.selfDevices()).toEqual([]);
  });

  test('loadCoordinatorInputs returns null before the install joined the self-device set', async () => {
    const io = fakeVault();
    expect(await loadCoordinatorInputs(io)).toBeNull();
  });

  test('storeDiscoverySecret refuses to overwrite a DIFFERENT secret (no forking a person)', async () => {
    const io = fakeVault();
    const a = mintDiscoverySecret();
    await storeDiscoverySecret(io, a);
    await storeDiscoverySecret(io, a); // idempotent
    const b = mintDiscoverySecret();
    await expect(storeDiscoverySecret(io, b)).rejects.toThrow(/different discovery secret/);
  });
});
