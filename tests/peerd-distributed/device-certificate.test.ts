// Device certificates + the revocation roster: the person-root-signed
// authority chain every self-device decision hangs off. The adversarial
// cases here map one-to-one onto the portable-identity issue's invariants:
// a certificate from a DIFFERENT root, a certificate for a DIFFERENT key
// than the link authenticated, a tampered field, a rolled-back roster, and
// a revoked device must all die at the verifier.

import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import {
  issueDeviceCertificate, validateDeviceCertificate, verifyDeviceCertificate,
  buildDeviceRoster, validateDeviceRoster, verifyDeviceRoster,
  rosterSupersedes, deviceStatusInRoster, MAX_ROSTER_DEVICES,
} from '../../extension/peerd-distributed/identity/device-certificate.js';

const mintCert = async () => {
  const person = await generateIdentity();
  const device = await generateIdentity();
  const cert = await issueDeviceCertificate({
    personIdentity: person,
    deviceDid: device.did,
    deviceId: 'device-aaaa',
    label: 'Desktop',
    now: 1_700_000_000_000,
  });
  return { person, device, cert };
};

describe('device certificates', () => {
  test('issue → verify round-trip, with person and device bindings', async () => {
    const { person, device, cert } = await mintCert();
    expect(cert.personDid).toBe(person.did);
    expect(validateDeviceCertificate(cert)).toBeNull();
    const verdict = await verifyDeviceCertificate(cert, {
      expectedPersonDid: person.did,
      expectedDeviceDid: device.did,
    });
    expect(verdict).toEqual({ ok: true, defect: null });
  });

  test('a certificate signed by a DIFFERENT person root is refused', async () => {
    const { cert } = await mintCert();
    const otherPerson = await generateIdentity();
    const verdict = await verifyDeviceCertificate(cert, { expectedPersonDid: otherPerson.did });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('person-did-mismatch');
  });

  test('a valid certificate presented for a DIFFERENT device key is refused', async () => {
    const { person, cert } = await mintCert();
    const impostorDevice = await generateIdentity();
    // The link authenticated impostorDevice.did; the cert names someone else.
    const verdict = await verifyDeviceCertificate(cert, {
      expectedPersonDid: person.did,
      expectedDeviceDid: impostorDevice.did,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('device-did-mismatch');
  });

  test('any tampered field invalidates the signature', async () => {
    const { person, cert } = await mintCert();
    for (const patch of [
      { deviceId: 'device-bbbb' },
      { label: 'Laptop' },
      { issuedAt: cert.issuedAt + 1 },
      { seq: cert.seq + 1 },
    ]) {
      const tampered = { ...cert, ...patch };
      const verdict = await verifyDeviceCertificate(tampered, { expectedPersonDid: person.did });
      expect(verdict.ok).toBe(false);
      expect(verdict.defect).toBe('signature-invalid');
    }
  });

  test('a cert whose personDid is swapped to the attacker fails signature verification', async () => {
    const { cert } = await mintCert();
    const attacker = await generateIdentity();
    const verdict = await verifyDeviceCertificate({ ...cert, personDid: attacker.did });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('signature-invalid');
  });

  test('structural refusals happen before crypto', async () => {
    const { cert } = await mintCert();
    expect(validateDeviceCertificate(null)).toBe('not-an-object');
    expect(validateDeviceCertificate({ ...cert, v: 2 })).toBe('unsupported-version-2');
    expect(validateDeviceCertificate({ ...cert, personDid: 'nope' })).toBe('bad-person-did');
    expect(validateDeviceCertificate({ ...cert, deviceDid: cert.personDid })).toBe('device-is-person');
    expect(validateDeviceCertificate({ ...cert, deviceId: 'x'.repeat(65) })).toBe('bad-device-id');
    expect(validateDeviceCertificate({ ...cert, label: 'x'.repeat(65) })).toBe('bad-label');
    expect(validateDeviceCertificate({ ...cert, seq: 0 })).toBe('bad-seq');
    expect(validateDeviceCertificate({ ...cert, sig: '' })).toBe('bad-sig');
  });

  test('issuing refuses invalid inputs instead of signing garbage', async () => {
    const person = await generateIdentity();
    await expect(issueDeviceCertificate({
      personIdentity: person, deviceDid: 'not-a-did', deviceId: 'd',
    })).rejects.toThrow(/bad-device-did/);
  });
});

describe('device roster', () => {
  const entry = (deviceDid: string, status: 'active' | 'revoked' = 'active') => ({
    deviceDid, deviceId: `id-${deviceDid.slice(-6)}`, addedAt: 1, status,
  });

  test('build → verify round-trip, and status lookup', async () => {
    const person = await generateIdentity();
    const desktop = await generateIdentity();
    const laptop = await generateIdentity();
    const roster = await buildDeviceRoster({
      personIdentity: person,
      devices: [entry(desktop.did), entry(laptop.did, 'revoked')],
      seq: 3,
    });
    expect(validateDeviceRoster(roster)).toBeNull();
    expect((await verifyDeviceRoster(roster, { expectedPersonDid: person.did })).ok).toBe(true);
    expect(deviceStatusInRoster(roster, desktop.did)).toBe('active');
    expect(deviceStatusInRoster(roster, laptop.did)).toBe('revoked');
    const stranger = await generateIdentity();
    expect(deviceStatusInRoster(roster, stranger.did)).toBe('unknown');
    expect(deviceStatusInRoster(null, desktop.did)).toBe('unknown');
  });

  test('anti-rollback: only a strictly newer roster from the same person supersedes', async () => {
    const person = await generateIdentity();
    const device = await generateIdentity();
    const v3 = await buildDeviceRoster({ personIdentity: person, devices: [entry(device.did)], seq: 3 });
    const v4 = await buildDeviceRoster({
      personIdentity: person, devices: [entry(device.did, 'revoked')], seq: 4,
    });
    expect(rosterSupersedes(v4, v3)).toBe(true);
    expect(rosterSupersedes(v3, v4)).toBe(false); // replayed old roster
    expect(rosterSupersedes(v3, v3)).toBe(false); // equal seq is a fork, not an upgrade
    expect(rosterSupersedes(v3, null)).toBe(true);
    const otherPerson = await generateIdentity();
    const foreign = await buildDeviceRoster({ personIdentity: otherPerson, devices: [], seq: 9 });
    expect(rosterSupersedes(foreign, v3)).toBe(false);

    const erased = await buildDeviceRoster({ personIdentity: person, devices: [], seq: 5 });
    expect(rosterSupersedes(erased, v4)).toBe(false); // tombstones cannot disappear
    const resurrected = await buildDeviceRoster({
      personIdentity: person, devices: [entry(device.did, 'active')], seq: 5,
    });
    expect(rosterSupersedes(resurrected, v4)).toBe(false); // revoked stays revoked
  });

  test('a tampered roster (revocation stripped) fails verification', async () => {
    const person = await generateIdentity();
    const device = await generateIdentity();
    const roster = await buildDeviceRoster({
      personIdentity: person, devices: [entry(device.did, 'revoked')], seq: 2,
    });
    const laundered = {
      ...roster,
      devices: [{ ...roster.devices[0], status: 'active' as const }],
    };
    const verdict = await verifyDeviceRoster(laundered, { expectedPersonDid: person.did });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('signature-invalid');
  });

  test('bounds: device count, duplicates, malformed entries', async () => {
    const person = await generateIdentity();
    const device = await generateIdentity();
    const good = await buildDeviceRoster({ personIdentity: person, devices: [entry(device.did)], seq: 1 });
    expect(validateDeviceRoster({
      ...good,
      devices: Array.from({ length: MAX_ROSTER_DEVICES + 1 }, () => entry(device.did)),
    })).toBe('bad-devices');
    expect(validateDeviceRoster({
      ...good, devices: [entry(device.did), entry(device.did)],
    })).toBe('duplicate-device');
    expect(validateDeviceRoster({
      ...good, devices: [{ ...entry(device.did), status: 'paused' }],
    })).toBe('bad-entry-status');
  });
});
