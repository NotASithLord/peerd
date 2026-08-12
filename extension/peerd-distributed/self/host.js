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
  validateSyncPull, validateSnapshotManifest, createSurfaceCollector, surfaceHash, SYNC_PROTO,
} from './sync.js';

/**
 * The SOURCE side: answer pulls for a prepared snapshot, self-peers only.
 *
 * @param {Object} deps
 * @param {{ isSelfDevice: (deviceDid: string) => boolean }} deps.coordinator
 * @param {(deviceDid: string, frame: any) => Promise<any> | any} deps.send
 * @param {Map<string, Uint8Array>} deps.payloads immutable bytes captured by
 *        buildSnapshotOffer alongside this manifest
 * @param {import('./sync.js').SnapshotManifest} deps.manifest
 * @param {(event: string, detail?: any) => void} [deps.onEvent]
 */
export const createSyncSource = ({ coordinator, send, payloads, manifest, onEvent = () => {} }) => {
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
    const bytes = payloads.get(frame.surface);
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
    for (const chunk of buildSyncChunks({ snapshotId: manifest.snapshotId, surface: frame.surface, bytes })) {
      await send(from, chunk);
    }
  };

  return Object.freeze({ offer, onFrame });
};

/**
 * The RECEIVER side: accept an offer, pull each surface, reassemble +
 * verify, hand completed bytes to the applier. Interruption-safe: a failed
 * surface is re-pulled with a fresh collector; success is reported once.
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
 * @param {number} [deps.retryDelayMs]
 * @param {number} [deps.timeoutMs]
 */
export const createSyncReceiver = ({
  coordinator, sourceDeviceDid, send, applySurface, chooseSurfaces = (all) => all,
  onEvent = () => {}, maxRetries = 3, retryDelayMs = 100, timeoutMs = 60_000,
}) => {
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
  /** @type {Map<string, number>} */
  const attempts = new Map();
  /** @type {Set<string>} */
  const wanted = new Set();
  /** @type {{ resolve: (r: any) => void, timer: ReturnType<typeof setTimeout> | null } | null} */
  let completion = null;
  /** @type {Promise<any> | null} */
  let completionPromise = null;
  /** @type {any | null} */
  let completedResult = null;

  /** @param {any} result */
  const finish = (result) => {
    if (completedResult) return;
    completedResult = result;
    if (!completion) return;
    if (completion.timer) clearTimeout(completion.timer);
    const done = completion;
    completion = null;
    done.resolve(result);
  };

  const maybeComplete = () => {
    if (manifest && completion && wanted.size === 0) {
      const result = {
        ok: requested.size > 0 && refused.size === 0 && applied.size === requested.size,
        partial: applied.size > 0 && refused.size > 0,
        applied: [...applied],
        refused: Object.fromEntries(refused),
      };
      onEvent(result.ok ? 'restore_complete' : 'restore_incomplete', result);
      finish(result);
    }
  };

  /** @param {string} surface */
  const pull = async (surface) => {
    if (completedResult || !wanted.has(surface)) return;
    attempts.set(surface, (attempts.get(surface) ?? 0) + 1);
    collectors.set(surface, createSurfaceCollector({
      entry: /** @type {any} */ (manifest).surfaces.find((/** @type {any} */ e) => e.name === surface),
      snapshotId: /** @type {any} */ (manifest).snapshotId,
    }));
    try {
      await send(sourceDeviceDid, buildSyncPull({
        snapshotId: /** @type {any} */ (manifest).snapshotId, surface,
      }));
    } catch (error) {
      wanted.delete(surface);
      collectors.delete(surface);
      refused.set(surface, 'send-failed');
      onEvent('surface_pull_failed', { surface, error });
      maybeComplete();
    }
  };

  /** @param {string} from @param {any} frame */
  const onFrame = async (from, frame) => {
    if (completedResult) return;
    if (from !== sourceDeviceDid || !coordinator.isSelfDevice(from)) return; // source must stay self
    if (frame?.t === 'SYNC_OFFER') {
      const defect = validateSnapshotManifest(frame.manifest);
      if (defect) {
        onEvent('bad_offer', { defect });
        finish({ ok: false, partial: false, applied: [...applied], refused: {}, defect });
        return;
      }
      const accepted = /** @type {import('./sync.js').SnapshotManifest} */ (frame.manifest);
      if (manifest) {
        onEvent(manifest.snapshotId === accepted.snapshotId ? 'duplicate_offer' : 'offer_replaced', {
          ignored: accepted.snapshotId, held: manifest.snapshotId,
        });
        return;
      }
      manifest = accepted;
      const offered = accepted.surfaces.map((entry) => entry.name);
      let chosen;
      try { chosen = chooseSurfaces(offered); }
      catch (error) {
        finish({ ok: false, partial: false, applied: [], refused: {}, defect: 'surface-choice-failed' });
        onEvent('surface_choice_failed', { error });
        return;
      }
      for (const surface of chosen) {
        if (offered.includes(surface)) { wanted.add(surface); requested.add(surface); }
      }
      onEvent('offer_accepted', { wanted: [...wanted] });
      if (wanted.size === 0) { maybeComplete(); return; }
      for (const surface of wanted) await pull(surface);
      return;
    }
    if (frame?.t === 'SYNC_REFUSE') {
      if (!manifest || frame.proto !== SYNC_PROTO || frame.snapshotId !== manifest.snapshotId
          || !wanted.has(frame.surface)) return;
      onEvent('surface_refused', { surface: frame.surface, reason: frame.reason });
      // A refused surface can't complete; drop it from the wanted set so the
      // restore can still finish on the surfaces that will arrive.
      wanted.delete(frame.surface);
      refused.set(frame.surface, String(frame.reason ?? 'refused').slice(0, 64));
      collectors.delete(frame.surface);
      maybeComplete();
      return;
    }
    if (frame?.t === 'SYNC_CHUNK') {
      const collector = collectors.get(frame.surface);
      if (!collector) return;
      const result = await collector.accept(frame);
      if (result.state === 'complete') {
        collectors.delete(frame.surface);
        try {
          await applySurface(frame.surface, result.bytes);
          applied.add(frame.surface);
          wanted.delete(frame.surface);
          onEvent('surface_applied', { surface: frame.surface });
        } catch (error) {
          wanted.delete(frame.surface);
          refused.set(frame.surface, 'apply-failed');
          onEvent('surface_apply_failed', { surface: frame.surface, error });
        }
        maybeComplete();
      } else if (result.state === 'failed') {
        onEvent('surface_failed', { surface: frame.surface, defect: result.defect });
        collectors.delete(frame.surface);
        if ((attempts.get(frame.surface) ?? 0) >= maxRetries) {
          wanted.delete(frame.surface);
          refused.set(frame.surface, result.defect);
          maybeComplete();
        } else {
          // Interruption recovery: re-pull the same immutable surface.
          const delay = Math.min(2_000, retryDelayMs * (2 ** ((attempts.get(frame.surface) ?? 1) - 1)));
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          await pull(frame.surface);
        }
      }
    }
  };

  /** Kick off: accept the source's offer and drive to completion. */
  const restore = () => {
    if (completedResult) return Promise.resolve(completedResult);
    if (completionPromise) return completionPromise;
    completionPromise = new Promise((resolve) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        for (const surface of wanted) refused.set(surface, 'restore-timeout');
        wanted.clear();
        finish({
          ok: false, partial: applied.size > 0, applied: [...applied],
          refused: Object.fromEntries(refused), defect: 'restore-timeout',
        });
      }, timeoutMs) : null;
      completion = { resolve, timer };
      maybeComplete();
    });
    return completionPromise;
  };

  const cancel = () => {
    const cancelled = new Map(refused);
    for (const surface of wanted) cancelled.set(surface, 'cancelled');
    wanted.clear();
    finish({
      ok: false, partial: applied.size > 0, applied: [...applied],
      refused: Object.fromEntries(cancelled), defect: 'cancelled',
    });
  };

  return Object.freeze({ onFrame, restore, cancel, wantedSurfaces: () => [...wanted] });
};
