import { describe, test, expect } from 'bun:test';
import { createSyncSource, createSyncReceiver } from '../../extension/peerd-distributed/self/host.js';
import {
  buildSnapshotOffer, buildSyncRefuse, encodeSurfacePayload,
} from '../../extension/peerd-distributed/self/sync.js';

const SOURCE = 'did:key:zSource';
const RECEIVER = 'did:key:zReceiver';
const selfCoordinator = { isSelfDevice: () => true };

describe('self sync host completion semantics', () => {
  test('choosing no surfaces cannot report a successful restore', async () => {
    const bytes = encodeSurfacePayload({ v: 1, settings: { theme: 'dark' } });
    const { manifest } = await buildSnapshotOffer({ surfaces: { settings: { bytes, version: 1 } } });
    const receiver = createSyncReceiver({
      coordinator: selfCoordinator, sourceDeviceDid: SOURCE,
      send: async () => true, applySurface: async () => {},
      chooseSurfaces: () => [], timeoutMs: 0,
    });
    const resultPromise = receiver.restore();
    await receiver.onFrame(SOURCE, { t: 'SYNC_OFFER', proto: 1, manifest });
    expect(await resultPromise).toEqual({ ok: false, partial: false, applied: [], refused: {} });
  });

  test('one unavailable surface yields explicit partial success, never ok:true', async () => {
    const settings = encodeSurfacePayload({ v: 1, settings: { theme: 'dark' } });
    const memory = encodeSurfacePayload({ v: 1, memory: { docs: [] } });
    const snapshot = await buildSnapshotOffer({
      surfaces: { settings: { bytes: settings, version: 1 }, memory: { bytes: memory, version: 1 } },
    });
    // Rehearse a snapshot whose settings payload disappeared after capture.
    snapshot.payloads.delete('settings');
    let receiver: ReturnType<typeof createSyncReceiver>;
    const source = createSyncSource({
      coordinator: selfCoordinator, manifest: snapshot.manifest, payloads: snapshot.payloads,
      send: (_to, frame) => receiver.onFrame(SOURCE, frame),
    });
    receiver = createSyncReceiver({
      coordinator: selfCoordinator, sourceDeviceDid: SOURCE, timeoutMs: 0,
      send: (_to, frame) => source.onFrame(RECEIVER, frame),
      applySurface: async () => {},
    });
    const resultPromise = receiver.restore();
    await receiver.onFrame(SOURCE, source.offer());
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.applied).toEqual(['memory']);
    expect(result.refused).toEqual({ settings: 'unavailable' });
  });

  test('apply failures settle as failures instead of hanging', async () => {
    const bytes = encodeSurfacePayload({ v: 1, settings: { theme: 'dark' } });
    const snapshot = await buildSnapshotOffer({ surfaces: { settings: { bytes, version: 1 } } });
    let receiver: ReturnType<typeof createSyncReceiver>;
    const source = createSyncSource({
      coordinator: selfCoordinator, manifest: snapshot.manifest, payloads: snapshot.payloads,
      send: (_to, frame) => receiver.onFrame(SOURCE, frame),
    });
    receiver = createSyncReceiver({
      coordinator: selfCoordinator, sourceDeviceDid: SOURCE, timeoutMs: 0,
      send: (_to, frame) => source.onFrame(RECEIVER, frame),
      applySurface: async () => { throw new Error('quota exceeded'); },
    });
    const resultPromise = receiver.restore();
    await receiver.onFrame(SOURCE, source.offer());
    expect(await resultPromise).toEqual({
      ok: false, partial: false, applied: [], refused: { settings: 'apply-failed' },
    });
  });

  test('a source refuses bytes that no longer match the immutable manifest', async () => {
    const original = encodeSurfacePayload({ v: 1, settings: { theme: 'dark' } });
    const snapshot = await buildSnapshotOffer({ surfaces: { settings: { bytes: original, version: 1 } } });
    snapshot.payloads.set('settings', encodeSurfacePayload({ v: 1, settings: { theme: 'light' } }));
    const sent: any[] = [];
    const source = createSyncSource({
      coordinator: selfCoordinator, manifest: snapshot.manifest, payloads: snapshot.payloads,
      send: async (_to, frame) => { sent.push(frame); },
    });
    await source.onFrame(RECEIVER, {
      t: 'SYNC_PULL', proto: 1, snapshotId: snapshot.manifest.snapshotId, surface: 'settings',
    });
    expect(sent).toEqual([buildSyncRefuse({
      snapshotId: snapshot.manifest.snapshotId, surface: 'settings', reason: 'snapshot-changed',
    })]);
  });
});
