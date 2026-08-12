import { describe, test, expect } from 'bun:test';
import { createSyncSource, createSyncReceiver } from '../../extension/peerd-distributed/self/host.js';
import {
  buildSnapshotOffer, buildSyncChunks, buildSyncRefuse, encodeSurfacePayload,
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
    expect(await resultPromise).toEqual({
      ok: false, partial: false, applied: [], failed: [], refused: {},
    });
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

  test('a requested surface unavailable at capture remains part of completeness', async () => {
    const settings = encodeSurfacePayload({ v: 1, settings: { theme: 'dark' } });
    const snapshot = await buildSnapshotOffer({
      surfaces: { settings: { bytes: settings, version: 1 } },
    });
    snapshot.manifest.unavailable = { apps: 'capture-failed' };
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
    expect(await resultPromise).toEqual({
      ok: false,
      partial: true,
      applied: ['settings'],
      failed: [],
      refused: { apps: 'capture-failed' },
    });
  });

  test('a requested surface omitted without an unavailable row cannot disappear into success', async () => {
    const settings = encodeSurfacePayload({ v: 1, settings: { theme: 'dark' } });
    const snapshot = await buildSnapshotOffer({
      surfaces: { settings: { bytes: settings, version: 1 } },
    });
    let receiver: ReturnType<typeof createSyncReceiver>;
    const source = createSyncSource({
      coordinator: selfCoordinator, manifest: snapshot.manifest, payloads: snapshot.payloads,
      send: (_to, frame) => receiver.onFrame(SOURCE, frame),
    });
    receiver = createSyncReceiver({
      coordinator: selfCoordinator, sourceDeviceDid: SOURCE, timeoutMs: 0,
      send: (_to, frame) => source.onFrame(RECEIVER, frame),
      chooseSurfaces: () => ['settings', 'apps'], applySurface: async () => {},
    });
    const resultPromise = receiver.restore();
    await receiver.onFrame(SOURCE, source.offer());
    expect(await resultPromise).toMatchObject({
      ok: false, partial: true, applied: ['settings'], refused: { apps: 'missing-from-offer' },
    });
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
      ok: false,
      partial: false,
      applied: [],
      failed: [{ surface: 'settings', defect: 'apply-failed/Error' }],
      refused: {},
    });
  });

  test('item-level writes before an apply failure are reported as partial effects', async () => {
    const bytes = encodeSurfacePayload({ v: 1, sessions: [{ sessionId: 'a' }, { sessionId: 'b' }] });
    const snapshot = await buildSnapshotOffer({ surfaces: { sessions: { bytes, version: 1 } } });
    let receiver: ReturnType<typeof createSyncReceiver>;
    const source = createSyncSource({
      coordinator: selfCoordinator, manifest: snapshot.manifest, payloads: snapshot.payloads,
      send: (_to, frame) => receiver.onFrame(SOURCE, frame),
    });
    receiver = createSyncReceiver({
      coordinator: selfCoordinator, sourceDeviceDid: SOURCE, timeoutMs: 0,
      send: (_to, frame) => source.onFrame(RECEIVER, frame),
      applySurface: async () => {
        const error: any = new Error('second session failed');
        error.partialResult = { written: 1, skipped: 0 };
        throw error;
      },
    });
    const resultPromise = receiver.restore();
    await receiver.onFrame(SOURCE, source.offer());
    expect(await resultPromise).toEqual({
      ok: false,
      partial: true,
      applied: [],
      failed: [{
        surface: 'sessions', defect: 'apply-failed/Error', partial: { written: 1, skipped: 0 },
      }],
      partialEffects: { sessions: { written: 1, skipped: 0 } },
      refused: {},
    });
  });

  test('parallel duplicate pulls coalesce into one streamed serve', async () => {
    const bytes = encodeSurfacePayload({ v: 1, sessions: [{ content: 'x'.repeat(100_000) }] });
    const snapshot = await buildSnapshotOffer({ surfaces: { sessions: { bytes, version: 1 } } });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let sends = 0;
    const events: string[] = [];
    const source = createSyncSource({
      coordinator: selfCoordinator, manifest: snapshot.manifest, payloads: snapshot.payloads,
      send: async () => { sends++; if (sends === 1) await firstBlocked; },
      onEvent: (event) => events.push(event),
    });
    const pull = {
      t: 'SYNC_PULL', proto: 1, snapshotId: snapshot.manifest.snapshotId, surface: 'sessions',
    };
    const first = source.onFrame(RECEIVER, pull);
    while (sends === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const duplicate = source.onFrame(RECEIVER, pull);
    releaseFirst();
    await Promise.all([first, duplicate]);
    expect(sends).toBe(buildSyncChunks({
      snapshotId: snapshot.manifest.snapshotId, surface: 'sessions', bytes,
    }).length);
    expect(events).toContain('surface_pull_coalesced');
  });

  test('sequential pull replay is capped for an authenticated sibling', async () => {
    const bytes = encodeSurfacePayload({ v: 1, settings: { theme: 'dark' } });
    const snapshot = await buildSnapshotOffer({ surfaces: { settings: { bytes, version: 1 } } });
    const sent: any[] = [];
    const source = createSyncSource({
      coordinator: selfCoordinator, manifest: snapshot.manifest, payloads: snapshot.payloads,
      send: async (_to, frame) => { sent.push(frame); },
    });
    const pull = {
      t: 'SYNC_PULL', proto: 1, snapshotId: snapshot.manifest.snapshotId, surface: 'settings',
    };
    for (let i = 0; i < 10; i++) await source.onFrame(RECEIVER, pull);
    expect(sent.filter((frame) => frame.t === 'SYNC_CHUNK')).toHaveLength(4);
    expect(sent.filter((frame) => frame.t === 'SYNC_REFUSE').map((frame) => frame.reason))
      .toEqual(Array(6).fill('pull-limit'));
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
