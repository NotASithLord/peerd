// The receiver's TERMINATION guarantees.
//
// The sync source is an authenticated self device, but authenticated is not
// correct: a buggy or compromised sibling must not be able to hold a fresh
// install in an unbounded pull/serve loop with `restore()` never settling.
// So every surface must reach exactly one end state, deterministic defects
// must be terminal rather than re-pulled, and the one thing that DOES earn
// a re-pull (silence) must be capped and backed off.

import { describe, test, expect } from 'bun:test';
import { createSyncReceiver } from '../../extension/peerd-distributed/self/host.js';
import {
  buildSnapshotOffer, buildSyncOffer, buildSyncChunks, buildSyncRefuse,
  encodeSurfacePayload, syncDefectDisposition, SYNC_DEFECT_DISPOSITIONS,
} from '../../extension/peerd-distributed/self/sync.js';

const SOURCE = 'did:key:zSource';

const selfCoordinator = { isSelfDevice: (did: string) => did === SOURCE };

/** Let queued promise jobs run: `restore()` settles a promise, not a value. */
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * A manual clock: timers are queued, never real, so a "30s stall" and three
 * exponential backoffs run in microseconds and the test asserts on the
 * ORDER and COUNT of retries rather than on wall time.
 */
const manualClock = () => {
  const queue: Array<{ id: number; fn: () => void; at: number }> = [];
  let nextId = 1;
  let clock = 0;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      queue.push({ id, fn, at: clock + ms });
      return id;
    },
    clearTimer: (id: number) => {
      const at = queue.findIndex((entry) => entry.id === id);
      if (at >= 0) queue.splice(at, 1);
    },
    pendingCount: () => queue.length,
    /** Fire every due timer, then let queued promise jobs drain. */
    advance: async (ms: number) => {
      clock += ms;
      for (let guard = 0; guard < 100; guard++) {
        const due = queue.filter((entry) => entry.at <= clock);
        if (due.length === 0) break;
        for (const entry of due) {
          const at = queue.indexOf(entry);
          if (at >= 0) queue.splice(at, 1);
          entry.fn();
        }
        await new Promise((r) => setTimeout(r, 0));
      }
      await new Promise((r) => setTimeout(r, 0));
    },
  };
};

const oneSurfaceSnapshot = async () => {
  const bytes = encodeSurfacePayload({ theme: 'dark' });
  const { manifest } = await buildSnapshotOffer({
    surfaces: { settings: { bytes, version: 1 } }, now: 1_700_000_000_000,
  });
  return { manifest, bytes };
};

/** Drive a receiver with a captured outbound frame log. */
const harness = async (overrides: Record<string, unknown> = {}) => {
  const { manifest, bytes } = await oneSurfaceSnapshot();
  const sent: any[] = [];
  const events: Array<{ event: string; detail: any }> = [];
  const applied: string[] = [];
  const clock = manualClock();
  const receiver = createSyncReceiver({
    coordinator: selfCoordinator,
    sourceDeviceDid: SOURCE,
    send: (_to: string, frame: any) => { sent.push(frame); },
    applySurface: async (surface: string) => { applied.push(surface); },
    onEvent: (event: string, detail: any) => { events.push({ event, detail }); },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  } as any);
  let settled: any = null;
  void receiver.restore().then((r: any) => { settled = r; });
  await receiver.onFrame(SOURCE, buildSyncOffer(manifest));
  return {
    manifest, bytes, sent, events, applied, clock, receiver,
    result: () => settled,
    pulls: () => sent.filter((f) => f.t === 'SYNC_PULL').length,
  };
};

describe('deterministic defects are terminal, not re-pulled', () => {
  test('a hash mismatch fails the surface once and settles the restore', async () => {
    const h = await harness();
    expect(h.pulls()).toBe(1);

    // Same length so the size check passes and the HASH is what rejects it.
    const chunks = buildSyncChunks({
      snapshotId: h.manifest.snapshotId, surface: 'settings', bytes: encodeSurfacePayload({ theme: 'evil' }),
    });
    for (const chunk of chunks) await h.receiver.onFrame(SOURCE, chunk);

    // The defect did NOT cause another pull, which is the whole finding.
    expect(h.pulls()).toBe(1);
    expect(h.result()).toEqual({
      ok: false,
      partial: false,
      applied: [],
      failed: [{ surface: 'settings', defect: 'hash-mismatch' }],
      refused: {},
    });
    expect(h.clock.pendingCount()).toBe(0); // no timer left armed
  });

  test('a changed total does not loop either (the unbounded-loop case)', async () => {
    // A multi-chunk surface, so a SECOND total is still inside the frame's
    // own bounds check and `total-changed` is genuinely what rejects it.
    const big = encodeSurfacePayload({ blob: 'x'.repeat(200_000) });
    const { manifest } = await buildSnapshotOffer({
      surfaces: { sessions: { bytes: big, version: 1 } }, now: 1_700_000_000_000,
    });
    const sent: any[] = [];
    const clock = manualClock();
    let settled: any = null;
    const receiver = createSyncReceiver({
      coordinator: selfCoordinator,
      sourceDeviceDid: SOURCE,
      send: (_to: string, frame: any) => { sent.push(frame); },
      applySurface: async () => {},
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    } as any);
    void receiver.restore().then((r: any) => { settled = r; });
    await receiver.onFrame(SOURCE, buildSyncOffer(manifest));

    const chunks = buildSyncChunks({ snapshotId: manifest.snapshotId, surface: 'sessions', bytes: big });
    await receiver.onFrame(SOURCE, chunks[0]);
    await receiver.onFrame(SOURCE, { ...chunks[1], total: chunks.length - 1 });
    await tick();

    expect(sent.filter((f) => f.t === 'SYNC_PULL').length).toBe(1);
    expect(settled.ok).toBe(false);
    expect(settled.failed).toEqual([{ surface: 'sessions', defect: 'total-changed' }]);
  });

  test('every defect the collector can raise has a disposition, and unknown ones fail closed', () => {
    // The collector's own defect strings, read off its implementation, must
    // all be classified: an unclassified defect silently defaulting to
    // "terminal" is right, but an unnoticed one is how a loop comes back.
    for (const defect of Object.keys(SYNC_DEFECT_DISPOSITIONS)) {
      expect(['ignore', 'retry', 'terminal']).toContain(syncDefectDisposition(defect));
    }
    expect(syncDefectDisposition('something-new-from-the-future')).toBe('terminal');
    expect(syncDefectDisposition('already-settled')).toBe('ignore');
    expect(syncDefectDisposition('hash-mismatch')).toBe('terminal');
  });
});

describe('interruption is the only retryable shape, and it is bounded', () => {
  test('silence re-pulls with exponential backoff, then gives up', async () => {
    const h = await harness({ maxRetries: 3, stallTimeoutMs: 30_000, retryBackoffMs: 500 });
    expect(h.pulls()).toBe(1);

    // Nothing ever arrives. Each stall costs one timeout plus its backoff.
    await h.clock.advance(30_000); // stall 1 → schedule retry at +500ms
    await h.clock.advance(500);
    expect(h.pulls()).toBe(2);
    await h.clock.advance(30_000); // stall 2 → +1000ms
    await h.clock.advance(1_000);
    expect(h.pulls()).toBe(3);
    await h.clock.advance(30_000); // stall 3 → +2000ms
    await h.clock.advance(2_000);
    expect(h.pulls()).toBe(4);

    // Budget spent: the fourth stall is terminal, not a fifth pull.
    expect(h.result()).toBeNull();
    await h.clock.advance(30_000);
    expect(h.pulls()).toBe(4);
    expect(h.result()).toEqual({
      ok: false,
      partial: false,
      applied: [],
      failed: [{ surface: 'settings', defect: 'stalled/retries-exhausted' }],
      refused: {},
    });
    expect(h.clock.pendingCount()).toBe(0);
  });

  test('progress re-arms the clock: a slow surface is never called stalled', async () => {
    const big = encodeSurfacePayload({ blob: 'x'.repeat(200_000) });
    const { manifest } = await buildSnapshotOffer({
      surfaces: { sessions: { bytes: big, version: 1 } }, now: 1_700_000_000_000,
    });
    const sent: any[] = [];
    const clock = manualClock();
    let settled: any = null;
    const receiver = createSyncReceiver({
      coordinator: selfCoordinator,
      sourceDeviceDid: SOURCE,
      send: (_to: string, frame: any) => { sent.push(frame); },
      applySurface: async () => {},
      stallTimeoutMs: 30_000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    } as any);
    void receiver.restore().then((r: any) => { settled = r; });
    await receiver.onFrame(SOURCE, buildSyncOffer(manifest));

    const chunks = buildSyncChunks({ snapshotId: manifest.snapshotId, surface: 'sessions', bytes: big });
    expect(chunks.length).toBeGreaterThan(3); // multi-chunk, so progress is real
    for (const chunk of chunks) {
      await clock.advance(29_000); // just under the stall bound, every time
      await receiver.onFrame(SOURCE, chunk);
    }
    expect(sent.filter((f) => f.t === 'SYNC_PULL').length).toBe(1); // never re-pulled
    expect(settled).toEqual({
      ok: true, partial: false, applied: ['sessions'], failed: [], refused: {},
    });
  });
});

describe('the restore always settles', () => {
  test('a refusal is honest but incomplete, and the restore still settles', async () => {
    const h = await harness();
    await h.receiver.onFrame(SOURCE, buildSyncRefuse({
      snapshotId: h.manifest.snapshotId, surface: 'settings', reason: 'unavailable',
    }));
    expect(h.result()).toEqual({
      ok: false,
      partial: false,
      applied: [],
      failed: [],
      refused: { settings: 'unavailable' },
    });
    expect(h.clock.pendingCount()).toBe(0);
  });

  test('an applier that throws fails the surface instead of hanging forever', async () => {
    const h = await harness({
      applySurface: async () => { throw new TypeError('quota exceeded'); },
    });
    for (const chunk of buildSyncChunks({
      snapshotId: h.manifest.snapshotId, surface: 'settings', bytes: h.bytes,
    })) await h.receiver.onFrame(SOURCE, chunk);

    expect(h.result().ok).toBe(false);
    expect(h.result().failed).toEqual([{ surface: 'settings', defect: 'apply-failed/TypeError' }]);
    expect(h.pulls()).toBe(1); // verified bytes that won't store are not re-pulled
  });

  test('cancel() settles a restore in flight and disarms every timer', async () => {
    const h = await harness();
    expect(h.clock.pendingCount()).toBe(1); // the stall timer is armed
    h.receiver.cancel();
    await tick();
    expect(h.result()).toEqual({
      ok: false,
      partial: false,
      applied: [],
      failed: [{ surface: 'settings', defect: 'cancelled' }],
      refused: {},
      defect: 'cancelled',
    });
    expect(h.clock.pendingCount()).toBe(0);
  });

  test('cancel waits for an in-flight durable apply and reports what landed', async () => {
    let releaseApply = () => {};
    const applyGate = new Promise<void>((resolve) => { releaseApply = resolve; });
    const h = await harness({ applySurface: async () => { await applyGate; } });
    const chunks = buildSyncChunks({
      snapshotId: h.manifest.snapshotId, surface: 'settings', bytes: h.bytes,
    });
    const applying = h.receiver.onFrame(SOURCE, chunks[0]);
    await tick();
    h.receiver.cancel();
    await tick();
    expect(h.result()).toBeNull();
    releaseApply();
    await applying;
    await tick();
    expect(h.result()).toEqual({
      ok: false,
      partial: true,
      applied: ['settings'],
      failed: [],
      refused: {},
      defect: 'cancelled',
    });
  });

  test('a second offer cannot re-open surfaces that already settled', async () => {
    const h = await harness();
    for (const chunk of buildSyncChunks({
      snapshotId: h.manifest.snapshotId, surface: 'settings', bytes: h.bytes,
    })) await h.receiver.onFrame(SOURCE, chunk);
    expect(h.result()).toEqual({
      ok: true, partial: false, applied: ['settings'], failed: [], refused: {},
    });

    // A source that re-offers (a different snapshot, more surfaces) after the
    // restore settled gets nothing: no new pulls, no reopened completion.
    const second = await oneSurfaceSnapshot();
    await h.receiver.onFrame(SOURCE, buildSyncOffer(second.manifest));
    expect(h.pulls()).toBe(1);
  });

  test('frames from a peer that is not the authenticated source are ignored', async () => {
    const h = await harness();
    await h.receiver.onFrame('did:key:zStranger', buildSyncRefuse({
      snapshotId: h.manifest.snapshotId, surface: 'settings', reason: 'unavailable',
    }));
    for (const chunk of buildSyncChunks({
      snapshotId: h.manifest.snapshotId, surface: 'settings', bytes: h.bytes,
    })) await h.receiver.onFrame('did:key:zStranger', chunk);
    expect(h.result()).toBeNull(); // still waiting on the real source
    expect(h.applied).toEqual([]);
    h.receiver.cancel();
  });
});
