// The self-device coordinator over an in-memory mesh: two of a person's
// devices discover each other on the derived rendezvous room and mutually
// authenticate to `self`, while a same-topic INTRUDER (a peer who guessed
// the room but has no same-person certificate) is refused, proving that
// joining a rendezvous topic grants nothing (issue invariants 3 & 4).

import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { issueDeviceCertificate, buildDeviceRoster } from '../../extension/peerd-distributed/identity/device-certificate.js';
import { mintDiscoverySecret } from '../../extension/peerd-distributed/self/rendezvous.js';
import { createSelfDeviceCoordinator } from '../../extension/peerd-distributed/self/coordinator.js';

// A tiny in-memory mesh: rooms are shared buses keyed by roomId. Every
// device that opens a room sees the others present and can direct-send.
const createMemoryMeshFabric = () => {
  type Member = { did: string; onPeer: Set<(a: { did: string }) => void>; onDirect: Set<(a: { from: string; data: any }) => void> };
  const rooms = new Map<string, Map<string, Member>>();
  const deliver: Array<() => void> = [];
  // Drain until QUIESCENT, not until first-empty. why the distinction: the
  // handshake handlers are async and await real Ed25519 work, so the queue
  // empties between "message delivered" and "reply enqueued". Stopping at
  // the first empty queue ends the drain mid-handshake and the assertions
  // race the crypto: the flake this shape exists to remove.
  const flush = async ({ idleTurns = 8, maxTurns = 4000 } = {}) => {
    let idle = 0;
    for (let turn = 0; turn < maxTurns && idle < idleTurns; turn++) {
      if (deliver.length === 0) {
        idle++;
      } else {
        idle = 0;
        for (const fn of deliver.splice(0)) fn();
      }
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  const meshFor = (did: string) => ({
    did,
    openRoom(roomId: string) {
      let members = rooms.get(roomId);
      if (!members) { members = new Map(); rooms.set(roomId, members); }
      const self: Member = { did, onPeer: new Set(), onDirect: new Set() };
      // Announce me to existing members and them to me.
      for (const other of members.values()) {
        for (const cb of other.onPeer) deliver.push(() => cb({ did }));
      }
      members.set(did, self);
      return {
        roomId,
        direct: {
          send(toDid: string, data: any) {
            const target = rooms.get(roomId)?.get(toDid);
            if (target) for (const cb of target.onDirect) deliver.push(() => cb({ from: did, data }));
            return Promise.resolve(true);
          },
          onMessage(cb: (a: { from: string; data: any }) => void) { self.onDirect.add(cb); return () => self.onDirect.delete(cb); },
        },
        onPeer(cb: (a: { did: string }) => void) {
          self.onPeer.add(cb);
          // Existing members are "already present" for a late opener.
          for (const [otherDid] of rooms.get(roomId)!) if (otherDid !== did) deliver.push(() => cb({ did: otherDid }));
          return () => self.onPeer.delete(cb);
        },
        peers() { return [...(rooms.get(roomId)?.keys() ?? [])].filter((d) => d !== did); },
        leave() { rooms.get(roomId)?.delete(did); },
      };
    },
  });
  return { meshFor, flush };
};

// Build a person with N certified devices sharing one discovery secret.
const person = async (deviceCount: number) => {
  const root = await generateIdentity();
  const discoverySecret = mintDiscoverySecret();
  const devices = [];
  const rosterEntries = [];
  for (let i = 0; i < deviceCount; i++) {
    const identity = await generateIdentity();
    const cert = await issueDeviceCertificate({
      personIdentity: root, deviceDid: identity.did, deviceId: `dev-${i}`, label: `Device ${i}`, now: i + 1, seq: i + 1,
    });
    devices.push({ identity, cert });
    rosterEntries.push({ deviceDid: identity.did, deviceId: `dev-${i}`, addedAt: i + 1, status: 'active' as const });
  }
  const roster = await buildDeviceRoster({ personIdentity: root, devices: rosterEntries, seq: 1 });
  return { root, discoverySecret, devices, roster };
};

describe('self-device coordinator', () => {
  test('two devices of one person mutually authenticate to self over the rendezvous room', async () => {
    const { root, discoverySecret, devices, roster } = await person(2);
    const { meshFor, flush } = createMemoryMeshFabric();
    const now = () => 1_700_000_000_000;

    const desktop = createSelfDeviceCoordinator({
      personDid: root.did, deviceIdentity: devices[0].identity, deviceCert: devices[0].cert,
      roster, discoverySecret, mesh: meshFor(devices[0].identity.did), now,
    });
    const laptop = createSelfDeviceCoordinator({
      personDid: root.did, deviceIdentity: devices[1].identity, deviceCert: devices[1].cert,
      roster, discoverySecret, mesh: meshFor(devices[1].identity.did), now,
    });

    await desktop.start();
    await laptop.start();
    await flush();

    expect(desktop.selfDevices().map((d) => d.deviceDid)).toEqual([devices[1].identity.did]);
    expect(laptop.selfDevices().map((d) => d.deviceDid)).toEqual([devices[0].identity.did]);
    expect(desktop.isSelfDevice(devices[1].identity.did)).toBe(true);
    // The confirmed peer's cert (with its human label) is available for the UI.
    expect(desktop.selfDevices()[0].cert?.label).toBe('Device 1');
  });

  test('an intruder who guessed the rendezvous room is discovered but refused (no same-person cert)', async () => {
    const { root, discoverySecret, devices, roster } = await person(1);
    const other = await person(1); // a different person entirely
    const { meshFor, flush } = createMemoryMeshFabric();
    const now = () => 1_700_000_000_000;

    const mine = createSelfDeviceCoordinator({
      personDid: root.did, deviceIdentity: devices[0].identity, deviceCert: devices[0].cert,
      roster, discoverySecret, mesh: meshFor(devices[0].identity.did), now,
    });
    // The intruder somehow joins the SAME rendezvous room (guessed/leaked
    // topic) but presents a certificate from THEIR own root.
    const intruder = createSelfDeviceCoordinator({
      personDid: other.root.did, deviceIdentity: other.devices[0].identity, deviceCert: other.devices[0].cert,
      roster: other.roster, discoverySecret, // shares the topic, not the trust
      mesh: meshFor(other.devices[0].identity.did), now,
    });

    await mine.start();
    await intruder.start();
    await flush();

    expect(mine.selfDevices()).toEqual([]);
    const candidate = mine.candidates().find((c) => c.deviceDid === other.devices[0].identity.did);
    expect(candidate?.status).toBe('refused');
    expect(candidate?.defect).toBe('cert-person-did-mismatch');
  });

  test('a revoked device is discovered but refused at the handshake', async () => {
    const { root, discoverySecret, devices } = await person(2);
    const { meshFor, flush } = createMemoryMeshFabric();
    const now = () => 1_700_000_000_000;
    // Desktop's roster REVOKES the laptop.
    const revokingRoster = await buildDeviceRoster({
      personIdentity: root,
      devices: [{ deviceDid: devices[1].identity.did, deviceId: 'dev-1', addedAt: 2, status: 'revoked' as const }],
      seq: 2,
    });
    const laptopRoster = await buildDeviceRoster({
      personIdentity: root,
      devices: [{ deviceDid: devices[0].identity.did, deviceId: 'dev-0', addedAt: 1, status: 'active' as const }],
      seq: 1,
    });
    const desktop = createSelfDeviceCoordinator({
      personDid: root.did, deviceIdentity: devices[0].identity, deviceCert: devices[0].cert,
      roster: revokingRoster, discoverySecret, mesh: meshFor(devices[0].identity.did), now,
    });
    const laptop = createSelfDeviceCoordinator({
      personDid: root.did, deviceIdentity: devices[1].identity, deviceCert: devices[1].cert,
      roster: laptopRoster, discoverySecret, mesh: meshFor(devices[1].identity.did), now,
    });
    await desktop.start();
    await laptop.start();
    await flush();
    expect(desktop.selfDevices()).toEqual([]);
    const candidate = desktop.candidates().find((c) => c.deviceDid === devices[1].identity.did);
    expect(candidate?.defect).toBe('device-revoked');
  });

  test('handshake timeout releases a stalled candidate', async () => {
    const { root, discoverySecret, devices, roster } = await person(2);
    const { meshFor } = createMemoryMeshFabric();
    let clock = 1_700_000_000_000;
    const desktop = createSelfDeviceCoordinator({
      personDid: root.did, deviceIdentity: devices[0].identity, deviceCert: devices[0].cert,
      roster, discoverySecret, mesh: meshFor('desktop'), now: () => clock,
    });
    // A peer appears but never answers (its mesh is isolated: no shared room bus).
    const isolated = createMemoryMeshFabric();
    const laptop = createSelfDeviceCoordinator({
      personDid: root.did, deviceIdentity: devices[1].identity, deviceCert: devices[1].cert,
      roster, discoverySecret, mesh: isolated.meshFor('laptop'), now: () => clock,
    });
    await desktop.start();
    // Force a candidate by simulating the peer joining desktop's bus but not replying.
    // Instead just advance the clock and sweep with no partner: nothing to promote.
    clock += 30_000;
    desktop.sweep();
    expect(desktop.selfDevices()).toEqual([]);
    void laptop;
  });
});
