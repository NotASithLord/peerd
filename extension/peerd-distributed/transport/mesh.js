// @ts-check

import { isRawProtocolClose } from './channel.js';
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
import { establishedAdmission, TRANSFER_PROTECTION_MS, NEIGHBOR_GRACE_MS } from './neighbor-policy.js';
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
// One retired cohort plus its replacements fits without an unbounded identity
// history. This is timing custody, not reputation: cache eviction/new DIDs can
// still bypass it, so it is not a Sybil defense.
const RECENT_NEIGHBOR_CAP = DEFAULT_BUDGET * 2;
const RECENT_NEIGHBOR_TTL_MS = NEIGHBOR_GRACE_MS + TRANSFER_PROTECTION_MS;
// Local, temporary penalties; rotating a DID is cheap, so this is not a
// substitute for admission diversity or aggregate resource budgets.
const ABUSE_WINDOW_MS = 60_000;
const ABUSE_STRIKES = 3;
const COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWNS = 1_024;
// why: per-peer discipline is insufficient when many identities share a host.
// Queueing preserves reliable delivery; local overload is not a DID offense.
const VERIFY_PER_PEER = 32;
const VERIFY_PER_MESH = 128;
// Waiting work is bounded independently of active crypto. Overflow closes the
// transport so requesters see failure instead of losing reliable frames silently.
const QUEUED_PER_PEER = 32;
const QUEUED_PER_MESH = 128;

/** @typedef {{ did: string, sign: (bytes: Uint8Array) => Promise<Uint8Array> }} Identity */
/** @typedef {((type: string, detail?: any) => void) | null} AuditFn */
/** @typedef {{ send: (msg: any, options?: import('./outgoing.js').SendOptions) => void | Promise<void>, setHandler: (h: any) => void, close: () => void, isClosed?: () => boolean, onClose: (cb: (reason?: string) => void) => (() => void) }} Channel */
/**
 * @typedef {{
 *   did: string,
 *   channel: Channel,
 *   retired: AbortController,
 *   pinging?: boolean,
 *   lastSeen: number,
 *   locallySelected: boolean,
 *   admittedAt: number,
 *   protectedUntil: number,
 *   serving: number,
 *   queued: number,
 *   verifying: number,
 *   contentHandlers: Set<(msg: any) => void>,
 *   ctrl: { windowStart: number, count: number },
 *   abuse: { windowStart: number, count: number },
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
 *   sparse?: boolean,
 *   isBlocked?: (did:string)=>boolean,
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
  sparse = false,
  isBlocked = () => false,
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
  let lastRotation = -Infinity;
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
  /** @type {((msg: any, send: (m: any) => Promise<void>, owner?: object) => Promise<void>) | null} */
  let respondContent = null; // (msg, send) => void, when a store is served
  /** @type {ReturnType<typeof setInterval> | null} */
  let pingTimer = null;
  let closed = false;
  let verifying = 0;
  /** @type {{ link: Link, resolve: (accepted: boolean) => void }[]} */
  const verificationQueue = [];
  const drainVerification = () => {
    for (let i = 0; i < verificationQueue.length && verifying < VERIFY_PER_MESH;) {
      const entry = verificationQueue[i];
      if (entry.link.verifying >= VERIFY_PER_PEER) { i++; continue; }
      verificationQueue.splice(i, 1);
      entry.link.queued--;
      verifying++;
      entry.link.verifying++;
      entry.resolve(true);
    }
  };
  /** @param {Link} link */
  const cancelVerification = (link) => {
    for (let i = verificationQueue.length - 1; i >= 0; i--) {
      if (verificationQueue[i].link !== link) continue;
      const [entry] = verificationQueue.splice(i, 1);
      link.queued--;
      entry.resolve(false);
    }
  };
  /** @type {Map<string, number>} */
  const cooldowns = new Map();
  /** @type {Map<string, { admittedAt: number, protectedUntil: number, expires: number }>} */
  const recentNeighbors = new Map();
  const pruneRecentNeighbors = () => {
    const time = now();
    for (const [did, entry] of recentNeighbors) if (entry.expires <= time) recentNeighbors.delete(did);
  };
  /** @param {Link} link */
  const rememberNeighbor = (link) => {
    if (!sparse || closed) return;
    pruneRecentNeighbors();
    recentNeighbors.delete(link.did);
    if (recentNeighbors.size >= RECENT_NEIGHBOR_CAP) {
      const oldest = recentNeighbors.keys().next().value;
      if (oldest !== undefined) recentNeighbors.delete(oldest);
    }
    recentNeighbors.set(link.did, { admittedAt: link.admittedAt,
      protectedUntil: link.protectedUntil, expires: now() + RECENT_NEIGHBOR_TTL_MS });
  };

  const pruneCooldowns = () => {
    const t = now();
    for (const [did, until] of cooldowns) if (until <= t) cooldowns.delete(did);
  };

  /**
   * @template T
   * @param {Set<(arg: T) => void>} set
   * @param {T} arg
   */
  const emit = (set, arg) => { for (const cb of [...set]) cb(arg); };

  /** @param {number} ch @param {number} typ @param {any} body */
  const sign = (ch, typ, body) =>
    signEnvelope(buildEnvelope({ ch, typ, from: identity.did, body, id: newId(), ts: now() }), identity);

  /** @param {Link} link @param {any} env @param {import('./outgoing.js').SendOptions} [options] */
  const sendOnLink = async (link, env, options = {}) => {
    if (closed || links.get(link.did) !== link || options.signal?.aborted) throw new Error('mesh send cancelled or link closed');
    const ac = new AbortController();
    const abort = () => ac.abort();
    link.retired.signal.addEventListener('abort', abort, { once: true });
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      await link.channel.send(env, { ...options, signal: ac.signal });
      if (closed || links.get(link.did) !== link || ac.signal.aborted) throw new Error('mesh link retired during send');
    } finally {
      link.retired.signal.removeEventListener('abort', abort);
      options.signal?.removeEventListener('abort', abort);
    }
  };

  /** @param {string} did @param {any} env @param {import('./outgoing.js').SendOptions} [options] */
  const sendTo = async (did, env, options) => {
    const link = links.get(did);
    if (!link) return false;
    try { await sendOnLink(link, env, options); return true; }
    catch {
      // Backpressure failure is a failed connection, never identity misconduct.
      if (!options?.signal?.aborted && links.get(did) === link) removeLink(did, 'send-failed');
      return false;
    }
  };

  // A virtual content channel to one linked peer: sends ride the real link,
  // CONTENT_RESP frames route to this peer's handler. null if not linked.
  /** @param {string} did */
  const contentChannelFor = (did) => {
    const link = links.get(did);
    if (!link) return null;
    // why: concurrent downloads own separate handlers, scoped to this link
    // generation; finishing an old transfer must not detach a new one.
    /** @type {((msg: any) => void) | null} */
    let handler = null;
    return {
      /** @param {any} m @param {import('./outgoing.js').SendOptions} [options] */
      send: async (m, options) => {
        if (closed || links.get(did) !== link) throw new Error('content link closed');
        await sendOnLink(link, m, options);
      },
      // why: retain the captured generation so replacement cancels only old
      // transfers, even when the same peer immediately reconnects.
      /** @param {() => void} cb */
      onClose: (cb) => {
        if (closed || links.get(did) !== link) { cb(); return () => {}; }
        return link.channel.onClose(cb);
      },
      /** @param {((msg: any) => void) | null} h */
      setHandler: (h) => {
        if (handler) link.contentHandlers.delete(handler);
        handler = h;
        if (h && links.get(did) === link) link.contentHandlers.add(h);
      },
    };
  };

  /** @param {string} did @param {string} why */
  const removeLink = (did, why) => {
    const link = links.get(did);
    if (!link) return;
    rememberNeighbor(link);
    links.delete(did);
    link.retired.abort();
    link.contentHandlers.clear();
    cancelVerification(link);
    link.offClose?.();
    try { link.channel.close(); } catch { /* already down */ }
    dlog('mesh', `🔌 peer ${(did || '').slice(-8)} link dropped (${why}) — ${links.size} link(s) left`);
    try { audit?.('peer_link_closed', { did, why }); }
    finally { emit(goneCbs, { did, why }); }
  };

  /** @param {Link} link @param {string} reason @param {boolean} [immediate] */
  const penalize = (link, reason, immediate = false) => {
    if (closed || links.get(link.did) !== link) return;
    const t = now();
    if (t - link.abuse.windowStart >= ABUSE_WINDOW_MS) {
      link.abuse.windowStart = t;
      link.abuse.count = 0;
    }
    if (++link.abuse.count < ABUSE_STRIKES && !immediate) return;
    pruneCooldowns();
    if (cooldowns.size >= MAX_COOLDOWNS) {
      const oldest = cooldowns.keys().next().value;
      if (oldest !== undefined) cooldowns.delete(oldest);
    }
    cooldowns.set(link.did, t + COOLDOWN_MS);
    try { audit?.('peer_cooldown', { did: link.did, reason, until: t + COOLDOWN_MS }); }
    finally { removeLink(link.did, reason); }
  };

  /** @param {Link} link */
  const ctrlAllowed = (link) => {
    const t = now();
    if (t - link.ctrl.windowStart >= 10_000) {
      link.ctrl.windowStart = t;
      link.ctrl.count = 0;
    }
    return ++link.ctrl.count <= ctrlRateLimit;
  };

  /** @param {Link} link @param {any} env */
  const handleControl = async (link, env) => {
    const linkLocal = env.from === link.did; // signer IS the neighbor
    switch (env.typ) {
      case CTRL.PING:
        if (linkLocal) await sendOnLink(link, await sign(0, CTRL.PONG, { nonce: env.body?.nonce }), { priority: 'control' });
        return;
      case CTRL.PONG:
        return; // lastSeen already updated on receipt
      case CTRL.ROSTER_REQ: {
        if (!linkLocal || env.body?.room !== roomId) return;
        const members = [identity.did, ...links.keys()].filter((d) => d !== link.did);
        await sendOnLink(link, await sign(0, CTRL.ROSTER, { room: roomId, members }));
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
        if (!await sendTo(b.to, env)) audit?.('relay_target_unreachable', { to: b.to, via: link.did });
        return;
      }
      default:
        return;
    }
  };

  /** @param {Link} link @param {any} msg */
  const handle = async (link, msg) => {
    if (closed || links.get(link.did) !== link) return;
    if (!msg) { penalize(link, 'malformed-frame'); return; }
    // Phase 0 content-transfer frames multiplex on mesh links.
    if (typeof msg.t === 'string' && CONTENT_REQ.has(msg.t)) {
      if (typeof msg.hash !== 'string' || !/^[0-9a-f]{64}$/.test(msg.hash)) {
        penalize(link, 'malformed-content-request'); return;
      }
      link.serving++;
      try { await respondContent?.(msg, (out) => sendOnLink(link, out), link); }
      finally { link.serving--; }
      return;
    }
    if (typeof msg.t === 'string' && CONTENT_RESP.has(msg.t)) {
      for (const handler of [...link.contentHandlers]) handler(msg);
      return;
    }
    if (msg.__t === 'HELLO') return; // stale handshake frame
    if (msg.v !== 1 || !msg.sig) { penalize(link, 'malformed-frame'); return; }
    // Charge before crypto: an invalid signature must not bypass this budget.
    // Only charge the authenticated immediate neighbor, never the claimed signer.
    if (msg.ch === 0 && !ctrlAllowed(link)) {
      audit?.('peer_ctrl_rate_limited', { did: link.did });
      penalize(link, 'control-rate', true);
      return;
    }
    if (verifying >= VERIFY_PER_MESH || link.verifying >= VERIFY_PER_PEER) {
      if (link.queued >= QUEUED_PER_PEER || verificationQueue.length >= QUEUED_PER_MESH) {
        audit?.('peer_verification_overflow', { did: link.did });
        removeLink(link.did, 'verification-overflow');
        return;
      }
      link.queued++;
      const accepted = await new Promise((resolve) => verificationQueue.push({ link, resolve }));
      if (!accepted) return;
    } else {
      verifying++;
      link.verifying++;
    }
    if (closed || links.get(link.did) !== link) {
      verifying--; link.verifying--; drainVerification(); return;
    }
    let valid = false;
    try { valid = await verifyEnvelope(msg); }
    finally { verifying--; link.verifying--; drainVerification(); }
    if (!valid) {
      audit?.('peer_envelope_invalid', { via: link.did });
      penalize(link, 'invalid-envelope');
      return;
    }
    if (closed || links.get(link.did) !== link) return;
    link.lastSeen = now();
    if (msg.ch === 0) return handleControl(link, msg);
    // Link-authenticity rule for non-control: flooded frames (ch=4) carry
    // their ORIGIN in `from` (≠ link did, by design); everything else is
    // link-local and must be signed by the neighbor itself.
    if (msg.ch !== 4 && msg.from !== link.did) {
      audit?.('peer_envelope_misattributed', { via: link.did, claimed: msg.from });
      penalize(link, 'misattributed-envelope');
      return;
    }
    emit(envelopeCbs, { env: msg, via: link.did });
  };

  const sweep = () => {
    const t = now();
    for (const [did, link] of [...links]) {
      if (t - link.lastSeen > idleTimeoutMs) {
        removeLink(did, 'idle-timeout');
      } else if (t - link.lastSeen > pingIntervalMs && !link.pinging) {
        // One pending ping per link; a slow neighbor must not delay another
        // neighbor's sweep or accumulate more sends on every timer tick.
        link.pinging = true;
        sign(0, CTRL.PING, { nonce: newId().slice(0, 8) })
          .then((env) => sendOnLink(link, env, { priority: 'control' }))
          .catch(() => { if (links.get(did) === link) removeLink(did, 'ping-failed'); })
          .finally(() => { link.pinging = false; });
      }
    }
  };

  const stopTimers = () => {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  };

  return Object.freeze({
    roomId,
    selfDid: identity.did,
    // Enabled only after the room owner observes a negotiated public profile.
    // Sticky for this room lifetime: reconnect fallback must not erase local
    // ownership/reservations while authenticated links survive the outage.
    enableSparseAdmission: () => { sparse = true; },
    locallySelectedCount: () => [...links.values()].filter((link) => link.locallySelected).length,

    // Admit an AUTHENTICATED link (HELLO already done — did is proven).
    /** @param {Channel} channel @param {string} did @param {any} [info]
     * @param {{ locallySelected?: boolean }} [ownership] */
    addLink(channel, did, info = {}, { locallySelected = false } = {}) {
      if (closed || channel.isClosed?.() || isBlocked(did)) { channel.close(); return false; }
      pruneCooldowns();
      if (cooldowns.has(did)) {
        audit?.('peer_cooldown_refused', { did });
        channel.close();
        return false;
      }
      if (did === identity.did) { channel.close(); return false; }
      const previous = links.get(did);
      pruneRecentNeighbors();
      const timing = previous ?? (sparse ? recentNeighbors.get(did) : undefined);
      if (!previous) {
        const time = now();
        let decision = { allowed: links.size < budget, evict: /** @type {string | undefined} */ (undefined) };
        if (sparse) {
          const values = [...links.values()];
          const pressure = links.size >= budget || (!locallySelected
            && values.filter((link) => !link.locallySelected).length >= budget - Math.min(2, Math.max(0, budget - 1)));
          const peers = values.map((link) => {
            const busy = link.serving > 0 || link.contentHandlers.size > 0;
            // One bounded protection window per link begins on first pressure,
            // not each remote request. Continuous work cannot pin a slot forever.
            if (pressure && busy && time - link.admittedAt >= NEIGHBOR_GRACE_MS && link.protectedUntil === 0) link.protectedUntil = time + TRANSFER_PROTECTION_MS;
            return { did: link.did, locallySelected: link.locallySelected, admittedAt: link.admittedAt,
              protectedUntil: link.protectedUntil, busy };
          });
          decision = { evict: undefined, ...establishedAdmission({ peers, budget, locallySelected, now: time, lastRotation }) };
        }
        if (!decision.allowed) {
          audit?.('peer_budget_refused', { did });
          channel.close();
          return false;
        }
        if (decision.evict) { lastRotation = time; removeLink(decision.evict, 'neighbor-rotation'); }
      }
      // The room resolves crossing offers before this point. Replacement of
      // the same authenticated neighbor preserves its age and local ownership;
      // a short complete disconnect also retains only timing custody. Local
      // exploration ownership is never inherited from a retired connection.
      if (links.has(did)) removeLink(did, 'replaced');
      /** @type {Link} */
      const link = { did, channel, locallySelected: locallySelected || previous?.locallySelected || false,
        admittedAt: timing?.admittedAt ?? now(), protectedUntil: timing?.protectedUntil ?? 0, serving: 0, retired: new AbortController(), contentHandlers: new Set(), verifying: 0, queued: 0, lastSeen: now(), ctrl: { windowStart: now(), count: 0 }, abuse: { windowStart: now(), count: 0 }, info };
      // Own this exact generation before an already-closed channel can invoke
      // its immediate observer. A close during handoff must not become connected.
      recentNeighbors.delete(did);
      links.set(did, link);
      link.offClose = channel.onClose((reason) => {
        if (links.get(did) === link) {
          if (isRawProtocolClose(reason)) { penalize(link, /** @type {string} */ (reason), true); return; }
          rememberNeighbor(link);
          links.delete(did);
          link.retired.abort();
          link.contentHandlers.clear();
          cancelVerification(link);
          try { audit?.('peer_link_closed', { did, why: 'channel-closed' }); }
          finally { emit(goneCbs, { did, why: 'channel-closed' }); }
        }
      });
      if (links.get(did) !== link) { link.offClose(); return false; }
      channel.setHandler((/** @type {any} */ msg) => {
        handle(link, msg).catch(() => { if (links.get(did) === link) removeLink(did, 'service-or-send-failed'); });
      });
      if (links.get(did) !== link) return false;
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
    async broadcast(env, exceptDid = null) {
      await Promise.all([...links.keys()].filter((did) => did !== exceptDid).map((did) => sendTo(did, env)));
    },

    // "Who do you see in this room?" — the server-optional roster.
    /** @param {string} did @param {{ timeoutMs?: number }} [opts] */
    requestRoster(did, { timeoutMs = 10_000 } = {}) {
      return new Promise((resolve, reject) => {
        const link = links.get(did);
        if (!link) return reject(new Error(`requestRoster: no link to ${did}`));
        const ac = new AbortController();
        let settled = false;
        let offClose = () => {};
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        const cleanup = () => {
          clearTimeout(timer); ac.abort(); offClose();
          rosterWaiters.get(did)?.delete(settle);
          if (!rosterWaiters.get(did)?.size) rosterWaiters.delete(did);
        };
        /** @param {any} error */
        const fail = (error) => { if (!settled) { settled = true; cleanup(); reject(error); } };
        /** @param {any} members */
        const settle = (members) => { if (!settled) { settled = true; cleanup(); resolve(members); } };
        let waiters = rosterWaiters.get(did);
        if (!waiters) { waiters = new Set(); rosterWaiters.set(did, waiters); }
        waiters.add(settle);
        offClose = link.channel.onClose(() => fail(new Error('roster link closed')));
        if (settled) { offClose(); return; }
        timer = setTimeout(() => fail(new Error('roster send timed out')), 15_000);
        sign(0, CTRL.ROSTER_REQ, { room: roomId }).then(async (env) => {
          if (settled) return;
          await sendOnLink(link, env, { signal: ac.signal });
          if (settled) return;
          clearTimeout(timer);
          timer = setTimeout(() => fail(new Error('roster request timed out')), timeoutMs);
        }).catch(fail);
      });
    },

    // Send a RELAY frame to `to` THROUGH `via` (a direct link). The body's
    // payload is opaque (SDP); sid correlates offer/answer.
    /**
     * @param {string} via @param {string} to @param {string} kind
     * @param {string} sid @param {any} payload @param {{ signal?: AbortSignal }} [options]
     */
    async relay(via, to, kind, sid, payload, { signal } = {}) {
      if (signal?.aborted) throw new Error('relay cancelled');
      const env = await sign(0, CTRL.RELAY, { room: roomId, to, kind, sid, payload });
      if (signal?.aborted) throw new Error('relay cancelled');
      if (!await sendTo(via, env, { signal })) throw new Error(`relay: no link to via-peer ${via}`);
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
      return fetchBundle({ uri, channel, ...opts }).finally(() => channel.setHandler(null));
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
      cooldowns.clear();
      recentNeighbors.clear();
    },
  });
};
