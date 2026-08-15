// The custody composition: a founder bootstraps the self-device world, an
// enrolled device joins it, and both end up able to run the coordinator and
// mutually authenticate: the whole "device key + certificate + discovery
// secret" chain, end to end, over a fake vault secret store.

import { describe, test, expect } from 'bun:test';
import {
  ensureFounderCustody, ensureEnrolleeDevice, sponsorDeviceEnrollment,
  ensureEnrolledCustody, loadCoordinatorInputs,
  loadDiscoverySecret, storeDiscoverySecret, rotateDiscoverySecret, DISCOVERY_SECRET_NAME,
} from '../../extension/peerd-distributed/self/custody.js';
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

  test('enrolled device: keeps its own key and adopts sponsor-issued records without the root', async () => {
    // The founder (Desktop) exists and holds a person identity + secret.
    const desktopVault = fakeVault();
    const founder = await ensureFounderCustody({ io: desktopVault, label: 'Desktop', now: 1 });

    const laptopVault = fakeVault();
    const laptopDevice = await ensureEnrolleeDevice(laptopVault);
    const issued = await sponsorDeviceEnrollment({
      io: desktopVault,
      priorRoster: founder.roster,
      deviceDid: laptopDevice.did,
      deviceId: laptopDevice.deviceId,
      label: 'Laptop',
      now: 2,
    });
    const enrolled = await ensureEnrolledCustody({
      io: laptopVault,
      discoverySecret: founder.discoverySecret!,
      certificate: issued.certificate,
      roster: issued.roster,
      personDid: founder.personDid,
    });

    expect(enrolled.personDid).toBe(founder.personDid);       // same person
    expect(enrolled.deviceDid).not.toBe(founder.deviceDid);   // distinct device key
    // The laptop's cert chains to the SAME root.
    expect((await verifyDeviceCertificate(enrolled.certificate, {
      expectedPersonDid: founder.personDid, expectedDeviceDid: enrolled.deviceDid,
    })).ok).toBe(true);
    // Its roster supersedes the founder's and lists BOTH devices.
    expect(rosterSupersedes(enrolled.roster, founder.roster)).toBe(true);
    expect(deviceStatusInRoster(enrolled.roster, founder.deviceDid)).toBe('active');
    expect(deviceStatusInRoster(enrolled.roster, enrolled.deviceDid)).toBe('active');
    // The laptop shares the discovery secret.
    expect(await loadDiscoverySecret(laptopVault)).toEqual(founder.discoverySecret!);
    expect(laptopVault.map.has('distributed/identity/v1')).toBe(false);
    await expect(ensureFounderCustody({ io: laptopVault })).rejects.toThrow(/not a person-root authority/);
    expect(laptopVault.map.has('distributed/identity/v1')).toBe(false);

    // An ordinary enrolled device cannot sponsor another device or cause a
    // replacement root to be minted as a side effect.
    const third = await ensureEnrolleeDevice(fakeVault());
    await expect(sponsorDeviceEnrollment({
      io: laptopVault, priorRoster: issued.roster,
      deviceDid: third.did, deviceId: third.deviceId,
    })).rejects.toThrow(/not a person-root enrollment authority/);
    expect(laptopVault.map.has('distributed/identity/v1')).toBe(false);
  });

  test('a lost grant is reissued idempotently without a ghost roster row', async () => {
    const sponsor = fakeVault();
    const founder = await ensureFounderCustody({ io: sponsor, label: 'Desktop', now: 10 });
    const enrollee = await ensureEnrolleeDevice(fakeVault());
    const first = await sponsorDeviceEnrollment({
      io: sponsor, priorRoster: founder.roster,
      deviceDid: enrollee.did, deviceId: enrollee.deviceId, label: 'Laptop', now: 20,
    });
    // The caller only knows its stale pre-commit roster because the first
    // sealed grant was lost. The sponsor reconstructs the committed result.
    const retry = await sponsorDeviceEnrollment({
      io: sponsor, priorRoster: founder.roster,
      deviceDid: enrollee.did, deviceId: enrollee.deviceId, label: 'Ignored retry label', now: 99,
    });
    expect(retry.roster).toEqual(first.roster);
    expect(retry.certificate).toEqual(first.certificate);
    expect(retry.roster.devices.filter((d: any) => d.deviceDid === enrollee.did)).toHaveLength(1);
  });

  test('an interrupted enrollment commits the membership fence before discovery', async () => {
    const sponsor = fakeVault();
    const founder = await ensureFounderCustody({ io: sponsor, now: 1 });
    const enrolleeVault = fakeVault();
    const enrollee = await ensureEnrolleeDevice(enrolleeVault);
    const issued = await sponsorDeviceEnrollment({
      io: sponsor, priorRoster: founder.roster,
      deviceDid: enrollee.did, deviceId: enrollee.deviceId, now: 2,
    });
    const writes: string[] = [];
    const interrupted = {
      getSecret: enrolleeVault.getSecret,
      setSecret: async (name: string, value: string) => {
        writes.push(name);
        if (name === DISCOVERY_SECRET_NAME) throw new Error('quota while writing discovery');
        await enrolleeVault.setSecret(name, value);
      },
    };
    await expect(ensureEnrolledCustody({
      io: interrupted, discoverySecret: founder.discoverySecret!,
      certificate: issued.certificate, roster: issued.roster,
    })).rejects.toThrow(/quota while writing discovery/);
    expect(writes.slice(-2)).toEqual(['distributed/self-records/v1', DISCOVERY_SECRET_NAME]);
    expect(enrolleeVault.map.has('distributed/self-records/v1')).toBe(true);
    expect(enrolleeVault.map.has(DISCOVERY_SECRET_NAME)).toBe(false);
    await expect(ensureFounderCustody({ io: enrolleeVault }))
      .rejects.toThrow(/not a person-root authority/);
    expect(enrolleeVault.map.has('distributed/identity/v1')).toBe(false);
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

  test('discovery rotation is compare-and-set and cannot apply against stale custody', async () => {
    const io = fakeVault();
    const current = mintDiscoverySecret();
    const next = mintDiscoverySecret();
    await storeDiscoverySecret(io, current);
    expect(await rotateDiscoverySecret(io, { expected: current, next })).toBe(true);
    expect(await loadDiscoverySecret(io)).toEqual(next);
    await expect(rotateDiscoverySecret(io, {
      expected: current, next: mintDiscoverySecret(),
    })).rejects.toThrow(/changed before rotation/);
  });
});
