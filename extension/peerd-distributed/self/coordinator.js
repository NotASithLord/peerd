// @ts-check
// peerd-distributed/self/coordinator.js — the self-device orchestrator.
//
// Ties the four self-device pieces together over the SAME base mesh every
// other dwapp rides (base-network.js openRoom), on the reserved
// `peerd-self/<epoch-topic>` rooms derived from the discovery secret:
//
//   discover   join the rotating rendezvous room(s); every peer that shows
//              up is a CANDIDATE, nothing more.
//   authenticate  run the mutual handshake (handshake.js) with each
//              candidate; only a peer that proves a same-person certificate
//              AND possession of its device key becomes `self-device`.
//   sync       offer/serve state surfaces (sync.js) to authenticated self
//              peers only — a non-self peer is refused at the routing edge.
//
// This module is the imperative shell around the pure protocol steps: it
// owns the candidate table, the per-link handshake state machine, and the
// self-device roster in memory. Transport, timers, persistence, and the
// actual state-surface bytes are INJECTED — so the whole coordinator is
// exercised in Bun over an in-memory mesh (self-coordinator.test.ts) with
// no browser.
//
// It NEVER holds the person root: it is handed the DEVICE identity (to
// sign proofs) plus its certificate, roster, and discovery secret. The
// root stays in the SW custody lane; the device key is what signs here,
// which is the whole point of the device-subkey split.

import { rendezvousWindow, SELF_RENDEZVOUS_DOMAIN } from './rendezvous.js';
import {
  buildAuthHello, evaluateAuthHello, buildAuthProof, verifyAuthProof, mintAuthNonce,
} from './handshake.js';

const SELF_ROOM_PREFIX = 'peerd-self';
// A handshake that stalls (peer vanished mid-dance) must not pin a slot.
const HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * @typedef {import('../identity/device-certificate.js').DeviceCertificate} DeviceCertificate
 * @typedef {import('../identity/device-certificate.js').DeviceRoster} DeviceRoster
 *
 * The transport the coordinator drives. `openRoom` returns a handle whose
 * `direct` carries 1:1 frames and whose `presence`/onPeer announces who is
 * present — exactly base-network.js's room shape, so production passes a
 * real room and tests pass an in-memory double.
 * @typedef {{
 *   did: string,
 *   openRoom: (roomId: string) => {
 *     roomId: string,
 *     direct: { send: (toDid: string, data: any) => Promise<any> | any,
 *       onMessage: (cb: (arg: { from: string, data: any }) => void) => (() => void) },
 *     onPeer: (cb: (arg: { did: string }) => void) => (() => void),
 *     peers: () => string[],
 *     leave: () => void,
 *   },
 * }} SelfMesh
 */

/**
 * @param {Object} deps
 * @param {string} deps.personDid
 * @param {{ did: string, sign: (bytes: Uint8Array) => Promise<Uint8Array> }} deps.deviceIdentity
 * @param {DeviceCertificate} deps.deviceCert
 * @param {DeviceRoster} deps.roster
 * @param {Uint8Array} deps.discoverySecret
 * @param {SelfMesh} deps.mesh
 * @param {() => number} [deps.now]
 * @param {(event: string, detail?: any) => void} [deps.onEvent]  observability
 * @param {number} [deps.skew]  rendezvous epoch skew window (default 1)
 */
export const createSelfDeviceCoordinator = ({
  personDid, deviceIdentity, deviceCert, roster, discoverySecret, mesh,
  now = Date.now, onEvent = () => {}, skew = 1,
}) => {
  /** @type {Map<string, { room: ReturnType<SelfMesh['openRoom']>, offs: (() => void)[] }>} */
  const joined = new Map(); // topic -> room handle
  /**
   * Per-peer handshake state, keyed by the peer's DEVICE did (the link did).
   * @typedef {{
   *   status: 'candidate' | 'handshaking' | 'self' | 'refused',
   *   selfNonce: string,
   *   peerNonce?: string,
   *   peerCert?: DeviceCertificate,
   *   selfVerified: boolean,
   *   peerVerified: boolean,
   *   roomId: string,
   *   deadline: number,
   *   defect?: string,
   *   pendingProof?: any,
   * }} PeerEntry
   */
  /** @type {Map<string, PeerEntry>} */
  const peers = new Map();
  /** @type {Set<(arg: { deviceDid: string, cert: DeviceCertificate }) => void>} */
  const selfDeviceCbs = new Set();
  let running = false;

  /** @param {string} deviceDid */
  const isSelfDevice = (deviceDid) => peers.get(deviceDid)?.status === 'self';

  /** @param {string} deviceDid @param {any} frame */
  const sendTo = (deviceDid, frame) => {
    const entry = peers.get(deviceDid);
    const room = entry && joined.get(topicOf(entry.roomId))?.room;
    // Fall back to whichever joined room links the peer.
    for (const { room: r } of joined.values()) {
      if (r.peers().includes(deviceDid)) return r.direct.send(deviceDid, frame);
    }
    if (room) return room.direct.send(deviceDid, frame);
    return Promise.resolve(false);
  };

  /** @param {string} roomId */
  const topicOf = (roomId) => roomId.slice(SELF_ROOM_PREFIX.length + 1);

  /** @param {string} deviceDid @param {string} roomId */
  const beginHandshake = async (deviceDid, roomId) => {
    if (deviceDid === deviceIdentity.did) return; // never handshake with self
    const existing = peers.get(deviceDid);
    if (existing && (existing.status === 'self' || existing.status === 'handshaking')) return;
    const selfNonce = mintAuthNonce();
    peers.set(deviceDid, {
      status: 'handshaking', selfNonce, selfVerified: false, peerVerified: false,
      roomId, deadline: now() + HANDSHAKE_TIMEOUT_MS,
    });
    onEvent('handshake_started', { deviceDid });
    await sendTo(deviceDid, buildAuthHello({ cert: deviceCert, nonce: selfNonce }));
  };

  /** @param {string} from @param {any} data */
  const onDirect = async (from, data) => {
    if (!data || typeof data !== 'object') return;
    if (data.t === 'AUTH_HELLO') return onAuthHello(from, data);
    if (data.t === 'AUTH_PROOF') return onAuthProof(from, data);
    // SYNC_* frames are handled by the injected sync host, but only for a
    // peer that already reached `self` — the routing gate (issue invariant
    // 12). The coordinator exposes isSelfDevice for that host to consult.
  };

  /** @param {string} from @param {any} hello */
  const onAuthHello = async (from, hello) => {
    let entry = peers.get(from);
    if (!entry) {
      // They opened the handshake; mint our nonce and reply in kind.
      await beginHandshake(from, roomFor(from));
      entry = peers.get(from);
    }
    if (!entry) return;
    const verdict = await evaluateAuthHello(hello, {
      personDid, selfDeviceDid: deviceIdentity.did, linkDeviceDid: from, roster,
    });
    if (!verdict.ok) {
      entry.status = 'refused';
      entry.defect = verdict.defect ?? 'hello-refused';
      onEvent('handshake_refused', { deviceDid: from, defect: entry.defect });
      return;
    }
    entry.peerNonce = hello.nonce;
    entry.peerCert = verdict.peerCert ?? undefined;
    // Answer their challenge with our device key.
    const proof = await buildAuthProof({
      deviceSign: deviceIdentity.sign,
      roomId: entry.roomId,
      selfDeviceDid: deviceIdentity.did,
      peerDeviceDid: from,
      selfNonce: entry.selfNonce,
      peerNonce: hello.nonce,
    });
    await sendTo(from, proof);
    maybePromote(from);
    // A proof that arrived before this hello (delivery reordering) was
    // buffered — now that peerNonce is set, it can be verified.
    if (entry.pendingProof) {
      const buffered = entry.pendingProof;
      entry.pendingProof = undefined;
      await onAuthProof(from, buffered);
    }
  };

  /** @param {string} from @param {any} proof */
  const onAuthProof = async (from, proof) => {
    const entry = peers.get(from);
    if (!entry || entry.status === 'refused') return;
    // The proof answers our challenge, but our challenge (selfNonce) is only
    // meaningful once we've seen their hello (peerNonce). Buffer an early
    // proof and replay it after the hello lands, rather than dropping it.
    if (entry.status !== 'handshaking' || !entry.peerNonce) {
      if (entry.status === 'handshaking') entry.pendingProof = proof;
      return;
    }
    const verdict = await verifyAuthProof(proof, {
      roomId: entry.roomId,
      peerDeviceDid: from,
      selfDeviceDid: deviceIdentity.did,
      peerNonce: entry.peerNonce,
      selfNonce: entry.selfNonce,
    });
    if (!verdict.ok) {
      entry.status = 'refused';
      entry.defect = verdict.defect ?? 'proof-refused';
      onEvent('handshake_refused', { deviceDid: from, defect: entry.defect });
      return;
    }
    entry.peerVerified = true;
    maybePromote(from);
  };

  // Both directions must verify: WE proved to them (they'll have sent a
  // proof answering our challenge) AND they proved to us. We track our own
  // proof as sent-implies-selfVerified once we've answered their hello.
  /** @param {string} deviceDid */
  const maybePromote = (deviceDid) => {
    const entry = peers.get(deviceDid);
    if (!entry || entry.status !== 'handshaking') return;
    // selfVerified becomes true once we've answered their hello (we can only
    // build a proof after receiving their nonce + cert).
    entry.selfVerified = entry.peerNonce !== undefined && entry.peerCert !== undefined;
    if (entry.selfVerified && entry.peerVerified) {
      entry.status = 'self';
      onEvent('self_device_confirmed', { deviceDid, cert: entry.peerCert });
      if (entry.peerCert) for (const cb of selfDeviceCbs) cb({ deviceDid, cert: entry.peerCert });
    }
  };

  /** @param {string} deviceDid */
  const roomFor = (deviceDid) => {
    for (const { room } of joined.values()) {
      if (room.peers().includes(deviceDid)) return room.roomId;
    }
    // Best effort: the first joined room.
    const first = [...joined.values()][0];
    return first ? first.room.roomId : `${SELF_ROOM_PREFIX}/unknown`;
  };

  const sweep = () => {
    const t = now();
    for (const [deviceDid, entry] of peers) {
      if (entry.status === 'handshaking' && t > entry.deadline) {
        entry.status = 'refused';
        entry.defect = 'handshake-timeout';
        onEvent('handshake_timeout', { deviceDid });
      }
    }
  };

  return Object.freeze({
    /**
     * Join the current rendezvous window's rooms and start authenticating
     * whoever appears. Idempotent; re-call on epoch rotation to refresh the
     * topic set (old rooms leave, new ones join).
     */
    async start() {
      running = true;
      const window = await rendezvousWindow(discoverySecret, {
        now: now(), skew, domain: SELF_RENDEZVOUS_DOMAIN,
      });
      const wanted = new Set(window.map((w) => `${SELF_ROOM_PREFIX}/${w.topic}`));
      // Leave rooms no longer in the window.
      for (const [topic, entry] of joined) {
        if (!wanted.has(`${SELF_ROOM_PREFIX}/${topic}`)) {
          for (const off of entry.offs) off();
          entry.room.leave();
          joined.delete(topic);
        }
      }
      // Join newly-wanted rooms.
      for (const { topic } of window) {
        if (joined.has(topic)) continue;
        const room = mesh.openRoom(`${SELF_ROOM_PREFIX}/${topic}`);
        const offs = [
          room.onPeer(({ did }) => { if (running) beginHandshake(did, room.roomId); }),
          room.direct.onMessage(({ from, data }) => { if (running) onDirect(from, data); }),
        ];
        joined.set(topic, { room, offs });
        // Kick off with peers already present.
        for (const did of room.peers()) beginHandshake(did, room.roomId);
      }
      onEvent('discovery_started', { rooms: [...joined.keys()] });
      return { rooms: [...wanted] };
    },

    /** The discovered candidates and their handshake status (for the UI). */
    candidates() {
      return [...peers.entries()].map(([deviceDid, entry]) => ({
        deviceDid,
        status: entry.status,
        label: entry.peerCert?.label ?? null,
        defect: entry.defect ?? null,
      }));
    },

    /** The confirmed self devices — the only peers state transfer may reach. */
    selfDevices() {
      return [...peers.entries()]
        .filter(([, entry]) => entry.status === 'self')
        .map(([deviceDid, entry]) => ({ deviceDid, cert: entry.peerCert }));
    },

    isSelfDevice,
    /** @param {(arg: { deviceDid: string, cert: DeviceCertificate }) => void} cb */
    onSelfDevice(cb) { selfDeviceCbs.add(cb); return () => selfDeviceCbs.delete(cb); },
    sweep,

    stop() {
      running = false;
      for (const entry of joined.values()) {
        for (const off of entry.offs) off();
        entry.room.leave();
      }
      joined.clear();
      peers.clear();
      onEvent('discovery_stopped');
    },
  });
};
