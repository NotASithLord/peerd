// The finished-marker rehearsal, in Bun: two of a person's devices bootstrap
// custody, discover + mutually authenticate over the rendezvous mesh, and
// then transfer real state (chats, memory, settings, an App, a workspace)
// directly device-to-device, with a non-self peer proven unable to pull
// anything. Only the WebRTC layer is faked (an in-memory mesh); the
// certificates, handshake, chunking, hashing, and surface apply are the
// production code.

import { describe, test, expect } from 'bun:test';
import { ensureFounderCustody, ensureEnrolledCustody, loadCoordinatorInputs } from '../../extension/peerd-distributed/self/custody.js';
import { createSelfDeviceCoordinator } from '../../extension/peerd-distributed/self/coordinator.js';
import { createSyncSource, createSyncReceiver } from '../../extension/peerd-distributed/self/host.js';
import { buildSnapshotOffer, encodeSurfacePayload } from '../../extension/peerd-distributed/self/sync.js';
import {
  shapeSessionsSurface, shapeMemorySurface, shapeSettingsSurface,
  shapeAppsSurface, shapeWorkspacesSurface, decodeSurface, encodeSurface,
} from '../../extension/peerd-runtime/transfer/self-sync-surfaces.js';

// The in-memory mesh fabric (shared with self-coordinator.test.ts in spirit):
// rooms keyed by roomId, direct sends queued and drained.
const createMeshFabric = () => {
  type Member = { did: string; onPeer: Set<(a: { did: string }) => void>; onDirect: Set<(a: { from: string; data: any }) => void> };
  const rooms = new Map<string, Map<string, Member>>();
  const queue: Array<() => void> = [];
  const flush = async () => {
    for (let i = 0; i < 80 && queue.length; i++) {
      for (const fn of queue.splice(0)) fn();
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
      for (const [, other] of members) for (const cb of other.onPeer) queue.push(() => cb({ did }));
      members.set(did, self);
      return {
        roomId,
        direct: {
          send(toDid: string, data: any) {
            const target = rooms.get(roomId)?.get(toDid);
            if (target) for (const cb of target.onDirect) queue.push(() => cb({ from: did, data }));
            return Promise.resolve(true);
          },
          onMessage(cb: (a: { from: string; data: any }) => void) { self.onDirect.add(cb); return () => self.onDirect.delete(cb); },
        },
        onPeer(cb: (a: { did: string }) => void) {
          self.onPeer.add(cb);
          for (const [otherDid] of rooms.get(roomId)!) if (otherDid !== did) queue.push(() => cb({ did: otherDid }));
          return () => self.onPeer.delete(cb);
        },
        peers() { return [...(rooms.get(roomId)?.keys() ?? [])].filter((d) => d !== did); },
        leave() { rooms.get(roomId)?.delete(did); },
      };
    },
  });
  return { meshFor, flush };
};

const fakeVault = (seed: Record<string, string> = {}) => {
  const m = new Map(Object.entries(seed));
  return {
    getSecret: async (name: string) => m.get(name) ?? null,
    setSecret: async (name: string, value: string) => { m.set(name, value); },
    map: m,
  };
};

// Device A's accumulated state (the finished-marker inputs).
const sourceState = () => ({
  sessions: shapeSessionsSurface({ sessions: [
    { sessionId: 'chat-1', kind: 'chat', title: 'Trip planning', model: 'claude-sonnet-5', createdAt: 1,
      // session-level device bookkeeping that must NOT travel:
      originState: { mode: 'bound' }, permissionMode: 'act',
      messages: [{ role: 'user', content: 'plan a trip', streaming: true }] },
    { sessionId: 'actor-1', kind: 'actor', instanceId: 'vm-1', messages: [] }, // must NOT travel
  ] }),
  memory: shapeMemorySurface({ memory: { docs: [{ id: 'm1', text: 'I prefer window seats' }] } }),
  settings: shapeSettingsSurface({ settings: { theme: 'dark', clockEnabled: true } }),
  apps: shapeAppsSurface({ apps: [{ name: 'Timer', entryFile: 'index.html', files: { 'index.html': 'PGgxPlRpbWVyPC9oMT4=' }, contentHash: 'hash-timer' }] }),
  workspaces: shapeWorkspacesSurface({ workspaces: [{ id: 'nb-1', kind: 'notebook', files: { 'main.py': 'cHJpbnQoMSk=' } }] }),
});

describe('finished-marker rehearsal (Bun, in-memory mesh)', () => {
  test('two devices authenticate then transfer real state; the receiver materializes it', async () => {
    const now = () => 1_700_000_000_000;
    // ── custody: Device A founds, Device B enrolls under the same person ──
    const vaultA = fakeVault();
    const founder = await ensureFounderCustody({ io: vaultA, label: 'Desktop', now: now() });
    const vaultB = fakeVault({ 'distributed/identity/v1': vaultA.map.get('distributed/identity/v1')! });
    const enrolled = await ensureEnrolledCustody({
      io: vaultB, discoverySecret: founder.discoverySecret!, priorRoster: founder.roster, label: 'Laptop', now: now(),
    });
    expect(enrolled.personDid).toBe(founder.personDid);

    // ── discovery + mutual auth over the rendezvous mesh ──
    const { meshFor, flush } = createMeshFabric();
    const inputsA = (await loadCoordinatorInputs(vaultA))!;
    const inputsB = (await loadCoordinatorInputs(vaultB))!;
    const coordA = createSelfDeviceCoordinator({ ...inputsA, mesh: meshFor(inputsA.deviceIdentity.did), now });
    const coordB = createSelfDeviceCoordinator({ ...inputsB, mesh: meshFor(inputsB.deviceIdentity.did), now });
    await coordA.start();
    await coordB.start();
    await flush();
    expect(coordA.isSelfDevice(inputsB.deviceIdentity.did)).toBe(true);
    expect(coordB.isSelfDevice(inputsA.deviceIdentity.did)).toBe(true);

    // ── state transfer: A is the source, B the receiver, on a direct channel ──
    // A prepares the snapshot from its shaped surfaces.
    const state = sourceState();
    const surfaceBytes: Record<string, Uint8Array> = {
      sessions: encodeSurface(state.sessions),
      memory: encodeSurface(state.memory),
      settings: encodeSurface(state.settings),
      apps: encodeSurface(state.apps),
      workspaces: encodeSurface(state.workspaces),
    };
    const { manifest } = await buildSnapshotOffer({
      surfaces: Object.fromEntries(Object.entries(surfaceBytes).map(([name, bytes]) => [name, { bytes, version: 1 }])),
      label: 'Desktop', now: now(),
    });

    // A direct-channel between the two devices (reuse the mesh's room bus).
    const roomForTransfer = 'peerd-self/transfer'; // any shared room; auth already done
    const aRoom = meshFor(inputsA.deviceIdentity.did).openRoom(roomForTransfer);
    const bRoom = meshFor(inputsB.deviceIdentity.did).openRoom(roomForTransfer);
    const sendFromA = (to: string, frame: any) => aRoom.direct.send(to, frame);
    const sendFromB = (to: string, frame: any) => bRoom.direct.send(to, frame);

    const source = createSyncSource({
      coordinator: coordA, send: sendFromA, manifest,
      readSurfaceBytes: (surface) => surfaceBytes[surface] ?? null,
    });
    // Receiver applies each surface into B's fresh stores.
    const receivedSessions: any[] = [];
    const receivedApps: any[] = [];
    const receivedWorkspaces: any[] = [];
    let receivedMemory: any = null;
    let receivedSettings: any = null;
    const receiver = createSyncReceiver({
      coordinator: coordB, sourceDeviceDid: inputsA.deviceIdentity.did, send: sendFromB,
      applySurface: async (surface, bytes) => {
        const payload = decodeSurface(bytes);
        if (surface === 'sessions') receivedSessions.push(...payload.sessions);
        if (surface === 'memory') receivedMemory = payload.memory;
        if (surface === 'settings') receivedSettings = payload.settings;
        if (surface === 'apps') receivedApps.push(...payload.apps);
        if (surface === 'workspaces') receivedWorkspaces.push(...payload.workspaces);
      },
    });
    aRoom.direct.onMessage(({ from, data }) => source.onFrame(from, data));
    bRoom.direct.onMessage(({ from, data }) => receiver.onFrame(from, data));

    // B accepts A's offer and drives the pulls to completion.
    let result: any = null;
    const done = receiver.restore().then((r) => { result = r; return r; });
    await sendFromA(inputsB.deviceIdentity.did, source.offer());
    // Drain the mesh until the restore resolves (bounded so a real hang fails
    // instead of spinning). maybeComplete resolves `done` mid-flush.
    for (let i = 0; i < 100 && !result; i++) await flush();
    await done;

    expect(result).toEqual({ ok: true, applied: expect.arrayContaining(['sessions', 'memory', 'settings', 'apps', 'workspaces']) });
    // The chat travelled; the actor session did not.
    expect(receivedSessions.map((s) => s.sessionId)).toEqual(['chat-1']);
    expect(receivedSessions[0].title).toBe('Trip planning');
    expect(receivedSessions[0]).not.toHaveProperty('originState'); // session bookkeeping stripped
    expect(receivedSessions[0]).not.toHaveProperty('permissionMode');
    expect(receivedSessions[0].messages[0]).not.toHaveProperty('streaming'); // message scaffolding stripped
    expect(receivedMemory.docs[0].text).toBe('I prefer window seats');
    expect(receivedSettings.theme).toBe('dark');
    expect(receivedApps[0].name).toBe('Timer');
    expect(receivedWorkspaces[0].files['main.py']).toBe('cHJpbnQoMSk=');
  });

  test('a non-self peer that reaches the transfer channel gets nothing (endpoint refuses)', async () => {
    const now = () => 1_700_000_000_000;
    const vaultA = fakeVault();
    const founder = await ensureFounderCustody({ io: vaultA, label: 'Desktop', now: now() });
    const inputsA = (await loadCoordinatorInputs(vaultA))!;
    const { meshFor } = createMeshFabric();
    // A coordinator that has NOT authenticated the caller.
    const coordA = createSelfDeviceCoordinator({ ...inputsA, mesh: meshFor(inputsA.deviceIdentity.did), now });

    const bytes = encodeSurfacePayload({ v: 1, secret: 'top' });
    const { manifest } = await buildSnapshotOffer({ surfaces: { settings: { bytes, version: 1 } }, now: now() });
    const sent: any[] = [];
    const source = createSyncSource({
      coordinator: coordA, send: async (_to, frame) => { sent.push(frame); }, manifest,
      readSurfaceBytes: () => bytes,
    });
    // An unauthenticated stranger pulls.
    await source.onFrame('did:key:zStranger', { t: 'SYNC_PULL', proto: 1, snapshotId: manifest.snapshotId, surface: 'settings' });
    expect(sent).toEqual([]); // not one chunk, not even a refusal, silent drop
    void founder;
  });
});
