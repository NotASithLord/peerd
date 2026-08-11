// @ts-check
// peerd-distributed/self/host.js — the state-transfer host that rides the
// authenticated self-device coordinator.
//
// The coordinator (coordinator.js) turns candidates into `self` peers. This
// host is what those self peers actually DO: the SOURCE serves snapshot
// surfaces on request, the RECEIVER pulls and reassembles them. Both refuse
// any peer the coordinator has NOT marked self-device (issue invariant 12:
// state-transfer endpoints refuse non-self peers) — the gate is
// `coordinator.isSelfDevice(from)`, checked on every inbound frame.
//
// Direction is by role, not by peer: an install acts as SOURCE (it has
// state and offers it) or RECEIVER (fresh, it pulls). A single link carries
// one direction at a time; the enrollment flow makes the freshly-enrolled
// device the receiver and its online sibling the source.
//
// Transport is the same direct channel the handshake used, injected as
// `send(deviceDid, frame)`. Surface bytes are injected too (collect on the
// source, apply on the receiver) — so the whole transfer runs in Bun over
// the in-memory mesh (self-transfer.e2e.test.ts) with real hashing and
// chunking, only the WebRTC layer faked.

import {
  buildSyncOffer, buildSyncPull, buildSyncChunks, buildSyncRefuse,
  validateSyncPull, validateSnapshotManifest, createSurfaceCollector,
} from './sync.js';

/**
 * The SOURCE side: answer pulls for a prepared snapshot, self-peers only.
 *
 * @param {Object} deps
 * @param {{ isSelfDevice: (deviceDid: string) => boolean }} deps.coordinator
 * @param {(deviceDid: string, frame: any) => Promise<any> | any} deps.send
 * @param {(surface: string) => Promise<Uint8Array | null> | Uint8Array | null} deps.readSurfaceBytes
 *        the raw bytes for an offered surface (consent already applied — a
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
      return; // silent drop — a non-self peer gets nothing
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
 * verify, hand completed bytes to the applier. Interruption-safe: a failed
 * surface is re-pulled with a fresh collector; success is reported once.
 *
 * @param {Object} deps
 * @param {{ isSelfDevice: (deviceDid: string) => boolean }} deps.coordinator
 * @param {string} deps.sourceDeviceDid  the self device we restore FROM
 * @param {(deviceDid: string, frame: any) => Promise<any> | any} deps.send
 * @param {(surface: string, bytes: Uint8Array) => Promise<any>} deps.applySurface
 * @param {(surfaces: string[]) => string[]} [deps.chooseSurfaces]  the user's
 *        approval — which offered surfaces to pull (default: all)
 * @param {(event: string, detail?: any) => void} [deps.onEvent]
 */
export const createSyncReceiver = ({
  coordinator, sourceDeviceDid, send, applySurface, chooseSurfaces = (all) => all, onEvent = () => {},
}) => {
  /** @type {import('./sync.js').SnapshotManifest | null} */
  let manifest = null;
  /** @type {Map<string, ReturnType<typeof createSurfaceCollector>>} */
  const collectors = new Map();
  /** @type {Set<string>} */
  const applied = new Set();
  /** @type {Set<string>} */
  const wanted = new Set();
  /** @type {{ resolve: (r: any) => void } | null} */
  let completion = null;

  const maybeComplete = () => {
    if (manifest && completion && [...wanted].every((surface) => applied.has(surface))) {
      const done = completion;
      completion = null;
      onEvent('restore_complete', { applied: [...applied] });
      done.resolve({ ok: true, applied: [...applied] });
    }
  };

  /** @param {string} surface */
  const pull = async (surface) => {
    collectors.set(surface, createSurfaceCollector({
      entry: /** @type {any} */ (manifest).surfaces.find((/** @type {any} */ e) => e.name === surface),
      snapshotId: /** @type {any} */ (manifest).snapshotId,
    }));
    await send(sourceDeviceDid, buildSyncPull({ snapshotId: /** @type {any} */ (manifest).snapshotId, surface }));
  };

  /** @param {string} from @param {any} frame */
  const onFrame = async (from, frame) => {
    if (from !== sourceDeviceDid || !coordinator.isSelfDevice(from)) return; // source must stay self
    if (frame?.t === 'SYNC_OFFER') {
      if (validateSnapshotManifest(frame.manifest)) { onEvent('bad_offer'); return; }
      const accepted = /** @type {import('./sync.js').SnapshotManifest} */ (frame.manifest);
      manifest = accepted;
      const offered = accepted.surfaces.map((entry) => entry.name);
      for (const surface of chooseSurfaces(offered)) if (offered.includes(surface)) wanted.add(surface);
      onEvent('offer_accepted', { wanted: [...wanted] });
      if (wanted.size === 0) { maybeComplete(); return; }
      for (const surface of wanted) await pull(surface);
      return;
    }
    if (frame?.t === 'SYNC_REFUSE') {
      onEvent('surface_refused', { surface: frame.surface, reason: frame.reason });
      // A refused surface can't complete; drop it from the wanted set so the
      // restore can still finish on the surfaces that will arrive.
      wanted.delete(frame.surface);
      maybeComplete();
      return;
    }
    if (frame?.t === 'SYNC_CHUNK') {
      const collector = collectors.get(frame.surface);
      if (!collector) return;
      const result = await collector.accept(frame);
      if (result.state === 'complete') {
        collectors.delete(frame.surface);
        await applySurface(frame.surface, result.bytes);
        applied.add(frame.surface);
        onEvent('surface_applied', { surface: frame.surface });
        maybeComplete();
      } else if (result.state === 'failed') {
        onEvent('surface_failed', { surface: frame.surface, defect: result.defect });
        collectors.delete(frame.surface);
        // Interruption recovery: re-pull the same surface (same snapshot,
        // same bytes, same hash — idempotent).
        await pull(frame.surface);
      }
    }
  };

  /** Kick off: accept the source's offer and drive to completion. */
  const restore = () => new Promise((resolve) => { completion = { resolve }; });

  return Object.freeze({ onFrame, restore, wantedSurfaces: () => [...wanted] });
};
