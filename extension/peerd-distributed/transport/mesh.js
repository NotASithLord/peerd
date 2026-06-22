// @ts-check
// peerd-distributed/transport/mesh.js — the per-room peer set.
//
// A mesh is the room made manifest: one authenticated link (Channel +
// did:key, established by the HELLO handshake) per member, with envelope
// routing, liveness, a connection budget, and the two control flows that
// make rooms server-optional (NORTH-STAR T2):
//
//   ROSTER  — any member can ask a link "who is in this room?"
//   RELAY   — any member forwards a SIGNED envelope between two members
//             that aren't directly connected yet (mesh-assisted
//             signaling — the kill-the-server beat). Forwarding is ONE
//             hop and only to a directly-linked target: a relay either
//             delivers to a neighbor or drops, never routes.
//
// Security posture at the inbound boundary (ARCHITECTURE §7):
//   - every envelope's signature is verified before anything reads it;
//   - link-local control (PING/ROSTER) must be signed by the link's own
//     did — a member can't speak control as someone else;
//   - RELAY envelopes are origin-signed end-to-end: the forwarder cannot
//     alter them, and a forwarder only forwards envelopes it received
//     DIRECTLY from their signer (no laundering a third party's frames);
//   - per-link control-rate token bucket bounds ping/roster flooding.
//
// The mesh routes; it does not interpret. Pubsub frames (ch=4) and any
// future channel surface through onEnvelope to gossip/ — payloads stay
// opaque here (D-7). Phase 0's content transfer protocol multiplexes on
// the same links: requests hit the served store, responses route to the
// per-peer fetch in flight.

import { buildEnvelope, signEnvelope, verifyEnvelope } from './envelope.js';
import { createContentResponder, fetchBundle } from '../content/transfer.js';
import { dlog } from '../log.js';

// ch=0 control message types (PROTOCOL §3.4; 5–7 are the Phase 1 rows).
export const CTRL = Object.freeze({
  PING: 2,
  PONG: 3,
  ROSTER_REQ: 5,
  ROSTER: 6,
  RELAY: 7,
});

const CONTENT_REQ = new Set(['MANIFEST_REQ', 'CHUNK_REQ']);
const CONTENT_RESP = new Set(['MANIFEST', 'NOMANIFEST', 'CHUNK', 'NOCHUNK']);

const newId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// why 16: matches the reducer's ROOM_CAP — a full-mesh room never needs
// more links than members (NORTH-STAR D-9).
const DEFAULT_BUDGET = 16;

/** @typedef {{ did: string, sign: (bytes: Uint8Array) => Promise<Uint8Array> }} Identity */
/** @typedef {((type: string, detail?: any) => void) | null} AuditFn */
/** @typedef {{ send: (msg: any) => void, setHandler: (h: any) => void, close: () => void, onClose: (cb: () => void) => (() => void) }} Channel */
/**
 * @typedef {{
 *   did: string,
 *   channel: Channel,
 *   lastSeen: number,
 *   ctrl: { windowStart: number, count: number },
 *   info?: any,
 *   offClose?: () => void,
 * }} Link
 */

/**
 * @param {{
 *   roomId: string,
 *   identity: Identity,
 *   now?: () => number,
 *   budget?: number,
 *   pingIntervalMs?: number,
 *   idleTimeoutMs?: number,
 *   ctrlRateLimit?: number,
 *   audit?: AuditFn,
 * }} opts
 */
export const createRoomMesh = ({
  roomId,
  identity,
  now = Date.now,
  budget = DEFAULT_BUDGET,
  // "Are you still there?" cadence — the BACKSTOP for total silence (when neither
  // a clean data-channel close nor ICE 'disconnected' fired, which is rare). PING
  // is cheap (one signed control frame): ping at 8s, drop after 18s (~2 missed
  // pings). The fast paths win in practice: dc.onclose (graceful close, ~secs) and
  // peer.js's ICE-disconnect grace (hard kill, ~5-10s) → onPeerGone → presence
  // forgets the peer at once, so the view drops it without waiting on this.
  pingIntervalMs = 8_000,
  idleTimeoutMs = 18_000,
  // control frames allowed per link per 10s window — generous for honest
  // peers (a ping every 10s), tight for floods.
  ctrlRateLimit = 60,
  audit = null, // optional (type, detail) => void
} = /** @type {{ roomId: string, identity: Identity }} */ ({})) => {
  /** @type {Map<string, Link>} */
  const links = new Map(); // did -> { channel, lastSeen, ctrl: {windowStart, count}, offClose }
  /** @type {Set<(arg: any) => void>} */
  const peerCbs = new Set();
  /** @type {Set<(arg: any) => void>} */
  const goneCbs = new Set();
  /** @type {Set<(arg: any) => void>} */
  const envelopeCbs = new Set();
  /** @type {Set<(arg: any) => void>} */
  const relayCbs = new Set();
  /** @type {Map<string, Set<(members: any) => void>>} */
  const rosterWaiters = new Map(); // did -> Set<resolve>
  /** @type {Map<string, (msg: any) => void>} */
  const contentClients = new Map(); // did -> handler for transfer responses
  /** @type {((msg: any, send: (m: any) => void) => void) | null} */
  let respondContent = null; // (msg, send) => void, when a store is served
  /** @type {ReturnType<typeof setInterval> | null} */
  let pingTimer = null;
  let closed = false;

  /**
   * @template T
   * @param {Set<(arg: T) => void>} set
   * @param {T} arg
   */
  const emit = (set, arg) => { for (const cb of [...set]) cb(arg); };

  /** @param {number} ch @param {number} typ @param {any} body */
  const sign = (ch, typ, body) =>
    signEnvelope(buildEnvelope({ ch, typ, from: identity.did, body, id: newId(), ts: now() }), identity);

  /** @param {string} did @param {any} env */
  const sendTo = (did, env) => {
    const link = links.get(did);
    if (!link) return false;
    link.channel.send(env);
    return true;
  };

  // A virtual content channel to one linked peer: sends ride the real link,
  // CONTENT_RESP frames route to this peer's handler. null if not linked.
  /** @param {string} did */
  const contentChannelFor = (did) => {
    const link = links.get(did);
    if (!link) return null;
    return {
      /** @param {any} m */
      send: (m) => link.channel.send(m),
      /** @param {((msg: any) => void) | null} h */
      setHandler: (h) => { if (h) contentClients.set(did, h); else contentClients.delete(did); },
    };
  };

  /** @param {string} did @param {string} why */
  const removeLink = (did, why) => {
    const link = links.get(did);
    if (!link) return;
    links.delete(did);
    link.offClose?.();
    try { link.channel.close(); } catch { /* already down */ }
    dlog('mesh', `🔌 peer ${(did || '').slice(-8)} link dropped (${why}) — ${links.size} link(s) left`);
    audit?.('peer_link_closed', { did, why });
    emit(goneCbs, { did, why });
  };

  /** @param {Link} link */
  const ctrlAllowed = (link) => {
    const t = now();
    if (t - link.ctrl.windowStart > 10_000) {
      link.ctrl.windowStart = t;
      link.ctrl.count = 0;
    }
    return ++link.ctrl.count <= ctrlRateLimit;
  };

  /** @param {Link} link @param {any} env */
  const handleControl = async (link, env) => {
    if (!ctrlAllowed(link)) {
      audit?.('peer_ctrl_rate_limited', { did: link.did });
      return;
    }
    const linkLocal = env.from === link.did; // signer IS the neighbor
    switch (env.typ) {
      case CTRL.PING:
        if (linkLocal) link.channel.send(await sign(0, CTRL.PONG, { nonce: env.body?.nonce }));
        return;
      case CTRL.PONG:
        return; // lastSeen already updated on receipt
      case CTRL.ROSTER_REQ: {
        if (!linkLocal || env.body?.room !== roomId) return;
        const members = [identity.did, ...links.keys()].filter((d) => d !== link.did);
        link.channel.send(await sign(0, CTRL.ROSTER, { room: roomId, members }));
        return;
      }
      case CTRL.ROSTER: {
        if (!linkLocal || env.body?.room !== roomId) return;
        const waiters = rosterWaiters.get(link.did);
        if (waiters) {
          rosterWaiters.delete(link.did);
          for (const res of waiters) res(env.body.members ?? []);
        }
        return;
      }
      case CTRL.RELAY: {
        const b = env.body;
        if (!b || b.room !== roomId || typeof b.to !== 'string') return;
        if (b.to === identity.did) {
          // For us: surface to the pairing layer (rooms.js). env.from is
          // the verified ORIGIN — the forwarder couldn't have altered it.
          emit(relayCbs, { env, via: link.did });
          return;
        }
        // Forward exactly one hop, and only frames received directly from
        // their signer — a relay never launders someone else's envelope.
        if (env.from !== link.did) return;
        if (!sendTo(b.to, env)) audit?.('relay_target_unreachable', { to: b.to, via: link.did });
        return;
      }
      default:
        return;
    }
  };

  /** @param {Link} link @param {any} msg */
  const handle = async (link, msg) => {
    if (closed || !msg) return;
    // Phase 0 content-transfer frames multiplex on mesh links.
    if (typeof msg.t === 'string' && CONTENT_REQ.has(msg.t)) {
      respondContent?.(msg, (out) => link.channel.send(out));
      return;
    }
    if (typeof msg.t === 'string' && CONTENT_RESP.has(msg.t)) {
      contentClients.get(link.did)?.(msg);
      return;
    }
    if (msg.__t === 'HELLO') return; // stale handshake frame
    if (msg.v !== 1 || !msg.sig) return; // not an envelope — drop
    if (!(await verifyEnvelope(msg))) {
      audit?.('peer_envelope_invalid', { via: link.did });
      return;
    }
    link.lastSeen = now();
    if (msg.ch === 0) return handleControl(link, msg);
    // Link-authenticity rule for non-control: flooded frames (ch=4) carry
    // their ORIGIN in `from` (≠ link did, by design); everything else is
    // link-local and must be signed by the neighbor itself.
    if (msg.ch !== 4 && msg.from !== link.did) {
      audit?.('peer_envelope_misattributed', { via: link.did, claimed: msg.from });
      return;
    }
    emit(envelopeCbs, { env: msg, via: link.did });
  };

  const sweep = async () => {
    const t = now();
    for (const [did, link] of [...links]) {
      if (t - link.lastSeen > idleTimeoutMs) {
        removeLink(did, 'idle-timeout');
      } else if (t - link.lastSeen > pingIntervalMs) {
        link.channel.send(await sign(0, CTRL.PING, { nonce: newId().slice(0, 8) }));
      }
    }
  };

  const stopTimers = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  };

  return Object.freeze({
    roomId,
    selfDid: identity.did,

    // Admit an AUTHENTICATED link (HELLO already done — did is proven).
    /** @param {Channel} channel @param {string} did @param {any} [info] */
    addLink(channel, did, info = {}) {
      if (closed) return false;
      if (did === identity.did) { channel.close(); return false; }
      if (links.size >= budget && !links.has(did)) {
        audit?.('peer_budget_refused', { did });
        channel.close();
        return false;
      }
      // why replace: two peers connecting to each other simultaneously can
      // produce crossing links; last-in wins and the loser closes, which
      // both sides converge on without a tiebreak protocol.
      if (links.has(did)) removeLink(did, 'replaced');
      /** @type {Link} */
      const link = { did, channel, lastSeen: now(), ctrl: { windowStart: now(), count: 0 }, info };
      link.offClose = channel.onClose(() => {
        if (links.get(did) === link) {
          links.delete(did);
          audit?.('peer_link_closed', { did, why: 'channel-closed' });
          emit(goneCbs, { did, why: 'channel-closed' });
        }
      });
      links.set(did, link);
      channel.setHandler((/** @type {any} */ msg) => { handle(link, msg); });
      audit?.('peer_connected', { did, room: roomId });
      emit(peerCbs, { did, info });
      return true;
    },
    /** @param {string} did */
    removeLink: (did) => removeLink(did, 'removed'),
    /** @param {string} did */
    hasLink: (did) => links.has(did),
    // Merge telemetry onto a link (e.g. the ICE path once stats settle).
    /** @param {string} did @param {any} patch */
    tagLink(did, patch) {
      const link = links.get(did);
      if (link) link.info = { ...link.info, ...patch };
    },
    peers: () => [...links.values()].map((l) => ({ did: l.did, lastSeen: l.lastSeen, info: l.info, channel: l.channel })),

    /** @param {(arg: any) => void} cb */
    onPeer: (cb) => { peerCbs.add(cb); return () => peerCbs.delete(cb); },
    /** @param {(arg: any) => void} cb */
    onPeerGone: (cb) => { goneCbs.add(cb); return () => goneCbs.delete(cb); },
    /** @param {(arg: any) => void} cb */
    onEnvelope: (cb) => { envelopeCbs.add(cb); return () => envelopeCbs.delete(cb); },
    /** @param {(arg: any) => void} cb */
    onRelay: (cb) => { relayCbs.add(cb); return () => relayCbs.delete(cb); },

    // Build-and-sign for upper layers (gossip), so the envelope shape and
    // signing stay in one place.
    sign,
    send: sendTo,
    /** @param {any} env @param {string | null} [exceptDid] */
    broadcast(env, exceptDid = null) {
      for (const [did, link] of links) {
        if (did !== exceptDid) link.channel.send(env);
      }
    },

    // "Who do you see in this room?" — the server-optional roster.
    /** @param {string} did @param {{ timeoutMs?: number }} [opts] */
    requestRoster(did, { timeoutMs = 10_000 } = {}) {
      return new Promise((resolve, reject) => {
        const link = links.get(did);
        if (!link) return reject(new Error(`requestRoster: no link to ${did}`));
        const timer = setTimeout(() => {
          rosterWaiters.get(did)?.delete(settle);
          reject(new Error('roster request timed out'));
        }, timeoutMs);
        /** @param {any} members */
        const settle = (members) => { clearTimeout(timer); resolve(members); };
        let waiters = rosterWaiters.get(did);
        if (!waiters) { waiters = new Set(); rosterWaiters.set(did, waiters); }
        waiters.add(settle);
        sign(0, CTRL.ROSTER_REQ, { room: roomId }).then((env) => link.channel.send(env));
      });
    },

    // Send a RELAY frame to `to` THROUGH `via` (a direct link). The body's
    // payload is opaque (SDP); sid correlates offer/answer.
    /**
     * @param {string} via @param {string} to @param {string} kind
     * @param {string} sid @param {any} payload
     */
    async relay(via, to, kind, sid, payload) {
      const env = await sign(0, CTRL.RELAY, { room: roomId, to, kind, sid, payload });
      if (!sendTo(via, env)) throw new Error(`relay: no link to via-peer ${via}`);
    },

    // Content multiplexing on mesh links (announce-set rules unchanged —
    // createContentResponder consults the store).
    /** @param {any} store */
    serveContent(store) { respondContent = store ? createContentResponder({ store }) : null; },
    // The swarm fetcher reads null as "unreachable" and skips the provider; the
    // per-hop dialer is what later turns a null into a channel for an unlinked
    // provider (it dials first, then this returns a live channel).
    contentChannel: contentChannelFor,
    /** @param {string} did @param {string} uri @param {any} [opts] */
    fetchFrom(did, uri, opts = {}) {
      const channel = contentChannelFor(did);
      if (!channel) return Promise.reject(new Error(`fetchFrom: no link to ${did}`));
      return fetchBundle({ uri, channel, ...opts }).finally(() => contentClients.delete(did));
    },

    // Liveness. start() is explicit so tests (and short-lived dances) can
    // run without timers.
    start: () => {
      if (!pingTimer) pingTimer = setInterval(sweep, Math.min(pingIntervalMs, idleTimeoutMs) / 3);
    },
    stop: stopTimers,
    close: () => {
      if (closed) return;
      closed = true;
      stopTimers();
      for (const did of [...links.keys()]) removeLink(did, 'mesh-closed');
    },
  });
};
