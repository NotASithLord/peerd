// The finished-marker rehearsal, in Bun: two of a person's devices bootstrap
// custody, discover + mutually authenticate over the rendezvous mesh, and
// then transfer real state (chats, memory, settings, an App, a workspace)
// directly device-to-device, with a non-self peer proven unable to pull
// anything. Only the WebRTC layer is faked (an in-memory mesh); the
// certificates, handshake, chunking, hashing, and surface apply are the
// production code.

import { describe, test, expect } from 'bun:test';
import {
  ensureFounderCustody, ensureEnrolleeDevice, sponsorDeviceEnrollment,
  ensureEnrolledCustody, loadCoordinatorInputs,
} from '../../extension/peerd-distributed/self/custody.js';
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
  // Crypto and hashing can leave the queue empty while work is still pending.
  // Settle against the state each test needs instead of guessing an idle duration.
  const flushUntil = async (ready: () => boolean, maxTurns = 4000) => {
    for (let turn = 0; turn < maxTurns; turn++) {
      for (const fn of queue.splice(0)) fn();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (ready()) return;
    }
    throw new Error('memory mesh did not reach the expected state');
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
  return { meshFor, flushUntil };
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
    // B mints its own device key, A (the root holder) certifies it, B stores
    // the result. B never receives the person root, which is what makes the
    // roster a revocation mechanism rather than a suggestion.
    const vaultA = fakeVault();
    const founder = await ensureFounderCustody({ io: vaultA, label: 'Desktop', now: now() });
    const vaultB = fakeVault();
    const deviceB = await ensureEnrolleeDevice(vaultB);
    const issued = await sponsorDeviceEnrollment({
      io: vaultA, deviceDid: deviceB.did, deviceId: deviceB.deviceId,
      priorRoster: founder.roster, label: 'Laptop', now: now(),
    });
    const enrolled = await ensureEnrolledCustody({
      io: vaultB, discoverySecret: founder.discoverySecret!,
      certificate: issued.certificate, roster: issued.roster, personDid: founder.personDid,
    });
    expect(enrolled.personDid).toBe(founder.personDid);
    expect(vaultB.map.has('distributed/identity/v1')).toBe(false);

    // ── discovery + mutual auth over the rendezvous mesh ──
    const { meshFor, flushUntil } = createMeshFabric();
    const inputsA = (await loadCoordinatorInputs(vaultA))!;
    const inputsB = (await loadCoordinatorInputs(vaultB))!;
    const coordA = createSelfDeviceCoordinator({ ...inputsA, mesh: meshFor(inputsA.deviceIdentity.did), now });
    const coordB = createSelfDeviceCoordinator({ ...inputsB, mesh: meshFor(inputsB.deviceIdentity.did), now });
    await coordA.start();
    await coordB.start();
    await flushUntil(() => coordA.isSelfDevice(inputsB.deviceIdentity.did)
      && coordB.isSelfDevice(inputsA.deviceIdentity.did));
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
    const { manifest, payloads } = await buildSnapshotOffer({
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
      coordinator: coordA, send: sendFromA, manifest, payloads,
    });
    // Receiver applies each surface into B's fresh stores.
    const receivedSessions: any[] = [];
    const receivedApps: any[] = [];
    const receivedWorkspaces: any[] = [];
    const appliedSurfaces = new Set<string>();
    let receivedMemory: any = null;
    let receivedSettings: any = null;
    const receiver = createSyncReceiver({
      coordinator: coordB, sourceDeviceDid: inputsA.deviceIdentity.did, send: sendFromB,
      applySurface: async (surface, bytes) => {
        const payload = decodeSurface(bytes);
        appliedSurfaces.add(surface);
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
    void receiver.restore().then((r) => { result = r; });
    await sendFromA(inputsB.deviceIdentity.did, source.offer());
    // One quiescent drain carries the whole offer/pull/chunk/apply exchange.
    // If the restore did not complete, say WHAT was outstanding rather than
    // asserting on a null and leaving the next reader guessing.
    await flushUntil(() => result !== null);
    if (!result) {
      throw new Error(
        `restore did not complete: wanted=${JSON.stringify(receiver.wantedSurfaces())} `
        + `applied=${JSON.stringify([...appliedSurfaces])}`,
      );
    }

    expect(result).toEqual({
      ok: true,
      partial: false,
      applied: expect.arrayContaining(['sessions', 'memory', 'settings', 'apps', 'workspaces']),
      failed: [],
      refused: {},
    });
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
    const { manifest, payloads } = await buildSnapshotOffer({
      surfaces: { settings: { bytes, version: 1 } }, now: now(),
    });
    const sent: any[] = [];
    const source = createSyncSource({
      coordinator: coordA, send: async (_to, frame) => { sent.push(frame); }, manifest, payloads,
    });
    // An unauthenticated stranger pulls.
    await source.onFrame('did:key:zStranger', { t: 'SYNC_PULL', proto: 1, snapshotId: manifest.snapshotId, surface: 'settings' });
    expect(sent).toEqual([]); // not one chunk, not even a refusal, silent drop
    void founder;
  });

  test('the live surface reader re-reads bounded storage but never serves changed bytes', async () => {
    const original = encodeSurfacePayload({ v: 1, theme: 'dark' });
    const { manifest } = await buildSnapshotOffer({
      surfaces: { settings: { bytes: original, version: 1 } }, now: 1_700_000_000_000,
    });
    let liveBytes = original;
    let reads = 0;
    const sent: any[] = [];
    const source = createSyncSource({
      coordinator: { isSelfDevice: () => true }, manifest,
      readSurfaceBytes: async () => { reads++; return liveBytes; },
      send: async (_to, frame) => { sent.push(frame); },
    });
    const pull = {
      t: 'SYNC_PULL', proto: 1, snapshotId: manifest.snapshotId, surface: 'settings',
    };

    await source.onFrame('did:key:zSibling', pull);
    const firstTransfer = sent.map((frame) => frame.data);
    liveBytes = encodeSurfacePayload({ v: 1, theme: 'evil' });
    await source.onFrame('did:key:zSibling', pull);

    expect(reads).toBe(2);
    expect(sent.slice(firstTransfer.length)).toEqual([expect.objectContaining({
      t: 'SYNC_REFUSE', reason: 'snapshot-changed',
    })]);
  });
});
