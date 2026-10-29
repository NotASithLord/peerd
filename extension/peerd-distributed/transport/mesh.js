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

import { buildEnvelope, envelopeBytes, signEnvelope, verifyEnvelope } from './envelope.js';
import { establishedAdmission, TRANSFER_PROTECTION_MS, NEIGHBOR_GRACE_MS } from './neighbor-policy.js';
import { createContentResponder, fetchBundle } from '../content/transfer.js';
import { dlog } from '../log.js';
import { createLocalCounters } from '../local-counters.js';
import { createControlPacer } from './control-pacer.js';
import { CONTENT_ONLY, LOOKUP_ONLY, ROUTING_WITNESS, ROUTING_CONTROL } from './capabilities.js';
import { DIRECTORY_INTRODUCTIONS, createDirectoryIntroductions } from './directory-introductions.js';

// ch=0 control message types (PROTOCOL §3.4; 5–7 are the Phase 1 rows).
export const CTRL = Object.freeze({
  PING: 2,
  PONG: 3,
  ROSTER_REQ: 5,
  ROSTER: 6,
  RELAY: 7,
  ...ROUTING_CONTROL,
});

const routingControlTypes=new Set(Object.values(ROUTING_CONTROL));
const isRoutingControl=(/** @type {any} */ env)=>env?.ch===0&&routingControlTypes.has(env.typ);
export class RoutingControlError extends Error {
  constructor(){super('routing control carrier unavailable');this.name='RoutingControlError';}
}

const CONTENT_REQ = new Set(['MANIFEST_REQ', 'CHUNK_REQ']);
const CONTENT_RESP = new Set(['MANIFEST', 'NOMANIFEST', 'CHUNK', 'NOCHUNK']);

const newId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// why 16: matches the reducer's ROOM_CAP — a full-mesh room never needs
// more links than members (NORTH-STAR D-9).
const DEFAULT_BUDGET = 16;
export const CONTENT_LINK_LIFETIME_MS = 60_000;
export const ROTATION_HOLD_MS = 10_000;
export const MAX_ROTATION_HOLDS = 16;
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
/** @typedef {{ send: (msg: any, options?: import('./outgoing.js').SendOptions) => void | Promise<void>, setHandler: (h: any) => void, close: () => void, isClosed?: () => boolean, maxFrameBytes?:()=>number, onClose: (cb: (reason?: string) => void) => (() => void) }} Channel */
/**
 * @typedef {{
 *   did: string,
 *   purpose: 'routing' | 'content' | 'lookup' | 'directory',
 *   routingWitness: boolean,
 *   leases: number,
 *   controlPacer: ReturnType<typeof createControlPacer>,
 *   introductions?: ReturnType<typeof createDirectoryIntroductions>,
 *   expiry?: ReturnType<typeof setTimeout>,
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
 *   contentHandlers: Set<(msg: any) => boolean | void>,
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
 *   transferSlots?: number,
 *   timers?: any,
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
  transferSlots = 0,
  timers = globalThis,
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
  // why: temporary transfers reserve capacity inside the existing total, not
  // above it. This opt-in boundary is inactive until the room negotiates it.
  if (!Number.isSafeInteger(transferSlots) || transferSlots < 0 || transferSlots >= budget) throw new Error('invalid transfer slots');
  const routingBudget = budget - transferSlots;
  // Local send completion is not a remote delivery acknowledgment.
  const traffic = Object.fromEntries(['gossip', 'discoveryItem', 'discoverySnapshot', 'discoveryControl',
    'topicControl', 'contentRequest', 'contentResponse', 'other'].map(name =>
    [name, createLocalCounters(['attempted', 'completed', 'failed'])]));
  const broadcasts = createLocalCounters(['calls', 'destinations', 'maxDestinations']);
  /** @param {any} frame */
  const trafficFor = (frame) => {
    if (CONTENT_REQ.has(frame?.t)) return traffic.contentRequest;
    if (CONTENT_RESP.has(frame?.t)) return traffic.contentResponse;
    if (frame?.ch === 4) return frame.typ === 0 ? traffic.gossip : traffic.topicControl;
    if (frame?.ch === 5) return frame.typ === 2 ? traffic.discoveryItem
      : frame.typ === 1 ? traffic.discoverySnapshot : traffic.discoveryControl;
    return traffic.other;
  };
  /** @type {Map<string, Link>} */
  const links = new Map(); // did -> { channel, lastSeen, ctrl: {windowStart, count}, offClose }
  const routingLinks = () => [...links.values()].filter(link => link.purpose === 'routing');
  /** @type {Map<Link, {expiresAt:number, releases:Set<()=>void>}>} */
  const rotationHolds = new Map();
  let rotationHoldCount = 0;
  let lastRotation = -Infinity;
  let sparseRotation = sparse;
  /** @type {Set<(arg: any) => void>} */
  const peerCbs = new Set();
  /** @type {Set<(arg: any) => void>} */
  const goneCbs = new Set();
  /** @type {Set<(arg: any) => void>} */
  const envelopeCbs = new Set();
  /** @type {Set<(arg: any) => void>} */
  const relayCbs = new Set();
  /** @type {((event:{env:any,carrier:{did:string,signal:AbortSignal,maxFrameBytes:()=>number,send:(env:any,options?:import('./outgoing.js').SendOptions)=>Promise<void>}})=>void)|null} */
  let routingControlHandler=null;
  /** @type {AbortController|null} */let routingControlOwner=null;
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
    if (!sparse || closed || link.purpose !== 'routing') return;
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

  /** @param {Link} link @param {any} env @param {import('./outgoing.js').SendOptions} [options] @param {()=>void} [validate] */
  const sendOnLink = async (link, env, options = {}, validate) => {
    const counts = trafficFor(env);
    counts.add('attempted');
    if (closed || links.get(link.did) !== link || options.signal?.aborted) {
      counts.add('failed');
      throw new Error('mesh send cancelled or link closed');
    }
    const ac = new AbortController();
    const abort = () => ac.abort();
    link.retired.signal.addEventListener('abort', abort, { once: true });
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      if(env?.ch===0)await link.controlPacer.take({signal:ac.signal});
      if(ac.signal.aborted||links.get(link.did)!==link)throw new Error('mesh link retired during pacing');
      validate?.();
      await link.channel.send(env, { ...options, signal: ac.signal });
      if (closed || links.get(link.did) !== link || ac.signal.aborted) throw new Error('mesh link retired during send');
      counts.add('completed');
    } catch (error) {
      counts.add('failed');
      throw error;
    } finally {
      link.retired.signal.removeEventListener('abort', abort);
      options.signal?.removeEventListener('abort', abort);
    }
  };

  /** @type {WeakMap<Link,{owner:AbortController,carrier:{did:string,signal:AbortSignal,maxFrameBytes:()=>number,send:(env:any,options?:import('./outgoing.js').SendOptions)=>Promise<void>}}>} */
  const routingCarrierCache=new WeakMap();
  /** @param {Link} link */
  const routingFrameLimit=(link)=>{
    const limit=link.channel.maxFrameBytes?.()??4_096;
    return limit===Infinity?16_384:Number.isFinite(limit)?Math.max(0,Math.min(16_384,limit)):0;
  };
  /** @param {Link} link */
  const routingCarrierFor=(link)=>{
    const owner=routingControlOwner;
    if(!owner||closed||links.get(link.did)!==link||link.retired.signal.aborted||link.channel.isClosed?.()||!link.routingWitness||link.purpose!=='routing'||!routingControlHandler)return null;
    const cached=routingCarrierCache.get(link);if(cached?.owner===owner)return cached.carrier;
    const signal=AbortSignal.any([link.retired.signal,owner.signal]);
    const current=()=>routingControlOwner===owner&&!signal.aborted&&!closed&&links.get(link.did)===link&&!link.retired.signal.aborted
      &&!link.channel.isClosed?.()&&link.purpose==='routing'&&link.routingWitness&&!!routingControlHandler;
    if(!current())return null;
    const carrier=Object.freeze({did:link.did,signal,maxFrameBytes:()=>current()?routingFrameLimit(link):0,
      /** @param {any} env @param {import('./outgoing.js').SendOptions} [options] */
      async send(env,options){
        if(!current()||!isRoutingControl(env)||envelopeBytes(env)>routingFrameLimit(link))throw new RoutingControlError();
        const owned=structuredClone(env);
        await sendOnLink(link,owned,{...options,signal:options?.signal?AbortSignal.any([signal,options.signal]):signal,priority:'control'},()=>{
          if(!current()||envelopeBytes(owned)>routingFrameLimit(link))throw new RoutingControlError();
        });
        if(!current())throw new RoutingControlError();
      },
    });
    routingCarrierCache.set(link,{owner,carrier});return carrier;
  };

  /** @param {string} did @param {any} env @param {import('./outgoing.js').SendOptions} [options] */
  const sendTo = async (did, env, options) => {
    const link = links.get(did);
    if (!link || link.purpose !== 'routing') { const counts = trafficFor(env); counts.add('attempted'); counts.add('failed'); return false; }
    try { await sendOnLink(link, env, options); return true; }
    catch {
      // Backpressure failure is a failed connection, never identity misconduct.
      if (!options?.signal?.aborted && links.get(did) === link) removeLink(did, 'send-failed');
      return false;
    }
  };

  /** @param {any} env */
  const directoryFrame = (env) => !env?.t && ((env?.ch === 1 && [0,1].includes(env.typ))
    || (env?.ch === 0 && [CTRL.ROSTER_REQ,CTRL.ROSTER,CTRL.RELAY].includes(env.typ)));
  /** @param {Link} link @param {any} env */
  const introductionAllowed = (link, env) => !!link.introductions?.allow({
    from:env.from,to:env.body?.to,via:link.did,kind:env.body?.kind,sid:env.body?.sid,payload:env.body?.payload,
  });
  /** @param {string} did @param {any} env @param {import('./outgoing.js').SendOptions} [options] */
  const sendIntroduction = async (did, env, options) => {
    const link=links.get(did);
    if (link?.purpose !== 'directory') return sendTo(did, env, options);
    if (env.ch !== 0 || env.typ !== CTRL.RELAY || !introductionAllowed(link, env)) return false;
    try {await sendOnLink(link, env, options);return true;} catch {return false;}
  };

  // A virtual content channel to one linked peer: sends ride the real link,
  // CONTENT_RESP frames route to this peer's handler. null if not linked.
  /** @param {string} did */
  const contentChannelFor = (did) => {
    const link = links.get(did);
    if (!link || !['routing','content'].includes(link.purpose)) return null;
    // why: concurrent downloads own separate handlers, scoped to this link
    // generation; finishing an old transfer must not detach a new one.
    /** @type {((msg: any) => boolean | void) | null} */
    let handler = null;
    return {
      /** @param {any} m @param {import('./outgoing.js').SendOptions} [options] */
      send: async (m, options) => {
        if (closed || links.get(did) !== link) throw new Error('content link closed');
        if (link.purpose === 'content' && !CONTENT_REQ.has(m?.t) && !CONTENT_RESP.has(m?.t)) throw new Error('content link scope');
        await sendOnLink(link, m, options);
      },
      // why: retain the captured generation so replacement cancels only old
      // transfers, even when the same peer immediately reconnects.
      /** @param {() => void} cb */
      onClose: (cb) => {
        if (closed || links.get(did) !== link) { cb(); return () => {}; }
        return link.channel.onClose(cb);
      },
      /** @param {((msg: any) => boolean | void) | null} h */
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
    timers.clearTimeout(link.expiry);
    link.retired.abort();
    link.introductions?.close();
    link.controlPacer.close();
    link.contentHandlers.clear();
    cancelVerification(link);
    link.offClose?.();
    try { link.channel.close(); } catch { /* already down */ }
    dlog('mesh', `🔌 peer ${(did || '').slice(-8)} link dropped (${why}) — ${links.size} link(s) left`);
    try { audit?.('peer_link_closed', { did, why }); }
    finally { if (link.purpose === 'routing') emit(goneCbs, { did, why }); }
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
      case CTRL.ROUTE_CALL:
      case CTRL.ROUTE_REPLY:
      case CTRL.ROUTE_CANCEL: {
        const carrier=routingCarrierFor(link);
        // Signature verification authenticates the origin, not the route.
        // The single protocol owner must also match path and request custody.
        if(carrier)routingControlHandler?.({env,carrier});
        return;
      }
      case CTRL.PING:
        if (linkLocal) await sendOnLink(link, await sign(0, CTRL.PONG, { nonce: env.body?.nonce }), { priority: 'control' });
        return;
      case CTRL.PONG:
        return; // lastSeen already updated on receipt
      case CTRL.ROSTER_REQ: {
        if (!linkLocal || env.body?.room !== roomId) return;
        const members = [identity.did, ...routingLinks().map(peer => peer.did)].filter((d) => d !== link.did);
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
        if (link.purpose === 'directory' && !introductionAllowed(link, env)) return;
        if (b.to === identity.did) {
          // For us: surface to the pairing layer (rooms.js). env.from is
          // the verified ORIGIN — the forwarder couldn't have altered it.
          emit(relayCbs, { env, via: link.did });
          return;
        }
        // Forward exactly one hop, and only frames received directly from
        // their signer — a relay never launders someone else's envelope.
        if (env.from !== link.did) return;
        // Directory introductions terminate at an existing routing neighbor;
        // they do not form chains of relay-forwarded envelopes.
        if (link.purpose === 'directory' && links.get(b.to)?.purpose !== 'routing') return;
        if (!await sendIntroduction(b.to, env)) audit?.('relay_target_unreachable', { to: b.to, via: link.did });
        return;
      }
      default:
        return;
    }
  };

  /** @param {Link} link @param {any} msg */
  const handle = async (link, msg) => {
    if (closed || links.get(link.did) !== link) return;
    if (link.purpose === 'directory' && !directoryFrame(msg)) { penalize(link, 'directory-link-scope', true); return; }
    if (link.purpose === 'lookup' && !(msg?.ch === 1 && !msg.t && (msg.typ === 0 || msg.typ === 1))) { penalize(link, 'lookup-link-scope', true); return; }
    if (!msg) { penalize(link, 'malformed-frame'); return; }
    // Phase 0 content-transfer frames multiplex on mesh links.
    if (typeof msg.t === 'string' && CONTENT_REQ.has(msg.t)) {
      if (typeof msg.hash !== 'string' || !/^[0-9a-f]{64}$/.test(msg.hash)) {
        penalize(link, 'malformed-content-request'); return;
      }
      // why: content rides the authenticated DTLS/SCTP link without a signed
      // envelope. Valid transfer traffic is still peer activity; ignoring it
      // lets the idle sweeper sever a healthy slow transfer.
      link.lastSeen = now();
      link.serving++;
      try { await respondContent?.(msg, (out) => sendOnLink(link, out), link); }
      finally { link.serving--; }
      return;
    }
    if (typeof msg.t === 'string' && CONTENT_RESP.has(msg.t)) {
      if (typeof msg.hash !== 'string' || !/^[0-9a-f]{64}$/.test(msg.hash)) {
        penalize(link, 'malformed-content-response'); return;
      }
      // A late reply after cancellation is ordinary, not abuse. Ignore it for
      // liveness unless a current client accepts validated correlated progress.
      let progress = false;
      for (const handler of [...link.contentHandlers]) if (handler(msg) === true) progress = true;
      if (progress && !closed && links.get(link.did) === link) link.lastSeen = now();
      return;
    }
    if (link.purpose === 'content') { penalize(link, 'content-link-scope', true); return; }
    if (msg.__t === 'HELLO') return; // stale handshake frame
    if (msg.v !== 1 || !msg.sig) { penalize(link, 'malformed-frame'); return; }
    const incomingRoutingOwner=isRoutingControl(msg)?routingControlOwner:null;
    if(isRoutingControl(msg)){
      if(link.purpose!=='routing'||!link.routingWitness||!routingControlHandler)return;
      if(envelopeBytes(msg)>routingFrameLimit(link))return;
      // In-memory channels may share object references. Own the exact frame
      // before awaiting crypto so a caller cannot mutate an authenticated plan.
      try{msg=structuredClone(msg);}catch{return;}
    }
    // Charge before crypto: an invalid signature must not bypass this budget.
    // Only charge the authenticated immediate neighbor, never the claimed signer.
    if (msg.ch === 0 && !ctrlAllowed(link)) {
      audit?.('peer_ctrl_rate_limited', { did: link.did });
      penalize(link, 'control-rate', true);
      return;
    }
    if (verifying >= VERIFY_PER_MESH || link.verifying >= VERIFY_PER_PEER) {
      if (link.queued >= QUEUED_PER_PEER || verificationQueue.length >= QUEUED_PER_MESH) {
        // Unverified frame bytes never enter diagnostics. Fixed-size occupancy
        // and channel classification distinguish local pressure from peer floods.
        audit?.('peer_verification_overflow', {
          did: link.did,
          channel: Number.isInteger(msg.ch) && msg.ch >= 0 && msg.ch <= 5 ? msg.ch : -1,
          claimedForwarded: msg.ch === 4 && msg.from !== link.did,
          activePeer: link.verifying, activeMesh: verifying,
          queuedPeer: link.queued, queuedMesh: verificationQueue.length,
        });
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
    if(isRoutingControl(msg)&&(!incomingRoutingOwner||routingControlOwner!==incomingRoutingOwner))return;
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
    emit(envelopeCbs, { env: msg, via: link.did, purpose: link.purpose });
  };

  const sweep = () => {
    const t = now();
    for (const [did, link] of [...links]) {
      if (t - link.lastSeen > idleTimeoutMs) {
        removeLink(did, 'idle-timeout');
      } else if (link.purpose === 'routing' && t - link.lastSeen > pingIntervalMs && !link.pinging) {
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

  /** @param {string} did @param {'content'|'lookup'|'directory'} purpose @param {AbortSignal|undefined} signal */
  const acquireScopedLink = (did, purpose, signal) => {
    const link = links.get(did);
    if (!link || (link.purpose !== 'routing' && link.purpose !== purpose && !(purpose === 'lookup' && link.purpose === 'directory')) || closed || signal?.aborted) throw new Error('content lease unavailable');
    link.leases++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener('abort', release);
      link.retired.signal.removeEventListener('abort', release);
      link.leases--;
      if (link.purpose !== 'routing' && link.leases === 0 && links.get(did) === link) removeLink(did, 'content-released');
    };
    signal?.addEventListener('abort', release, { once: true });
    link.retired.signal.addEventListener('abort', release, { once: true });
    return Object.freeze({ release });
  };
  /** @param {'routing'|'content'|'lookup'|'directory'} purpose @param {boolean} locallySelected @param {boolean} [requireWitness] */
  const admissionDecision=(purpose,locallySelected,requireWitness=false)=>{
    pruneAdmissions();
    const time = now();
    const planned=[...reservedAdmissions.values()];
    const victims=new Set(planned.map(p=>p.evict).filter(Boolean));
    const values=routingLinks().filter(link=>!victims.has(link.did));
    const projected=values.length+planned.length;
    let decision = { allowed: projected + links.size-routingLinks().length < budget && (purpose !== 'routing'
          ? links.size - routingLinks().length < transferSlots : projected < routingBudget), evict: /** @type {string | undefined} */ (undefined) };
        if (sparse && purpose === 'routing') {
          const pressure = projected >= routingBudget || (!locallySelected
            && values.filter((link) => !link.locallySelected).length >= routingBudget - Math.min(2, Math.max(0, routingBudget - 1)));
          const peers = values.map((link) => {
            const busy = link.serving > 0 || link.contentHandlers.size > 0;
            // One bounded protection window per link begins on first pressure,
            // not each remote request. Continuous work cannot pin a slot forever.
            if (pressure && busy && time - link.admittedAt >= NEIGHBOR_GRACE_MS && link.protectedUntil === 0) link.protectedUntil = time + TRANSFER_PROTECTION_MS;
            return { did: link.did, locallySelected: link.locallySelected, admittedAt: link.admittedAt,
              protectedUntil: link.protectedUntil, busy, rotationHeld: (rotationHolds.get(link)?.expiresAt ?? 0) > time };
          });
          peers.push(...planned.map(p=>({did:p.did,locallySelected:p.locallySelected,admittedAt:time,protectedUntil:time+10_000,busy:true,rotationHeld:false})));
          decision = { evict: undefined, ...establishedAdmission({ peers, budget: routingBudget, locallySelected, now: time, requireWitness, lastRotation:planned.some(p=>p.evict)?time:lastRotation }) };
          // why: a rendezvous outage freezes replacement, not local ownership.
          // Unsolicited links must leave exploration slots available for repair.
          if (!sparseRotation && decision.evict) decision = { allowed: false, evict: undefined };
        }
    return decision;
  };
  /** @type {Map<{release:()=>void},{did:string,locallySelected:boolean,evict?:string,victim?:Link,expiresAt:number,requireWitness:boolean,witness?:{signal:AbortSignal,validUntil:number}}>} */
  const reservedAdmissions=new Map();
  const pruneAdmissions=()=>{
    for(const [ticket,plan] of reservedAdmissions)if(now()>=plan.expiresAt || (plan.witness && (plan.witness.signal.aborted || now()>=plan.witness.validUntil)))ticket.release();
  };
  /** @param {string} did @param {{locallySelected?:boolean,signal?:AbortSignal,requireWitness?:boolean}} [options] */
  const reserveAdmission=(did,{locallySelected=false,signal,requireWitness=false}={})=>{
    pruneCooldowns();
    const decision=admissionDecision('routing',locallySelected,requireWitness);
    const unavailable=closed||signal?.aborted||isBlocked(did)||cooldowns.has(did)||did===identity.did;
    const duplicate=links.has(did)||[...reservedAdmissions.values()].some(p=>p.did===did);
    if(unavailable||duplicate||!decision.allowed){
      const values=routingLinks();
      try{audit?.('admission_reservation_refused',{reason:unavailable?'unavailable':duplicate?'duplicate':'policy',
        routingDegree:values.length,reservations:reservedAdmissions.size,locallySelected,
        oldestAgeMs:values.length?Math.max(...values.map(link=>Math.max(0,now()-link.admittedAt))):0,
        rotationAgeMs:Number.isFinite(lastRotation)?Math.max(0,now()-lastRotation):null});}catch{/* Diagnostic sinks cannot affect admission. */}
      throw new Error('room admission reservation refused');
    }
    const lifetime=new AbortController();
    let live=true;
    let detachWitness=()=>{};
    const release=()=>{if(!live)return;live=false;timers.clearTimeout(timer);signal?.removeEventListener('abort',release);
      detachWitness();reservedAdmissions.delete(ticket);lifetime.abort();};
    const expiresAt=now()+10_000;
    // The room owns signature/path validation. Once attached, this exact
    // witness can only shorten authorization; it cannot be replaced or renewed.
    /** @param {{signal:AbortSignal,validUntil:number}} witness */
    const bindWitness=(witness)=>{
      pruneAdmissions();
      const plan=reservedAdmissions.get(ticket);
      if(!live || !plan || plan.witness || !decision.evict || witness.signal.aborted
        || !Number.isFinite(witness.validUntil) || now()>=witness.validUntil)return false;
      plan.witness={signal:witness.signal,validUntil:Math.min(expiresAt,witness.validUntil)};
      witness.signal.addEventListener('abort',release,{once:true});
      detachWitness=()=>witness.signal.removeEventListener('abort',release);
      timers.clearTimeout(timer);timer=timers.setTimeout(release,plan.witness.validUntil-now());
      return true;
    };
    const ticket=Object.freeze({release,bindWitness,rotates:!!decision.evict,signal:lifetime.signal,expiresAt,victim:decision.evict??null});
    let timer=timers.setTimeout(release,10_000);
    reservedAdmissions.set(ticket,{did,locallySelected,requireWitness,evict:decision.evict,victim:decision.evict?links.get(decision.evict):undefined,expiresAt});
    signal?.addEventListener('abort',release,{once:true});
    return ticket;
  };
  // Local ownership for authenticated path witnesses. The room protocol owns
  // wire validation; sharing an edge never extends its original deadline.
  /** @param {string} did @param {{signal?:AbortSignal}} [options] */
  const holdRoutingLink = (did, {signal} = {}) => {
    pruneAdmissions();
    const time = now();
    for (const state of rotationHolds.values()) if (state.expiresAt <= time) {
      for (const release of [...state.releases]) release();
    }
    const link = links.get(did);
    if (closed || signal?.aborted || !link || link.purpose !== 'routing' || link.retired.signal.aborted || link.channel.isClosed?.()
      || rotationHoldCount >= MAX_ROTATION_HOLDS
      || [...reservedAdmissions.values()].some(plan => plan.victim === link)) throw new Error('routing hold unavailable');
    const state = rotationHolds.get(link) ?? {expiresAt:time + ROTATION_HOLD_MS, releases:new Set()};
    const lifetime = new AbortController();
    let live = true;
    const release = () => {
      if (!live) return;
      live = false; timers.clearTimeout(timer);
      signal?.removeEventListener('abort', release);
      link.retired.signal.removeEventListener('abort', release);
      state.releases.delete(release); rotationHoldCount--;
      if (!state.releases.size && rotationHolds.get(link) === state) rotationHolds.delete(link);
      lifetime.abort();
    };
    const timer = timers.setTimeout(release, state.expiresAt - time);
    state.releases.add(release); rotationHoldCount++; rotationHolds.set(link, state);
    signal?.addEventListener('abort', release, {once:true});
    link.retired.signal.addEventListener('abort', release, {once:true});
    return Object.freeze({release, signal:lifetime.signal, expiresAt:state.expiresAt});
  };
  return Object.freeze({
    roomId,
    selfDid: identity.did,
    // Enabled only after the room owner observes a negotiated public profile.
    // Sticky for this room lifetime: reconnect fallback must not erase local
    // ownership/reservations while authenticated links survive the outage.
    enableSparseAdmission: () => { sparse = true; sparseRotation = true; },
    // A rendezvous outage removes the only authoritative source of fresh
    // candidates. Keep accepting into free slots, but never evict a healthy
    // link for a replacement that may partition the remaining overlay.
    /** @param {boolean} enabled */
    setSparseRotation: (enabled) => { sparseRotation = sparse && !!enabled; },
    reserveAdmission,
    holdRoutingLink,
    locallySelectedCount: () => routingLinks().filter((link) => link.locallySelected).length,

    // Admit an AUTHENTICATED link (HELLO already done — did is proven).
    /** @param {Channel} channel @param {string} did @param {any} [info]
     * @param {{ locallySelected?: boolean, purpose?: 'routing' | 'content' | 'lookup' | 'directory', reservation?:{release:()=>void}, allowRotation?:boolean }} [ownership] */
    addLink(channel, did, info = {}, { locallySelected = false, purpose = 'routing', reservation, allowRotation = true } = {}) {
      pruneAdmissions();
      const reserved=reservation?reservedAdmissions.get(reservation):undefined;
      if(!reservation&&[...reservedAdmissions.values()].some(plan=>plan.did===did||plan.evict===did)){channel.close();return false;}
      if(reservation&&(!reserved||reserved.did!==did||reserved.locallySelected!==locallySelected||purpose!=='routing')){channel.close();return false;}
      if (!['routing', 'content', 'lookup', 'directory'].includes(purpose) || (purpose !== 'routing' && (!transferSlots || !info?.caps?.includes(purpose === 'content' ? CONTENT_ONLY : purpose === 'directory' ? DIRECTORY_INTRODUCTIONS : LOOKUP_ONLY)))) { channel.close(); return false; }
      if (closed || channel.isClosed?.() || isBlocked(did)) { channel.close(); return false; }
      pruneCooldowns();
      if (cooldowns.has(did)) {
        audit?.('peer_cooldown_refused', { did });
        channel.close();
        return false;
      }
      if (did === identity.did) { channel.close(); return false; }
      const previous = links.get(did);
      if (previous && previous.purpose !== purpose) { channel.close(); return false; }
      pruneRecentNeighbors();
      const timing = previous ?? (sparse ? recentNeighbors.get(did) : undefined);
      if (!previous) {
        const time = now();
        const victim=reserved?.evict?links.get(reserved.evict):undefined;
        const decision = reserved ? {allowed:(!reserved.evict||sparseRotation)
          &&(!reserved.evict||!reserved.requireWitness||!!reserved.witness)
          &&(!victim||victim===reserved.victim)
          &&(!!victim||(links.size<budget&&routingLinks().length<routingBudget)),evict:victim?reserved.evict:undefined} : admissionDecision(purpose,locallySelected);
        if (!decision.allowed || (decision.evict && !allowRotation)) {
          audit?.('peer_budget_refused', { did });
          channel.close();
          return false;
        }
        if (decision.evict) { lastRotation = time; removeLink(decision.evict, 'neighbor-rotation'); }
      }
      reservation?.release();
      // The room resolves crossing offers before this point. Replacement of
      // the same authenticated neighbor preserves its age and local ownership;
      // a short complete disconnect also retains only timing custody. Local
      // exploration ownership is never inherited from a retired connection.
      if (links.has(did)) removeLink(did, 'replaced');
      /** @type {Link} */
      const link = { did, channel, purpose, routingWitness:purpose==='routing'&&info?.caps?.includes(ROUTING_WITNESS)===true, leases: 0, controlPacer:createControlPacer({now,timers}), introductions: purpose === 'directory' ? createDirectoryIntroductions({now}) : undefined, locallySelected: locallySelected || previous?.locallySelected || false,
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
          timers.clearTimeout(link.expiry);
          link.retired.abort();
    link.introductions?.close();
    link.controlPacer.close();
          link.contentHandlers.clear();
          cancelVerification(link);
          try { audit?.('peer_link_closed', { did, why: 'channel-closed' }); }
          finally { if (link.purpose === 'routing') emit(goneCbs, { did, why: 'channel-closed' }); }
        }
      });
      if (links.get(did) !== link) { link.offClose(); return false; }
      channel.setHandler((/** @type {any} */ msg) => {
        handle(link, msg).catch(() => { if (links.get(did) === link) removeLink(did, 'service-or-send-failed'); });
      });
      if (links.get(did) !== link) return false;
      // why: continuous traffic cannot pin scarce temporary capacity forever.
      // The expiry belongs to this carrier generation, never to a DID alone.
      if (purpose !== 'routing') link.expiry = timers.setTimeout(() => {
        if (links.get(did) === link) removeLink(did, 'content-lifetime');
      }, CONTENT_LINK_LIFETIME_MS);
      audit?.('peer_connected', { did, room: roomId });
      if (purpose === 'routing') emit(peerCbs, { did, info });
      return true;
    },
    /** @param {string} did */
    removeLink: (did) => removeLink(did, 'removed'),
    /** @param {string} did */
    hasLink: (did) => links.get(did)?.purpose === 'routing',
    /** @param {string} did */
    hasContentLink: (did) => links.has(did) && ['routing','content'].includes(links.get(did)?.purpose ?? ''),
    /** @param {string} did */
    hasLookupLink: (did) => links.has(did) && links.get(did)?.purpose !== 'content',
    /** @param {string} did @param {any} env @param {import('./outgoing.js').SendOptions} [options] */
    async sendLookup(did, env, options) {
      const link = links.get(did);
      if (!link || link.purpose === 'content' || env?.ch !== 1 || env.t || ![0, 1].includes(env.typ)) return false;
      try { await sendOnLink(link, env, options); return true; } catch { return false; }
    },
    // Local consumers share one carrier but own separate cancellation. A
    // routing neighbor is borrowed without acquiring teardown authority.
    /** @param {string} did @param {{signal?: AbortSignal}} [options] */
    acquireContentLink: (did, {signal} = {}) => acquireScopedLink(did, 'content', signal),
    /** @param {string} did @param {{signal?:AbortSignal}} [options] */
    acquireLookupLink: (did, {signal} = {}) => acquireScopedLink(did, 'lookup', signal),
    /** @param {string} did @param {{signal?:AbortSignal}} [options] */
    acquireDirectoryLink: (did, {signal} = {}) => acquireScopedLink(did, 'directory', signal),
    /** @param {string} did */
    hasDirectoryLink: (did) => ['routing','directory'].includes(links.get(did)?.purpose ?? ''),

    // Merge telemetry onto a link (e.g. the ICE path once stats settle).
    /** @param {string} did @param {any} patch */
    tagLink(did, patch) {
      const link = links.get(did);
      if (link) link.info = { ...link.info, ...patch };
    },
    peers: () => routingLinks().map((l) => ({ did: l.did, lastSeen: l.lastSeen, info: l.info, channel: l.channel })),

    /** @param {(arg: any) => void} cb */
    onPeer: (cb) => { peerCbs.add(cb); return () => peerCbs.delete(cb); },
    /** @param {(arg: any) => void} cb */
    onPeerGone: (cb) => { goneCbs.add(cb); return () => goneCbs.delete(cb); },
    /** @param {(arg: any) => void} cb */
    onEnvelope: (cb) => { envelopeCbs.add(cb); return () => envelopeCbs.delete(cb); },
    /** @param {(arg: any) => void} cb */
    onRelay: (cb) => { relayCbs.add(cb); return () => relayCbs.delete(cb); },

    /** @param {(event:{env:any,carrier:{did:string,signal:AbortSignal,maxFrameBytes:()=>number,send:(env:any,options?:import('./outgoing.js').SendOptions)=>Promise<void>}})=>void} handler */
    onRoutingControl(handler){
      if(closed||routingControlHandler)throw new RoutingControlError();
      const owner=new AbortController();routingControlOwner=owner;routingControlHandler=handler;
      return ()=>{if(routingControlOwner===owner){routingControlHandler=null;routingControlOwner=null;owner.abort();}};
    },
    /** @param {string} did */
    routingCarrier(did){const link=links.get(did);return link?routingCarrierFor(link):null;},

    // Build-and-sign for upper layers (gossip), so the envelope shape and
    // signing stay in one place.
    sign,
    stats: () => ({ peerDegree: routingLinks().length, transferDegree: links.size - routingLinks().length, totalDegree: links.size, broadcasts: broadcasts.snapshot(),
      sends: Object.fromEntries(Object.entries(traffic).map(([name, counts]) => [name, counts.snapshot()])) }),
    send: sendTo,
    /** @param {any} env @param {string | null} [exceptDid] */
    async broadcast(env, exceptDid = null) {
      const destinations = routingLinks().map(link => link.did).filter((did) => did !== exceptDid);
      broadcasts.add('calls'); broadcasts.add('destinations', destinations.length);
      broadcasts.max('maxDestinations', destinations.length);
      await Promise.all(destinations.map((did) => sendTo(did, env)));
    },

    // "Who do you see in this room?" — the server-optional roster.
    /** @param {string} did @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts] */
    requestRoster(did, { timeoutMs = 10_000, signal } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason ?? new Error('roster cancelled'));
        const link = links.get(did);
        if (!link || !['routing','directory'].includes(link.purpose)) return reject(new Error(`requestRoster: no link to ${did}`));
        const ac = new AbortController();
        let settled = false;
        let offClose = () => {};
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        const cleanup = () => {
          clearTimeout(timer); ac.abort(); offClose();
          signal?.removeEventListener('abort', cancel);
          rosterWaiters.get(did)?.delete(settle);
          if (!rosterWaiters.get(did)?.size) rosterWaiters.delete(did);
        };
        /** @param {any} error */
        const fail = (error) => { if (!settled) { settled = true; cleanup(); reject(error); } };
        /** @param {any} members */
        const settle = (members) => { if (!settled) { settled = true; cleanup(); resolve(members); } };
        const cancel = () => fail(signal?.reason ?? new Error('roster cancelled'));
        signal?.addEventListener('abort', cancel, { once: true });
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
      if (!await sendIntroduction(via, env, { signal })) throw new Error(`relay: no link to via-peer ${via}`);
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
      for(const ticket of [...reservedAdmissions.keys()])ticket.release();
      stopTimers();
      for (const did of [...links.keys()]) removeLink(did, 'mesh-closed');
      routingControlHandler=null;routingControlOwner?.abort();routingControlOwner=null;
      cooldowns.clear();
      recentNeighbors.clear();
    },
  });
};
