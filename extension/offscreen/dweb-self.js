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

import browser from '/vendor/browser-polyfill.js';
import { loadDweb } from '/shared/dweb-loader.js';

const log = (/** @type {any[]} */ ...a) => console.log('[offscreen/dweb-self]', ...a);
const warn = (/** @type {any[]} */ ...a) => console.warn('[offscreen/dweb-self]', ...a);

// The coordinator's rendezvous topics rotate on an epoch; re-running start()
// joins the new window and leaves the old. Sweeping also expires handshakes
// that stalled because a peer vanished mid-dance.
const REFRESH_MS = 60_000;

/**
 * @param {Object} deps
 * @param {{ getSecret: (name: string) => Promise<string | null>,
 *   setSecret: (name: string, value: string) => Promise<void> }} deps.secretIo
 *   the vault surface, proxied over the custody port
 * @param {(type: string, payload?: object) => Promise<any>} deps.swCall
 * @param {() => any} deps.getMesh  the live base-network mesh, or null
 */
export const createSelfDeviceHost = ({ secretIo, swCall, getMesh }) => {
  /** @type {any} */
  let client = null;
  /** @type {any} */
  let coordinator = null;
  /** @type {any} */
  let source = null;
  /** @type {any} */
  let receiver = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let refreshTimer = null;
  /** @type {{ personDid: string, deviceDid: string } | null} */
  let identity = null;
  /** @type {string | null} */
  let inertReason = null;

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
  const start = async () => {
    if (coordinator) return { running: true, ...identity };
    // why any: the live dweb module's surface exceeds the stub interface.
    client = /** @type {any} */ (await loadDweb());
    if (!client.available || !client.createSelfDeviceCoordinator) {
      inertReason = 'dweb-unavailable';
      return { running: false, reason: inertReason };
    }
    const mesh = getMesh();
    if (!mesh) {
      inertReason = 'mesh-offline';
      return { running: false, reason: inertReason };
    }
    const inputs = await client.loadCoordinatorInputs(secretIo);
    if (!inputs) {
      // Not a member of any person's device set yet. This is the ordinary
      // state of a fresh install before enrollment, not an error: joining
      // nothing is exactly right, because the rendezvous topics are derived
      // from a discovery secret this install does not have.
      inertReason = 'not-enrolled';
      return { running: false, reason: inertReason };
    }
    inertReason = null;
    identity = { personDid: inputs.personDid, deviceDid: inputs.deviceIdentity.did };

    coordinator = client.createSelfDeviceCoordinator({
      personDid: inputs.personDid,
      deviceIdentity: inputs.deviceIdentity,
      deviceCert: inputs.deviceCert,
      roster: inputs.roster,
      discoverySecret: inputs.discoverySecret,
      mesh,
      onEvent: (/** @type {string} */ event, /** @type {any} */ detail) => {
        log(event, detail?.deviceDid ? `…${String(detail.deviceDid).slice(-8)}` : '');
        emit(event, detail);
      },
    });
    coordinator.onAppFrame((/** @type {string} */ from, /** @type {any} */ frame) => {
      void routeFrame(from, frame);
    });
    await coordinator.start();
    refreshTimer = setInterval(() => {
      coordinator?.sweep();
      // Re-running start() rotates the rendezvous window as the epoch turns.
      coordinator?.start().catch((/** @type {any} */ e) => warn('rendezvous refresh failed:', e?.message ?? e));
    }, REFRESH_MS);
    log(`self-device coordinator ONLINE as …${identity.deviceDid.slice(-8)}`);
    return { running: true, ...identity };
  };

  const stop = () => {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    receiver?.cancel?.();
    receiver = null;
    source = null;
    coordinator?.stop();
    coordinator = null;
    identity = null;
  };

  /** @param {string} from @param {any} frame */
  const routeFrame = async (from, frame) => {
    // A single link carries one direction at a time; dispatch by frame kind
    // so an install can be a source for one sibling while restoring from
    // another without two transports.
    if (frame?.t === 'SYNC_PULL') return source?.onFrame(from, frame);
    return receiver?.onFrame(from, frame);
  };

  /**
   * Become the SOURCE. The SW has already shaped and consented the surfaces
   * (a withheld surface simply is not in the manifest); this side learns
   * only their names, sizes and hashes.
   *
   * @param {{ manifest: any }} args
   */
  const offerSnapshot = async ({ manifest }) => {
    if (!coordinator) throw new Error('self-device coordinator is not running');
    source = client.createSyncSource({
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
    const offer = source.offer();
    const peers = coordinator.selfDevices().map((/** @type {any} */ d) => d.deviceDid);
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
    receiver = client.createSyncReceiver({
      coordinator,
      sourceDeviceDid: deviceDid,
      send: (/** @type {string} */ to, /** @type {any} */ frame) => coordinator.send(to, frame),
      chooseSurfaces: (/** @type {string[]} */ offered) =>
        (Array.isArray(surfaces) ? offered.filter((name) => surfaces.includes(name)) : offered),
      applySurface: async (/** @type {string} */ surface, /** @type {Uint8Array} */ bytes) => {
        // Hash-verified against the offer before it gets here. The SW owns
        // what a surface MEANS; a rejection there fails this surface alone.
        const reply = await swCall('dweb/self-apply-surface', {
          surface, bytes: bytesToB64(bytes), sourceDeviceDid: deviceDid,
        });
        if (!reply?.ok) throw new Error(reply?.error ?? 'apply-refused');
      },
      onEvent: emit,
    });
    const result = await receiver.restore();
    receiver = null;
    return result;
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

  return Object.freeze({ start, stop, status, offerSnapshot, restoreFrom });
};
