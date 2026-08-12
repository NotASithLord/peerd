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
  buildSyncOffer, buildSyncPull, iterateSyncChunks, buildSyncRefuse,
  validateSyncPull, validateSnapshotManifest, createSurfaceCollector,
  surfaceHash, syncDefectDisposition, SYNC_PROTO,
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
 * @param {Map<string, Uint8Array>} [deps.payloads] immutable bytes captured by
 *        buildSnapshotOffer alongside this manifest. Entries are cloned here,
 *        so later caller mutation cannot change the offered snapshot.
 * @param {(surface: string) => Promise<Uint8Array | null>} [deps.readSurfaceBytes]
 *        live-host fallback. Each surface is read once, cloned, and checked
 *        against the manifest before it can be served.
 * @param {import('./sync.js').SnapshotManifest} deps.manifest
 * @param {(event: string, detail?: any) => void} [deps.onEvent]
 */
export const createSyncSource = ({
  coordinator, send, payloads, readSurfaceBytes, manifest, onEvent = () => {},
}) => {
  /** @type {Map<string, Promise<Uint8Array | null>>} */
  const captured = new Map();
  /** One serve per authenticated peer/surface. Duplicate pulls coalesce. */
  const inFlightPulls = new Map();
  /** Bound sequential replay as well as concurrent amplification. */
  const pullCounts = new Map();
  if (payloads) {
    for (const [surface, bytes] of payloads) {
      captured.set(surface, Promise.resolve(
        bytes instanceof Uint8Array ? new Uint8Array(bytes) : null,
      ));
    }
  }

  /**
   * Payload maps are immutable test/source captures. The live SW snapshot is
   * itself immutable, so re-read it for retries instead of retaining another
   * full decoded clone in the network-facing renderer.
   */
  /** @param {string} surface */
  const snapshotBytes = (surface) => {
    if (captured.has(surface)) return /** @type {Promise<Uint8Array | null>} */ (captured.get(surface));
    return (async () => {
      if (typeof readSurfaceBytes !== 'function') return null;
      try {
        const bytes = await readSurfaceBytes(surface);
        return bytes instanceof Uint8Array ? new Uint8Array(bytes) : null;
      } catch (error) {
        onEvent('surface_read_failed', { surface, error });
        return null;
      }
    })();
  };

  const offer = () => buildSyncOffer(manifest);

  /** @param {string} from @param {any} frame */
  const servePull = async (from, frame) => {
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
    const bytes = await snapshotBytes(frame.surface);
    if (!bytes) {
      await send(from, buildSyncRefuse({ snapshotId: manifest.snapshotId, surface: frame.surface, reason: 'unavailable' }));
      return;
    }
    const entry = manifest.surfaces.find((surface) => surface.name === frame.surface);
    if (!entry || bytes.length !== entry.bytes || await surfaceHash(bytes) !== entry.hash) {
      await send(from, buildSyncRefuse({
        snapshotId: manifest.snapshotId, surface: frame.surface, reason: 'snapshot-changed',
      }));
      return;
    }
    onEvent('serving_surface', { from, surface: frame.surface, bytes: bytes.length });
    // Generate one bounded frame at a time. A 64 MiB surface must not also
    // allocate a second base64-expanded array merely to begin sending it.
    for (const chunk of iterateSyncChunks({ snapshotId: manifest.snapshotId, surface: frame.surface, bytes })) {
      await send(from, chunk);
    }
  };

  /** @param {string} from @param {any} frame */
  const onFrame = async (from, frame) => {
    if (!coordinator.isSelfDevice(from)) return servePull(from, frame);
    if (!frame || frame.t !== 'SYNC_PULL') return;
    if (validateSyncPull(frame, { manifest })) return servePull(from, frame);
    const key = `${from}\u0000${String(frame.snapshotId)}\u0000${String(frame.surface)}`;
    const active = inFlightPulls.get(key);
    if (active) {
      onEvent('surface_pull_coalesced', { from, surface: frame.surface });
      return active;
    }
    const served = pullCounts.get(key) ?? 0;
    if (served >= 4) {
      onEvent('surface_pull_rate_limited', { from, surface: frame.surface });
      await send(from, buildSyncRefuse({
        snapshotId: manifest.snapshotId, surface: frame.surface, reason: 'pull-limit',
      }));
      return;
    }
    pullCounts.set(key, served + 1);
    const serving = servePull(from, frame).finally(() => {
      if (inFlightPulls.get(key) === serving) inFlightPulls.delete(key);
    });
    inFlightPulls.set(key, serving);
    return serving;
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
 * @param {number} [deps.retryDelayMs] backwards-compatible alias for retryBackoffMs
 * @param {number} [deps.timeoutMs] total restore bound; zero disables it
 * @param {(fn: () => void, ms: number) => any} [deps.setTimer]   injected clock
 * @param {(handle: any) => void} [deps.clearTimer]
 */
export const createSyncReceiver = ({
  coordinator, sourceDeviceDid, send, applySurface, chooseSurfaces = (all) => all, onEvent = () => {},
  maxRetries = DEFAULT_MAX_SURFACE_RETRIES,
  stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
  retryBackoffMs,
  retryDelayMs,
  timeoutMs = 60_000,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
}) => {
  const backoffMs = retryBackoffMs ?? retryDelayMs ?? DEFAULT_RETRY_BACKOFF_MS;
  /** @type {import('./sync.js').SnapshotManifest | null} */
  let manifest = null;
  /** @type {Map<string, ReturnType<typeof createSurfaceCollector>>} */
  const collectors = new Map();
  /** @type {Set<string>} */
  const applied = new Set();
  /** @type {Set<string>} */
  const requested = new Set();
  /** @type {Map<string, string>} */
  const refused = new Map();
  /** @type {Set<string>} */
  const wanted = new Set();
  /** @type {Array<{ surface: string, defect: string }>} */
  const failed = [];
  /** @type {Map<string, number>} how many re-pulls a surface has already had */
  const attempts = new Map();
  /** @type {Map<string, any>} live stall/backoff timers, one per surface */
  const timers = new Map();
  /** @type {{ resolve: (r: any) => void } | null} */
  let completion = null;
  /** @type {Promise<any> | null} */
  let completionPromise = null;
  /** @type {any | null} */
  let completedResult = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let totalTimer = null;
  /** @type {Set<Promise<void>>} */
  const inFlightApplies = new Set();
  /** @type {Set<string>} */
  const applyingSurfaces = new Set();
  /** @type {Map<string, any>} item-level durable effects from a failed surface */
  const partialEffects = new Map();
  /** @type {{ defect: string } | null} */
  let deferredFinish = null;

  /** @param {string} [defect] */
  const resultFor = (defect) => ({
    ok: !defect
      && requested.size > 0
      && applied.size === requested.size
      && failed.length === 0
      && refused.size === 0,
    partial: (applied.size > 0 || partialEffects.size > 0)
      && (Boolean(defect) || applied.size !== requested.size || failed.length > 0 || refused.size > 0),
    applied: [...applied],
    failed: [...failed],
    ...(partialEffects.size > 0 ? { partialEffects: Object.fromEntries(partialEffects) } : {}),
    refused: Object.fromEntries(refused),
    ...(defect ? { defect } : {}),
  });

  /** @param {any} result */
  const finish = (result) => {
    if (completedResult) return;
    completedResult = result;
    if (totalTimer) { clearTimeout(totalTimer); totalTimer = null; }
    for (const surface of [...timers.keys()]) clearSurfaceTimer(surface);
    collectors.clear();
    if (!completion) return;
    const done = completion;
    completion = null;
    done.resolve(result);
  };

  /** @param {string} defect */
  const finishWhenAppliesSettle = (defect) => {
    if (inFlightApplies.size === 0) { finish(resultFor(defect)); return; }
    deferredFinish ??= { defect };
  };

  /** @param {string} surface */
  const clearSurfaceTimer = (surface) => {
    const handle = timers.get(surface);
    if (handle !== undefined) { clearTimer(handle); timers.delete(surface); }
  };

  const maybeComplete = () => {
    if (manifest && wanted.size === 0) {
      const result = resultFor();
      onEvent(result.ok ? 'restore_complete' : 'restore_incomplete', result);
      finish(result);
    }
  };

  /**
   * A surface is done, unsuccessfully. Drop it from `wanted` so the rest of
   * the restore can still settle: a torn transfer leaves whole surfaces
   * present or absent, and the caller is told exactly which.
   *
   * @param {string} surface
  * @param {string} defect
  * @param {any} [partial]
  */
  const failSurface = (surface, defect, partial) => {
    if (!wanted.has(surface) || completedResult) return;
    clearSurfaceTimer(surface);
    collectors.delete(surface);
    wanted.delete(surface);
    if (partial && typeof partial === 'object') partialEffects.set(surface, partial);
    failed.push({ surface, defect, ...(partial ? { partial } : {}) });
    onEvent('surface_failed', { surface, defect, ...(partial ? { partial } : {}) });
    maybeComplete();
  };

  /** @param {string} surface */
  const armStall = (surface) => {
    clearSurfaceTimer(surface);
    if (!(stallTimeoutMs > 0)) return;
    timers.set(surface, setTimer(() => {
      if (completedResult || !collectors.has(surface)) return;
      timers.delete(surface);
      collectors.delete(surface);
      void retryAfterInterruption(surface, 'stalled/retries-exhausted');
    }, stallTimeoutMs));
  };

  /**
   * The ONLY path that re-pulls. Capped and backed off, and it converts to
   * a terminal failure once the budget is spent.
   *
   * @param {string} surface
   * @param {string} exhaustedDefect
   */
  const retryAfterInterruption = async (surface, exhaustedDefect) => {
    if (completedResult || !wanted.has(surface)) return;
    const spent = (attempts.get(surface) ?? 0) + 1;
    if (spent > maxRetries) { failSurface(surface, exhaustedDefect); return; }
    attempts.set(surface, spent);
    onEvent('surface_retry', { surface, attempt: spent, of: maxRetries });
    // Exponential: 1×, 2×, 4× the base delay.
    const delay = backoffMs * (2 ** (spent - 1));
    timers.set(surface, setTimer(() => {
      timers.delete(surface);
      if (!completedResult && wanted.has(surface)) void pull(surface);
    }, delay));
  };

  /** @param {string} surface */
  const pull = async (surface) => {
    if (completedResult || !manifest || !wanted.has(surface)) return;
    const entry = manifest.surfaces.find((row) => row.name === surface);
    if (!entry) { failSurface(surface, 'not-in-manifest'); return; }
    collectors.set(surface, createSurfaceCollector({ entry, snapshotId: manifest.snapshotId }));
    armStall(surface);
    try {
      await send(sourceDeviceDid, buildSyncPull({ snapshotId: manifest.snapshotId, surface }));
    } catch (error) {
      if (completedResult || !wanted.has(surface)) return;
      clearSurfaceTimer(surface);
      collectors.delete(surface);
      onEvent('surface_pull_failed', { surface, error });
      await retryAfterInterruption(surface, 'send-failed/retries-exhausted');
    }
  };

  /** @param {string} from @param {any} frame */
  const onFrame = async (from, frame) => {
    if (completedResult) return;
    if (from !== sourceDeviceDid || !coordinator.isSelfDevice(from)) return; // source must stay self
    if (frame?.t === 'SYNC_OFFER') {
      if (manifest) {
        onEvent(manifest.snapshotId === frame?.manifest?.snapshotId ? 'duplicate_offer' : 'offer_replaced', {
          ignored: frame?.manifest?.snapshotId, held: manifest.snapshotId,
        });
        return;
      }
      const defect = frame.proto === SYNC_PROTO
        ? validateSnapshotManifest(frame.manifest)
        : 'unsupported-proto';
      if (defect) {
        onEvent('bad_offer', { defect });
        finish(resultFor(defect));
        return;
      }
      const accepted = /** @type {import('./sync.js').SnapshotManifest} */ (frame.manifest);
      manifest = accepted;
      const offered = accepted.surfaces.map((entry) => entry.name);
      const unavailable = Object.keys(accepted.unavailable ?? {});
      try {
        const chosen = chooseSurfaces([...offered, ...unavailable]);
        for (const surface of chosen) {
          if (typeof surface !== 'string') continue;
          requested.add(surface);
          if (offered.includes(surface)) wanted.add(surface);
          if (unavailable.includes(surface)) {
            refused.set(surface, accepted.unavailable?.[surface] ?? 'unavailable');
          } else if (!offered.includes(surface)) {
            refused.set(surface, 'missing-from-offer');
          }
        }
      } catch (error) {
        finish(resultFor('surface-choice-failed'));
        onEvent('surface_choice_failed', { error });
        return;
      }
      onEvent('offer_accepted', { wanted: [...wanted], unavailable: Object.fromEntries(refused) });
      if (wanted.size === 0) { maybeComplete(); return; }
      for (const surface of [...wanted]) void pull(surface);
      return;
    }
    if (frame?.t === 'SYNC_REFUSE') {
      if (!manifest || frame.proto !== SYNC_PROTO || frame.snapshotId !== manifest.snapshotId
          || !wanted.has(frame.surface)) return;
      const reason = typeof frame.reason === 'string' && frame.reason
        ? frame.reason.slice(0, 64) : 'refused';
      onEvent('surface_refused', { surface: frame.surface, reason });
      // An honest per-surface "no" from the source (consent withheld,
      // unavailable). Not a failure of the restore: drop it from the wanted
      // set so the surfaces that WILL arrive can still finish.
      clearSurfaceTimer(frame.surface);
      collectors.delete(frame.surface);
      wanted.delete(frame.surface);
      refused.set(frame.surface, reason);
      maybeComplete();
      return;
    }
    if (frame?.t === 'SYNC_CHUNK') {
      const collector = collectors.get(frame.surface);
      if (!collector) return;
      const result = await collector.accept(frame);
      if (completedResult || !wanted.has(frame.surface)) return;
      if (result.state === 'collecting') {
        armStall(frame.surface); // progress: the surface is alive, restart its clock
        return;
      }
      if (result.state === 'complete') {
        clearSurfaceTimer(frame.surface);
        collectors.delete(frame.surface);
        const surface = frame.surface;
        applyingSurfaces.add(surface);
        /** @type {Promise<void>} */
        let applying = Promise.resolve();
        applying = (async () => {
          try {
            await applySurface(surface, result.bytes);
            applied.add(surface);
            wanted.delete(surface);
            onEvent('surface_applied', { surface });
          } catch (error) {
            // The bytes verified; this profile could not store them. Re-pulling
            // the same bytes would fail the same way, so it is terminal.
            const partial = /** @type {{ partialResult?: any, result?: any }} */ (error)?.partialResult
              ?? /** @type {{ partialResult?: any, result?: any }} */ (error)?.result;
            failSurface(surface, `apply-failed/${error instanceof Error ? error.name : 'Error'}`, partial);
          } finally {
            inFlightApplies.delete(applying);
            applyingSurfaces.delete(surface);
            if (deferredFinish && inFlightApplies.size === 0) {
              const { defect } = deferredFinish;
              deferredFinish = null;
              finish(resultFor(defect));
            } else {
              maybeComplete();
            }
          }
        })();
        inFlightApplies.add(applying);
        await applying;
        return;
      }
      const disposition = syncDefectDisposition(result.defect);
      if (disposition === 'ignore') return;
      clearSurfaceTimer(frame.surface);
      collectors.delete(frame.surface);
      if (disposition === 'retry') {
        await retryAfterInterruption(frame.surface, `${result.defect}/retries-exhausted`);
        return;
      }
      failSurface(frame.surface, result.defect);
    }
  };

  /** Kick off: accept the source's offer and drive to completion. */
  const restore = () => {
    if (completedResult) return Promise.resolve(completedResult);
    if (completionPromise) return completionPromise;
    completionPromise = new Promise((resolve) => {
      completion = { resolve };
      totalTimer = timeoutMs > 0 ? setTimeout(() => {
        totalTimer = null;
        for (const surface of [...wanted]) {
          if (applyingSurfaces.has(surface)) continue;
          failed.push({ surface, defect: 'restore-timeout' });
          wanted.delete(surface);
        }
        onEvent('restore_timeout', { applied: [...applied] });
        finishWhenAppliesSettle('restore-timeout');
      }, timeoutMs) : null;
      maybeComplete();
    });
    return completionPromise;
  };

  /**
   * Abandon the restore (user cancelled, link gone). Settles `restore()`
   * with what actually landed and disarms every timer, so no caller is left
   * awaiting a promise nothing will resolve.
   */
  const cancel = () => {
    if (completedResult) return;
    for (const surface of [...wanted]) {
      if (applyingSurfaces.has(surface)) continue;
      failed.push({ surface, defect: 'cancelled' });
      wanted.delete(surface);
    }
    onEvent('restore_cancelled', { applied: [...applied] });
    finishWhenAppliesSettle('cancelled');
  };

  return Object.freeze({ onFrame, restore, cancel, wantedSurfaces: () => [...wanted] });
};
