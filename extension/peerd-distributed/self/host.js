// @ts-check
// peerd-distributed/self/host.js: the state-transfer host that rides the
// authenticated self-device coordinator.
//
// The coordinator (coordinator.js) turns candidates into `self` peers. This
// host is what those self peers actually DO: the SOURCE serves snapshot
// surfaces on request, the RECEIVER pulls and reassembles them. Both refuse
// any peer the coordinator has NOT marked self-device (issue invariant 12:
// state-transfer endpoints refuse non-self peers): the gate is
// `coordinator.isSelfDevice(from)`, checked on every inbound frame.
//
// Direction is by role, not by peer: an install acts as SOURCE (it has
// state and offers it) or RECEIVER (fresh, it pulls). A single link carries
// one direction at a time; the enrollment flow makes the freshly-enrolled
// device the receiver and its online sibling the source.
//
// Transport is the same direct channel the handshake used, injected as
// `send(deviceDid, frame)`. Surface bytes are injected too (collect on the
// source, apply on the receiver), so the whole transfer runs in Bun over
// the in-memory mesh (self-transfer.e2e.test.ts) with real hashing and
// chunking, only the WebRTC layer faked.

import {
  buildSyncOffer, buildSyncPull, buildSyncChunks, buildSyncRefuse,
  validateSyncPull, validateSnapshotManifest, createSurfaceCollector,
  syncDefectDisposition,
} from './sync.js';

// Retry budget for a stalled surface. Deliberately small: a self device on
// the same person's mesh either answers or it doesn't, and the fallback is
// a whole restore the user can simply run again, not a heroic resume.
const DEFAULT_MAX_SURFACE_RETRIES = 3;
// How long a surface may make NO progress before the receiver calls it
// interrupted. Chunk-to-chunk, not transfer-total: the timer re-arms on
// every accepted chunk, so a large surface on a slow link is never the
// thing that trips it.
const DEFAULT_STALL_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_BACKOFF_MS = 500;

/**
 * The SOURCE side: answer pulls for a prepared snapshot, self-peers only.
 *
 * @param {Object} deps
 * @param {{ isSelfDevice: (deviceDid: string) => boolean }} deps.coordinator
 * @param {(deviceDid: string, frame: any) => Promise<any> | any} deps.send
 * @param {(surface: string) => Promise<Uint8Array | null> | Uint8Array | null} deps.readSurfaceBytes
 *        the raw bytes for an offered surface (consent already applied, a
 *        withheld surface simply isn't in the manifest)
 * @param {import('./sync.js').SnapshotManifest} deps.manifest
 * @param {(event: string, detail?: any) => void} [deps.onEvent]
 */
export const createSyncSource = ({ coordinator, send, readSurfaceBytes, manifest, onEvent = () => {} }) => {
  const offer = () => buildSyncOffer(manifest);

  /** @param {string} from @param {any} frame */
  const onFrame = async (from, frame) => {
    if (!coordinator.isSelfDevice(from)) {
      onEvent('refused_non_self', { from });
      return; // silent drop: a non-self peer gets nothing
    }
    if (!frame || frame.t !== 'SYNC_PULL') return;
    const defect = validateSyncPull(frame, { manifest });
    if (defect) {
      await send(from, buildSyncRefuse({ snapshotId: manifest.snapshotId, surface: frame.surface, reason: defect }));
      return;
    }
    const bytes = await readSurfaceBytes(frame.surface);
    if (!bytes) {
      await send(from, buildSyncRefuse({ snapshotId: manifest.snapshotId, surface: frame.surface, reason: 'unavailable' }));
      return;
    }
    onEvent('serving_surface', { from, surface: frame.surface, bytes: bytes.length });
    for (const chunk of buildSyncChunks({ snapshotId: manifest.snapshotId, surface: frame.surface, bytes })) {
      await send(from, chunk);
    }
  };

  return Object.freeze({ offer, onFrame });
};

/**
 * The RECEIVER side: accept an offer, pull each surface, reassemble +
 * verify, hand completed bytes to the applier.
 *
 * Every surface reaches exactly one end state (applied, refused, or
 * failed), so `restore()` always settles. That is a security property, not
 * tidiness: the source here is an authenticated self device, but
 * "authenticated" is not "correct", and a buggy or compromised sibling must
 * not be able to hold a fresh install in an endless pull/serve loop.
 *
 * So the two failure shapes are separated. A DEFECT (bad chunk, changed
 * total, size or hash mismatch) is deterministic: the same snapshot serves
 * the same bytes, so re-pulling it can only reproduce it; those are
 * terminal per `syncDefectDisposition`. An INTERRUPTION is silence, caught
 * by a per-surface stall timer, and only that earns a re-pull: same
 * snapshotId, same bytes, same hash, idempotent, but capped at
 * `maxRetries` with exponential backoff, after which the surface fails too.
 *
 * @param {Object} deps
 * @param {{ isSelfDevice: (deviceDid: string) => boolean }} deps.coordinator
 * @param {string} deps.sourceDeviceDid  the self device we restore FROM
 * @param {(deviceDid: string, frame: any) => Promise<any> | any} deps.send
 * @param {(surface: string, bytes: Uint8Array) => Promise<any>} deps.applySurface
 * @param {(surfaces: string[]) => string[]} [deps.chooseSurfaces]  the user's
 *        approval, which offered surfaces to pull (default: all)
 * @param {(event: string, detail?: any) => void} [deps.onEvent]
 * @param {number} [deps.maxRetries]
 * @param {number} [deps.stallTimeoutMs]
 * @param {number} [deps.retryBackoffMs]
 * @param {(fn: () => void, ms: number) => any} [deps.setTimer]   injected clock
 * @param {(handle: any) => void} [deps.clearTimer]
 */
export const createSyncReceiver = ({
  coordinator, sourceDeviceDid, send, applySurface, chooseSurfaces = (all) => all, onEvent = () => {},
  maxRetries = DEFAULT_MAX_SURFACE_RETRIES,
  stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
  retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
}) => {
  /** @type {import('./sync.js').SnapshotManifest | null} */
  let manifest = null;
  /** @type {Map<string, ReturnType<typeof createSurfaceCollector>>} */
  const collectors = new Map();
  /** @type {Set<string>} */
  const applied = new Set();
  /** @type {Set<string>} */
  const wanted = new Set();
  /** @type {Array<{ surface: string, defect: string }>} */
  const failed = [];
  /** @type {Array<{ surface: string, reason: string }>} */
  const refused = [];
  /** @type {Map<string, number>} how many re-pulls a surface has already had */
  const attempts = new Map();
  /** @type {Map<string, any>} live stall/backoff timers, one per surface */
  const timers = new Map();
  /** @type {{ resolve: (r: any) => void } | null} */
  let completion = null;

  /** @param {string} surface */
  const clearSurfaceTimer = (surface) => {
    const handle = timers.get(surface);
    if (handle !== undefined) { clearTimer(handle); timers.delete(surface); }
  };

  const maybeComplete = () => {
    if (manifest && completion && [...wanted].every((surface) => applied.has(surface))) {
      const done = completion;
      completion = null;
      for (const surface of [...timers.keys()]) clearSurfaceTimer(surface);
      onEvent('restore_complete', { applied: [...applied], failed: [...failed] });
      done.resolve({ ok: failed.length === 0, applied: [...applied], failed: [...failed], refused: [...refused] });
    }
  };

  /**
   * A surface is done, unsuccessfully. Drop it from `wanted` so the rest of
   * the restore can still settle: a torn transfer leaves whole surfaces
   * present or absent, and the caller is told exactly which.
   *
   * @param {string} surface
   * @param {string} defect
   */
  const failSurface = (surface, defect) => {
    clearSurfaceTimer(surface);
    collectors.delete(surface);
    wanted.delete(surface);
    failed.push({ surface, defect });
    onEvent('surface_failed', { surface, defect });
    maybeComplete();
  };

  /** @param {string} surface */
  const armStall = (surface) => {
    clearSurfaceTimer(surface);
    timers.set(surface, setTimer(() => {
      if (!collectors.has(surface)) return; // settled between the arm and the fire
      timers.delete(surface);
      collectors.delete(surface);
      void retryAfterInterruption(surface);
    }, stallTimeoutMs));
  };

  /**
   * The ONLY path that re-pulls. Capped and backed off, and it converts to
   * a terminal failure once the budget is spent.
   *
   * @param {string} surface
   */
  const retryAfterInterruption = async (surface) => {
    const spent = (attempts.get(surface) ?? 0) + 1;
    if (spent > maxRetries) { failSurface(surface, 'stalled/retries-exhausted'); return; }
    attempts.set(surface, spent);
    onEvent('surface_retry', { surface, attempt: spent, of: maxRetries });
    // Exponential: 1×, 2×, 4× the base delay.
    const delay = retryBackoffMs * (2 ** (spent - 1));
    timers.set(surface, setTimer(() => { timers.delete(surface); void pull(surface); }, delay));
  };

  /** @param {string} surface */
  const pull = async (surface) => {
    if (!manifest || !wanted.has(surface)) return; // refused/failed in the meantime
    const entry = manifest.surfaces.find((row) => row.name === surface);
    if (!entry) { failSurface(surface, 'not-in-manifest'); return; }
    collectors.set(surface, createSurfaceCollector({ entry, snapshotId: manifest.snapshotId }));
    armStall(surface);
    await send(sourceDeviceDid, buildSyncPull({ snapshotId: manifest.snapshotId, surface }));
  };

  /** @param {string} from @param {any} frame */
  const onFrame = async (from, frame) => {
    if (from !== sourceDeviceDid || !coordinator.isSelfDevice(from)) return; // source must stay self
    if (frame?.t === 'SYNC_OFFER') {
      if (manifest) return; // one snapshot per receiver: a second offer can't re-open settled surfaces
      if (validateSnapshotManifest(frame.manifest)) { onEvent('bad_offer'); return; }
      const accepted = /** @type {import('./sync.js').SnapshotManifest} */ (frame.manifest);
      manifest = accepted;
      const offered = accepted.surfaces.map((entry) => entry.name);
      for (const surface of chooseSurfaces(offered)) if (offered.includes(surface)) wanted.add(surface);
      onEvent('offer_accepted', { wanted: [...wanted] });
      if (wanted.size === 0) { maybeComplete(); return; }
      for (const surface of [...wanted]) await pull(surface);
      return;
    }
    if (frame?.t === 'SYNC_REFUSE') {
      if (!wanted.has(frame.surface)) return;
      onEvent('surface_refused', { surface: frame.surface, reason: frame.reason });
      // An honest per-surface "no" from the source (consent withheld,
      // unavailable). Not a failure of the restore: drop it from the wanted
      // set so the surfaces that WILL arrive can still finish.
      clearSurfaceTimer(frame.surface);
      collectors.delete(frame.surface);
      wanted.delete(frame.surface);
      refused.push({ surface: frame.surface, reason: String(frame.reason ?? '').slice(0, 64) });
      maybeComplete();
      return;
    }
    if (frame?.t === 'SYNC_CHUNK') {
      const collector = collectors.get(frame.surface);
      if (!collector) return;
      const result = await collector.accept(frame);
      if (result.state === 'collecting') {
        armStall(frame.surface); // progress: the surface is alive, restart its clock
        return;
      }
      if (result.state === 'complete') {
        clearSurfaceTimer(frame.surface);
        collectors.delete(frame.surface);
        try {
          await applySurface(frame.surface, result.bytes);
        } catch (error) {
          // The bytes verified; this profile could not store them. Re-pulling
          // the same bytes would fail the same way, so it is terminal.
          failSurface(frame.surface, `apply-failed/${error instanceof Error ? error.name : 'Error'}`);
          return;
        }
        applied.add(frame.surface);
        onEvent('surface_applied', { surface: frame.surface });
        maybeComplete();
        return;
      }
      const disposition = syncDefectDisposition(result.defect);
      if (disposition === 'ignore') return;
      clearSurfaceTimer(frame.surface);
      collectors.delete(frame.surface);
      if (disposition === 'retry') { await retryAfterInterruption(frame.surface); return; }
      failSurface(frame.surface, result.defect);
    }
  };

  /** Kick off: accept the source's offer and drive to completion. */
  const restore = () => new Promise((resolve) => { completion = { resolve }; });

  /**
   * Abandon the restore (user cancelled, link gone). Settles `restore()`
   * with what actually landed and disarms every timer, so no caller is left
   * awaiting a promise nothing will resolve.
   */
  const cancel = () => {
    for (const surface of [...timers.keys()]) clearSurfaceTimer(surface);
    collectors.clear();
    for (const surface of [...wanted]) if (!applied.has(surface)) failed.push({ surface, defect: 'cancelled' });
    wanted.clear();
    if (completion) {
      const done = completion;
      completion = null;
      onEvent('restore_cancelled', { applied: [...applied] });
      done.resolve({ ok: false, applied: [...applied], failed: [...failed], refused: [...refused] });
    }
  };

  return Object.freeze({ onFrame, restore, cancel, wantedSurfaces: () => [...wanted] });
};
