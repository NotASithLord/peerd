// @ts-check
// offscreen/dweb-self.js: the PRODUCTION host for same-user device discovery
// and P2P state sync. This is where the self-device stack stops being a set
// of pure modules and starts running.
//
// It lives in the offscreen document because that is where the mesh lives:
// the coordinator joins rotating rendezvous rooms on the SAME base network
// every dwapp rides (dweb-base.js owns the network handle; this module is
// handed it). Nothing here holds the person root: the coordinator signs
// with the DEVICE key, and even that arrives as vault-backed material over
// the sender-verified custody port, never as a key the SW hands out.
//
// Three responsibilities, in the order they happen:
//   start      load custody inputs; if this install is not yet a member of
//              a person's device set, stay INERT (no rooms joined, nothing
//              advertised). Otherwise run the coordinator.
//   serve      as the SOURCE: answer a proven self device's pulls with
//              surface bytes the SERVICE WORKER shaped. This document has
//              no store access, which is the point: it moves bytes it
//              cannot interpret and could not have fabricated.
//   restore    as the RECEIVER: pull the offered surfaces from one chosen
//              self device and hand each verified payload back to the SW to
//              apply. The SW decides what a surface means; this side only
//              proves it arrived intact.
//
// Every frame is gated on `coordinator.isSelfDevice(from)` twice over (once
// in the coordinator's own dispatch, once inside the host), so a peer that
// merely guessed a rendezvous topic reaches nothing.

import browser from '/shared/browser-api.js';
import { loadDweb } from '/shared/dweb-loader.js';
import { publishFailureError } from '/shared/publish-transaction.js';

const log = (/** @type {any[]} */ ...a) => console.log('[offscreen/dweb-self]', ...a);
const warn = (/** @type {any[]} */ ...a) => console.warn('[offscreen/dweb-self]', ...a);

// The coordinator's rendezvous topics rotate on an epoch; re-running start()
// joins the new window and leaves the old. Sweeping also expires handshakes
// that stalled because a peer vanished mid-dance.
const REFRESH_MS = 60_000;
const DEFAULT_RESTORE_SURFACES = Object.freeze(['sessions', 'memory', 'settings', 'apps']);

/**
 * @param {Object} deps
 * @param {{ getSecret: (name: string) => Promise<string | null>,
 *   setSecret: (name: string, value: string) => Promise<void> }} deps.secretIo
 *   the vault surface, proxied over the custody port
 * @param {(type: string, payload?: object) => Promise<any>} deps.swCall
 * @param {() => string | null} deps.getSignalingUrl  current rendezvous URL
 */
export const createSelfDeviceHost = ({ secretIo, swCall, getSignalingUrl }) => {
  /** @type {any} */
  let client = null;
  /** @type {any} */
  let coordinator = null;
  /** @type {Map<string, any>} */
  const sources = new Map();
  /** @type {Map<string, string>} target device -> newest offered snapshot */
  const sourceByTarget = new Map();
  /** @type {Map<string, any>} latest validated-by-receiver offer per self device */
  const pendingOffers = new Map();
  /** @type {Map<string, Promise<any>>} */
  const offerRequests = new Map();
  /** @type {Map<string, number>} */
  const lastOfferRequestAt = new Map();
  /** @type {any} */
  let receiver = null;
  /** @type {Promise<any> | null} */
  let activeRestore = null;
  /** @type {string | null} */
  let receiverDeviceDid = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let refreshTimer = null;
  /** @type {{ personDid: string, deviceDid: string } | null} */
  let identity = null;
  /** @type {string | null} */
  let inertReason = null;
  /** @type {Promise<any> | null} */
  let startPromise = null;
  /** @type {Promise<any> | null} */
  let refreshPromise = null;
  let generation = 0;
  let stopping = false;
  let suspended = false;

  /** Surface bytes are base64 across the SW boundary; frames are JSON. */
  const b64ToBytes = (/** @type {string} */ b64) => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const bytesToB64 = (/** @type {Uint8Array} */ bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  };

  const emit = (/** @type {string} */ event, /** @type {any} */ detail) => {
    browser.runtime.sendMessage({ type: 'dweb/self-event', event, detail }).catch(() => {});
  };

  /**
   * Join the person's rendezvous window and start authenticating whoever
   * appears. Idempotent: safe to call on every base-network start.
   */
  const start = () => {
    if (coordinator) return Promise.resolve({ running: true, ...identity });
    if (suspended || stopping) {
      inertReason = suspended ? 'suspended' : 'stopping';
      return Promise.resolve({ running: false, reason: inertReason });
    }
    if (startPromise) return startPromise;
    const startGeneration = generation;
    const attempt = (async () => {
      // why any: the live dweb module's surface exceeds the stub interface.
      const nextClient = /** @type {any} */ (await loadDweb());
      if (!nextClient.available || !nextClient.createSelfDeviceCoordinator
          || !nextClient.createSelfDeviceMesh || !nextClient.loadCoordinatorInputs) {
        inertReason = 'dweb-unavailable';
        return { running: false, reason: inertReason };
      }
      // A rootless enrolled device intentionally cannot start the public base
      // network yet, so it must not depend on a base handle merely to reach its
      // private device-key rendezvous. Reuse the base URL when present; otherwise
      // use the live client's canonical signaling endpoint directly.
      const signalingUrl = getSignalingUrl() ?? nextClient.defaultSignaling?.[0] ?? null;
      if (!signalingUrl) {
        inertReason = 'rendezvous-offline';
        return { running: false, reason: inertReason };
      }
      const inputs = await nextClient.loadCoordinatorInputs(secretIo);
      if (!inputs) {
        inertReason = 'not-enrolled';
        return { running: false, reason: inertReason };
      }
      const nextIdentity = { personDid: inputs.personDid, deviceDid: inputs.deviceIdentity.did };
      // Never reuse the base mesh here. It authenticates the permanent person
      // DID, which makes two devices of the same person indistinguishable and
      // cannot bind a certificate to the link key. The private rendezvous
      // rooms are separate links authenticated by this install's device key.
      const nextMesh = nextClient.createSelfDeviceMesh({
        deviceIdentity: inputs.deviceIdentity,
        url: signalingUrl,
      });
      const nextCoordinator = nextClient.createSelfDeviceCoordinator({
        personDid: inputs.personDid,
        deviceIdentity: inputs.deviceIdentity,
        deviceCert: inputs.deviceCert,
        roster: inputs.roster,
        discoverySecret: inputs.discoverySecret,
        mesh: nextMesh,
        persistRoster: async (/** @type {any} */ nextRoster) => {
          await secretIo.setSecret('distributed/self-records/v1', JSON.stringify({
            v: 1, certificate: inputs.deviceCert, roster: nextRoster,
          }));
        },
        onEvent: (/** @type {string} */ event, /** @type {any} */ detail) => {
          log(event, detail?.deviceDid ? `…${String(detail.deviceDid).slice(-8)}` : '');
          emit(event, detail);
        },
      });
      nextCoordinator.onAppFrame((/** @type {string} */ from, /** @type {any} */ frame) => {
        void routeFrame(from, frame);
      });
      try { await nextCoordinator.start(); }
      catch (error) { nextCoordinator.stop(); throw error; }
      if (stopping || suspended || generation !== startGeneration) {
        nextCoordinator.stop();
        return { running: false, reason: suspended ? 'suspended' : 'start-cancelled' };
      }
      client = nextClient;
      coordinator = nextCoordinator;
      identity = nextIdentity;
      inertReason = null;
      refreshTimer = setInterval(() => {
        coordinator?.sweep();
        if (!coordinator || refreshPromise) return;
        const refreshing = Promise.resolve(coordinator.start())
          .catch((/** @type {any} */ e) => warn('rendezvous refresh failed:', e?.message ?? e))
          .finally(() => { if (refreshPromise === refreshing) refreshPromise = null; });
        refreshPromise = refreshing;
      }, REFRESH_MS);
      log(`self-device coordinator ONLINE as …${identity.deviceDid.slice(-8)}`);
      return { running: true, ...identity };
    })();
    startPromise = attempt;
    void attempt.finally(() => {
      if (startPromise === attempt) startPromise = null;
    }).catch(() => {});
    return attempt;
  };

  /** @param {{ suspend?: boolean }} [options] */
  const stop = async ({ suspend: shouldSuspend = false } = {}) => {
    stopping = true;
    if (shouldSuspend) suspended = true;
    generation += 1;
    try {
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
      const pending = startPromise;
      if (pending) await pending.catch(() => {});
      const refreshing = refreshPromise;
      if (refreshing) await refreshing.catch(() => {});
      receiver?.cancel?.();
      const restoring = activeRestore;
      if (restoring) await restoring.catch(() => {});
      receiver = null;
      receiverDeviceDid = null;
      sources.clear();
      sourceByTarget.clear();
      pendingOffers.clear();
      offerRequests.clear();
      lastOfferRequestAt.clear();
      await coordinator?.stop?.();
      coordinator = null;
      client = null;
      identity = null;
      if (!suspended) inertReason = null;
    } finally {
      stopping = false;
    }
  };

  const resume = () => {
    suspended = false;
    if (inertReason === 'suspended') inertReason = null;
  };

  /** Reload a custody mutation into the live coordinator before it answers.
   * @param {string} name
   */
  const refreshCustody = async (name) => {
    if (name === 'distributed/self-discovery/v1') {
      await stop();
      return start();
    }
    if (name !== 'distributed/self-records/v1') return status();
    if (!coordinator || !client) return start();
    const inputs = await client.loadCoordinatorInputs(secretIo);
    if (!inputs) { await stop(); return { running: false, reason: 'not-enrolled' }; }
    if (inputs.personDid !== identity?.personDid || inputs.deviceIdentity.did !== identity?.deviceDid) {
      await stop();
      return start();
    }
    const adopted = await coordinator.updateRoster(inputs.roster);
    return { running: true, ...identity, roster: adopted };
  };

  /** @param {string} from @param {any} frame */
  const routeFrame = async (from, frame) => {
    if (frame?.t === 'SYNC_REQUEST_OFFER') {
      if (!coordinator?.isSelfDevice(from)) return;
      const active = offerRequests.get(from);
      if (active) return active;
      const requestedAt = Date.now();
      if (requestedAt - (lastOfferRequestAt.get(from) ?? 0) < 10_000) {
        warn('rate-limited repeated snapshot request from self device');
        return;
      }
      lastOfferRequestAt.set(from, requestedAt);
      const requested = Array.isArray(frame.surfaces)
        ? frame.surfaces.filter((/** @type {any} */ surface) => DEFAULT_RESTORE_SURFACES.includes(surface))
        : [...DEFAULT_RESTORE_SURFACES];
      if (requested.length === 0) return;
      const operation = swCall('dweb/self-prepare-offer', {
        surfaces: requested, targetDeviceDid: from,
      }).then((reply) => {
        if (!reply?.ok) warn('could not prepare requested self-device offer:', reply?.error ?? 'unknown failure');
        return reply;
      }).finally(() => { if (offerRequests.get(from) === operation) offerRequests.delete(from); });
      offerRequests.set(from, operation);
      return operation;
    }
    if (frame?.t === 'SYNC_PULL') return sources.get(frame.snapshotId)?.onFrame(from, frame);
    // An offer commonly arrives while the user is still reading the restore
    // prompt. Retain one per proven self device and replay it once restoreFrom
    // installs the receiver, otherwise that ordinary ordering waits forever
    // for an offer the source has no reason to resend.
    if (frame?.t === 'SYNC_OFFER') {
      if (receiver && receiverDeviceDid === from) {
        pendingOffers.delete(from);
        return receiver.onFrame(from, frame);
      }
      pendingOffers.delete(from);
      pendingOffers.set(from, frame);
      while (pendingOffers.size > 32) {
        const oldest = pendingOffers.keys().next().value;
        if (oldest === undefined) break;
        pendingOffers.delete(oldest);
      }
      return;
    }
    return receiver?.onFrame(from, frame);
  };

  /**
   * Become the SOURCE. The SW has already shaped and consented the surfaces
   * (a withheld surface simply is not in the manifest); this side learns
   * only their names, sizes and hashes.
   *
   * @param {{ manifest: any, targetDeviceDid?: string }} args
   */
  const offerSnapshot = async ({ manifest, targetDeviceDid }) => {
    if (!coordinator) throw new Error('self-device coordinator is not running');
    const nextSource = client.createSyncSource({
      coordinator,
      manifest,
      send: (/** @type {string} */ to, /** @type {any} */ frame) => coordinator.send(to, frame),
      readSurfaceBytes: async (/** @type {string} */ surface) => {
        const reply = await swCall('dweb/self-read-surface', { surface, snapshotId: manifest.snapshotId });
        return reply?.ok && typeof reply.bytes === 'string' ? b64ToBytes(reply.bytes) : null;
      },
      onEvent: emit,
    });
    // Offer to every proven self device: they decide whether to pull.
    sources.set(manifest.snapshotId, nextSource);
    if (targetDeviceDid) {
      const previous = sourceByTarget.get(targetDeviceDid);
      if (previous) sources.delete(previous);
      sourceByTarget.set(targetDeviceDid, manifest.snapshotId);
    }
    while (sources.size > 8) {
      const oldest = sources.keys().next().value;
      if (oldest === undefined) break;
      sources.delete(oldest);
      for (const [target, snapshotId] of sourceByTarget) {
        if (snapshotId === oldest) sourceByTarget.delete(target);
      }
    }
    const offer = nextSource.offer();
    /** @type {string[]} */
    const allPeers = coordinator.selfDevices().map((/** @type {any} */ d) => d.deviceDid);
    const peers = targetDeviceDid
      ? allPeers.filter((/** @type {string} */ deviceDid) => deviceDid === targetDeviceDid)
      : allPeers;
    if (targetDeviceDid && peers.length === 0) throw new Error('offer target is not a proven self device');
    for (const deviceDid of peers) await coordinator.send(deviceDid, offer);
    return { offered: peers };
  };

  /**
   * Become the RECEIVER, restoring from one chosen self device. Resolves
   * when every wanted surface reached a terminal state: the host's retry
   * policy guarantees this settles even against a misbehaving source.
   *
   * @param {{ deviceDid: string, surfaces?: string[] }} args
   */
  const restoreFrom = async ({ deviceDid, surfaces }) => {
    if (!coordinator) throw new Error('self-device coordinator is not running');
    if (!coordinator.isSelfDevice(deviceDid)) throw new Error('not a proven self device');
    if (receiver) throw new Error('a self-device restore is already running');
    const requestedSurfaces = Array.isArray(surfaces)
      ? surfaces.filter((surface) => DEFAULT_RESTORE_SURFACES.includes(surface))
      : [...DEFAULT_RESTORE_SURFACES];
    if (requestedSurfaces.length === 0) throw new Error('no supported restore surfaces were requested');
    const nextReceiver = client.createSyncReceiver({
      coordinator,
      sourceDeviceDid: deviceDid,
      send: (/** @type {string} */ to, /** @type {any} */ frame) => coordinator.send(to, frame),
      // Return the entire user-requested set. The receiver marks any name the
      // source omitted from both available and unavailable rows incomplete.
      chooseSurfaces: () => [...requestedSurfaces],
      applySurface: async (/** @type {string} */ surface, /** @type {Uint8Array} */ bytes) => {
        // Hash-verified against the offer before it gets here. The SW owns
        // what a surface MEANS; a rejection there fails this surface alone.
        let reply;
        try {
          reply = await swCall('dweb/self-apply-surface', {
            surface, bytes: bytesToB64(bytes), sourceDeviceDid: deviceDid,
          });
        } catch (cause) {
          throw Object.assign(publishFailureError({
            error: /** @type {{message?:string}} */ (cause)?.message
              ?? 'service worker response lost',
            code: 'dweb-sw-response-lost', performed: true, outcomeKnown: false,
            outcomeKind: 'transport-lost', retryable: false,
          }, 'service worker response lost'), { cause });
        }
        if (!reply?.ok) {
          const error = publishFailureError(reply, 'apply-refused');
          if (reply?.partial && typeof reply.partial === 'object') {
            /** @type {any} */ (error).partialResult = reply.partial;
          }
          throw error;
        }
      },
      onEvent: emit,
    });
    receiver = nextReceiver;
    receiverDeviceDid = deviceDid;
    const resultPromise = nextReceiver.restore();
    activeRestore = resultPromise;
    try {
      const heldOffer = pendingOffers.get(deviceDid);
      // Consume before replay so a later restore cannot silently reuse a stale
      // snapshot. A new attempt needs a new offer from the source.
      pendingOffers.delete(deviceDid);
      if (heldOffer && Date.now() - heldOffer.manifest?.createdAt <= 30 * 60_000) {
        await nextReceiver.onFrame(deviceDid, heldOffer);
      } else {
        await coordinator.send(deviceDid, {
          t: 'SYNC_REQUEST_OFFER', proto: 1, surfaces: requestedSurfaces,
        });
      }
      return await resultPromise;
    } catch (error) {
      nextReceiver.cancel();
      await resultPromise.catch(() => {});
      throw error;
    }
    finally {
      if (receiver === nextReceiver) {
        receiver = null;
        receiverDeviceDid = null;
      }
      if (activeRestore === resultPromise) activeRestore = null;
    }
  };

  const status = () => ({
    running: Boolean(coordinator),
    reason: inertReason,
    ...(identity ?? {}),
    candidates: coordinator?.candidates() ?? [],
    selfDevices: (coordinator?.selfDevices() ?? []).map((/** @type {any} */ d) => ({
      deviceDid: d.deviceDid,
      label: d.cert?.label ?? null,
    })),
  });

  return Object.freeze({ start, stop, resume, refreshCustody, status, offerSnapshot, restoreFrom });
};
