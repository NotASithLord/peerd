// The self-device state-transfer protocol: offer/pull/chunk mechanics,
// hash-gated apply, interruption + idempotent re-pull, and the payload
// hostility cases (issue invariant 18 — a malformed sync payload must not
// be able to write anywhere unexpected).

import { describe, test, expect } from 'bun:test';
import {
  buildSnapshotOffer, validateSnapshotManifest, buildSyncOffer, buildSyncPull,
  buildSyncRefuse, buildSyncChunks, validateSyncPull, createSurfaceCollector,
  encodeSurfacePayload, decodeSurfacePayload, surfaceHash,
  SYNC_CHUNK_BYTES, SYNC_SURFACES,
} from '../../extension/peerd-distributed/self/sync.js';

// The collector result is a discriminated union; `defect` lives only on the
// 'failed' arm. Narrow before reading it.
type CollectResult = Awaited<ReturnType<ReturnType<typeof createSurfaceCollector>['accept']>>;
const defectOf = (result: CollectResult) => (result.state === 'failed' ? result.defect : undefined);

const sampleSurfaces = () => ({
  settings: { bytes: encodeSurfacePayload({ theme: 'dark', clock: true }), version: 1, count: 2 },
  memory: { bytes: encodeSurfacePayload({ docs: [{ id: 'm1', text: 'remember' }] }), version: 1, count: 1 },
  sessions: {
    // Big enough to need several chunks.
    bytes: encodeSurfacePayload({ sessions: [{ sessionId: 's1', messages: 'x'.repeat(SYNC_CHUNK_BYTES * 2 + 100) }] }),
    version: 1,
    count: 1,
  },
});

describe('snapshot offers', () => {
  test('offer → validate → pull → chunks → collect → decode round-trip', async () => {
    const { manifest, payloads } = await buildSnapshotOffer({
      surfaces: sampleSurfaces(), label: 'Desktop', now: 1_700_000_000_000,
    });
    expect(validateSnapshotManifest(manifest)).toBeNull();
    expect(buildSyncOffer(manifest).t).toBe('SYNC_OFFER');

    for (const entry of manifest.surfaces) {
      const pull = buildSyncPull({ snapshotId: manifest.snapshotId, surface: entry.name });
      expect(validateSyncPull(pull, { manifest })).toBeNull();
      const frames = buildSyncChunks({
        snapshotId: manifest.snapshotId, surface: entry.name, bytes: payloads.get(entry.name)!,
      });
      const collector = createSurfaceCollector({ entry, snapshotId: manifest.snapshotId });
      let result: any = null;
      for (const frame of frames) result = await collector.accept(frame);
      expect(result.state).toBe('complete');
      expect(decodeSurfacePayload(result.bytes)).toEqual(decodeSurfacePayload(payloads.get(entry.name)!));
    }
  });

  test('multi-chunk surfaces reassemble out of order', async () => {
    const { manifest, payloads } = await buildSnapshotOffer({ surfaces: sampleSurfaces() });
    const entry = manifest.surfaces.find((row) => row.name === 'sessions')!;
    const frames = buildSyncChunks({
      snapshotId: manifest.snapshotId, surface: 'sessions', bytes: payloads.get('sessions')!,
    });
    expect(frames.length).toBeGreaterThan(2);
    const collector = createSurfaceCollector({ entry, snapshotId: manifest.snapshotId });
    let result: any = null;
    for (const frame of [...frames].reverse()) result = await collector.accept(frame);
    expect(result.state).toBe('complete');
  });

  test('interruption: a dropped transfer re-pulls the SAME bytes (idempotent retry)', async () => {
    const { manifest, payloads } = await buildSnapshotOffer({ surfaces: sampleSurfaces() });
    const entry = manifest.surfaces.find((row) => row.name === 'sessions')!;
    const frames = buildSyncChunks({
      snapshotId: manifest.snapshotId, surface: 'sessions', bytes: payloads.get('sessions')!,
    });
    // First attempt dies mid-transfer…
    const attempt1 = createSurfaceCollector({ entry, snapshotId: manifest.snapshotId });
    const partial = await attempt1.accept(frames[0]);
    expect(partial.state).toBe('collecting');
    // …the receiver re-pulls with a FRESH collector; the source re-chunks
    // the same snapshot bytes, and the hash proves nothing drifted.
    const attempt2 = createSurfaceCollector({ entry, snapshotId: manifest.snapshotId });
    let result: any = null;
    for (const frame of buildSyncChunks({
      snapshotId: manifest.snapshotId, surface: 'sessions', bytes: payloads.get('sessions')!,
    })) result = await attempt2.accept(frame);
    expect(result.state).toBe('complete');
    expect(await surfaceHash(result.bytes)).toBe(entry.hash);
  });

  test('a tampered chunk fails the surface hash, not the apply', async () => {
    const { manifest, payloads } = await buildSnapshotOffer({ surfaces: sampleSurfaces() });
    const entry = manifest.surfaces.find((row) => row.name === 'settings')!;
    const [frame] = buildSyncChunks({
      snapshotId: manifest.snapshotId, surface: 'settings', bytes: payloads.get('settings')!,
    });
    const collector = createSurfaceCollector({ entry, snapshotId: manifest.snapshotId });
    const tamperedData = encodeSurfacePayload({ theme: 'dark', clock: true, hooksEnabled: 'all' });
    const result = await collector.accept({
      ...frame,
      data: btoa(String.fromCharCode(...tamperedData)),
    });
    // Same JSON shape, different bytes → size or hash mismatch, refused.
    expect(result.state).toBe('failed');
    expect(['size-mismatch', 'hash-mismatch']).toContain(defectOf(result)!);
  });

  test('hostile frames are refused: wrong surface, changed totals, oversize chunks', async () => {
    const { manifest, payloads } = await buildSnapshotOffer({ surfaces: sampleSurfaces() });
    const entry = manifest.surfaces.find((row) => row.name === 'settings')!;
    const [frame] = buildSyncChunks({
      snapshotId: manifest.snapshotId, surface: 'settings', bytes: payloads.get('settings')!,
    });
    const wrongSurface = createSurfaceCollector({ entry, snapshotId: manifest.snapshotId });
    expect(defectOf(await wrongSurface.accept({ ...frame, surface: 'memory' }))).toBe('wrong-surface');

    const badTotal = createSurfaceCollector({ entry, snapshotId: manifest.snapshotId });
    expect(defectOf(await badTotal.accept({ ...frame, total: 5000 }))).toBe('bad-total');

    const badSeq = createSurfaceCollector({ entry, snapshotId: manifest.snapshotId });
    expect(defectOf(await badSeq.accept({ ...frame, seq: 7 }))).toBe('bad-seq');

    const junkData = createSurfaceCollector({ entry, snapshotId: manifest.snapshotId });
    expect(defectOf(await junkData.accept({ ...frame, data: '!!not-base64!!' }))).toBe('bad-data');
  });

  test('manifest hostility: unknown surfaces, duplicates, oversize claims, bad hashes', async () => {
    const { manifest } = await buildSnapshotOffer({ surfaces: sampleSurfaces() });
    expect(validateSnapshotManifest({
      ...manifest,
      surfaces: [{ name: 'vault-dump', version: 1, bytes: 10, hash: 'a'.repeat(64) }],
    })).toBe('unknown-surface-vault-dump');
    expect(validateSnapshotManifest({
      ...manifest, surfaces: [manifest.surfaces[0], manifest.surfaces[0]],
    })).toBe('duplicate-surface');
    expect(validateSnapshotManifest({
      ...manifest,
      surfaces: [{ name: 'settings', version: 1, bytes: 1024 * 1024 * 1024, hash: 'a'.repeat(64) }],
    })).toBe('bad-surface-bytes');
    expect(validateSnapshotManifest({
      ...manifest,
      surfaces: [{ ...manifest.surfaces[0], hash: 'ZZZ' }],
    })).toBe('bad-surface-hash');
    expect(validateSnapshotManifest({ ...manifest, v: 9 })).toBe('unsupported-version-9');
  });

  test('pull validation refuses unknown snapshots and unoffered surfaces', async () => {
    const { manifest } = await buildSnapshotOffer({ surfaces: sampleSurfaces() });
    expect(validateSyncPull(
      buildSyncPull({ snapshotId: 'other-snapshot', surface: 'settings' }), { manifest },
    )).toBe('unknown-snapshot');
    expect(validateSyncPull(
      buildSyncPull({ snapshotId: manifest.snapshotId, surface: 'secrets' }), { manifest },
    )).toBe('unknown-surface'); // secrets wasn't offered — consent withheld
  });

  test('the surface list is closed and secrets is an explicit, separate surface', () => {
    expect(SYNC_SURFACES).toContain('secrets');
    expect(SYNC_SURFACES).not.toContain('permission-grants');
    expect(SYNC_SURFACES).not.toContain('audit');
    expect(SYNC_SURFACES).not.toContain('device-keys');
  });

  test('an oversize surface is refused at OFFER build time (source-side cap)', async () => {
    await expect(buildSnapshotOffer({
      surfaces: { settings: { bytes: new Uint8Array(300 * 1024), version: 1 } },
    })).rejects.toThrow(/exceeds its transfer cap/);
  });

  test('refusal frames carry a bounded reason', () => {
    const refuse = buildSyncRefuse({
      snapshotId: 's', surface: 'secrets', reason: 'consent-withheld'.repeat(20),
    });
    expect(refuse.reason.length).toBeLessThanOrEqual(64);
  });
});
