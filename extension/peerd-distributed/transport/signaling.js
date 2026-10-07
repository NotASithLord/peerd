// @ts-check
// peerd-distributed/transport/signaling.js — cold-start rendezvous reducer.
//
// The ONE piece of "server" logic peerd needs, written ONCE as a pure
// reducer and run in whatever shell is reachable: the browser (as a
// client), a Bun/Node host, or a Cloudflare Worker + Durable Object. Same
// code, many shells — "peerd is the runtime, server-side, when it needs to
// be." There is no second implementation to drift or re-audit; a shell is
// ~the socket plumbing that feeds this reducer events and runs its actions.
//
// A rendezvous node does exactly one thing: let peers that have NO existing
// connection find each other under a `key` (a room code) and relay OPAQUE
// blobs between members so they can open direct channels — then forget
// them. It never inspects or logs the payload — that's the SDP, and not
// logging it is the PROTOCOL §9 privacy commitment, enforced here by the
// reducer simply never reading `payload`.
//
// Legacy/private rooms hold a bounded complete roster. The
// node hands each joiner the current roster and notifies members of
// joins/leaves; SDP relay is TARGETED (`to` a member id). Roles are
// deterministic: THE JOINER INITIATES (offers) toward every member already
// present — an existing member never offers to a joiner, so offer/offer
// "glare" is structurally impossible. The old 2-peer dance is just the
// two-member case of this protocol (pre-release: the old protocol was
// replaced, not kept — DECISIONS #17 ethos).
//
// A negotiated public profile instead separates server membership from local
// degree: bounded random introductions and lease-limited samples replace global
// roster broadcasts. Legacy peers can share that public room using ordinary
// room replies. No client opts in until neighbor maintenance is implemented.
//
// Member ids are the shell's connIds: opaque, per-connection, meaningless
// outside the node. Identity (did:key) is established peer-to-peer by the
// signed HELLO after the data channel opens — the rendezvous never learns
// or relays identity, only socket-local labels.
//
// Pure: signalingStep(state, event) -> { state, actions }. State is plain
// JSON (room rosters, kinds, and last-sample timestamps); the shell owns sockets, TTLs, and
// executing `actions`. That purity is exactly why the same logic tests
// deterministically in Bun and runs unchanged on the edge.
//
// Events (shell → reducer):
//   { t:'join',   connId, key }           peer wants to rendezvous at `key`
//   { t:'signal', connId, to, payload }   opaque blob to relay to member `to`
//   { t:'leave',  connId }                peer disconnected
//   { t:'sample', connId, requestId }      enrolled public peer requests candidates
// Actions (reducer → shell):
//   { t:'send',  connId, msg }            deliver msg to this connection
//   { t:'close', connId }                 drop this connection
//
// Wire messages a CLIENT receives (the `msg` in 'send' actions):
//   { t:'room', self, members:[…] }   joined; your id + roster (excl. you).
//                                     OFFER to each member listed.
//   { t:'joined', member }            someone joined; await their offer
//   { t:'left', member }              a member disconnected
//   { t:'signal', from, payload }     a member's relayed (opaque) blob
//   { t:'full' }                      the room is at capacity

// why 16: full-mesh rooms stay honest to ~10 peers (NORTH-STAR D-9); 16
// leaves headroom for churn without pretending this is a stadium protocol.
export const ROOM_CAP = 16;
// Website visitors (the peerd.ai live widget) are observe-only and get their
// OWN small pool, so they never consume a real extension's slot. A join's
// `kind` defaults to 'extension' (the full participant) when omitted, so the
// old wire (no kind) still behaves exactly as before.
export const WEBSITE_CAP = 4;
// why: membership is a server resource budget, independent of a browser's
// established-neighbor degree. Only negotiated public peers use this pool.
// Kind/profile are untrusted labels, not authenticated identity or Sybil defense.
export const SPARSE_PUBLIC_PROFILE = 'sparse-public-v1';
export const PUBLIC_ROOM = 'peerd/base/1';
export const PUBLIC_MEMBERSHIP_CAP = 1024;
export const INTRODUCTION_LIMIT = 16;
export const SAMPLE_INTERVAL_MS = 10_000;
/** @param {unknown} key @param {unknown} profile */
export const sparsePublicProfile = (key, profile) =>
  key === PUBLIC_ROOM && profile === SPARSE_PUBLIC_PROFILE ? SPARSE_PUBLIC_PROFILE : null;

/** @param {string[]} members @param {() => number} random */
const sampleMembers = (members, random) => {
  const sample = members.slice(0, INTRODUCTION_LIMIT);
  // Reservoir sampling avoids an arrival-order monopoly without allocating
  // another full roster. The shell supplies entropy; client bytes never do.
  for (let index = sample.length; index < members.length; index++) {
    const pick = Math.floor(random() * (index + 1));
    if (pick >= 0 && pick < sample.length) sample[pick] = members[index];
  }
  return sample;
};
/**
 * @typedef {'extension' | 'website'} Kind
 * @typedef {{ rooms: Record<string, string[]>, kinds: Record<string, Kind>, sparse?: Record<string, number> }} SignalingState
 * @typedef {{ t: string, connId: string, key?: string, kind?: string, to?: string, payload?: any, profile?: string, requestId?: unknown }} SignalingEvent
 * @typedef {{ t: 'send', connId: string, msg: any } | { t: 'close', connId: string }} SignalingAction
 */

/** @type {Record<Kind, number>} */
const CAP_BY_KIND = { extension: ROOM_CAP, website: WEBSITE_CAP };
/**
 * @param {string | undefined} k
 * @returns {Kind}
 */
const kindOf = (k) => (k === 'website' ? 'website' : 'extension');

/**
 * @param {Record<string, string[]>} rooms
 * @param {string} connId
 */
const roomKeyOf = (rooms, connId) => {
  for (const [key, members] of Object.entries(rooms)) {
    if (members.includes(connId)) return key;
  }
  return null;
};

/** @returns {SignalingState} */
export const initialSignalingState = () => ({ rooms: {}, kinds: {} });

/**
 * @param {SignalingState} state
 * @param {SignalingEvent} event
 * @param {{ now?: number, random?: () => number }} [clock]
 * @returns {{ state: SignalingState, actions: SignalingAction[] }}
 */
export const signalingStep = (state, event, { now = 0, random = () => 0 } = {}) => {
  const rooms = { ...state.rooms };
  const kinds = { ...(state.kinds ?? {}) };
  const sparse = { ...(state.sparse ?? {}) };
  const isSparse = (/** @type {string} */ id) => Object.hasOwn(sparse, id);
  /** @type {SignalingAction[]} */
  const actions = [];
  /** @param {string} connId @param {any} msg */
  const send = (connId, msg) => actions.push({ t: 'send', connId, msg });

  switch (event && event.t) {
    case 'join': {
      const { connId } = event;
      // why cast: a 'join' event always carries a room key (the wire shape);
      // the union typedef makes it optional for the other event kinds.
      const key = /** @type {string} */ (event.key);
      const kind = kindOf(event.kind);
      if (typeof key !== 'string' || !key || roomKeyOf(rooms, connId)) break;
      const members = Object.hasOwn(rooms, key) ? rooms[key] : [];
      const profile = kind === 'website' ? null : sparsePublicProfile(key, event.profile);
      const mixed = key === PUBLIC_ROOM && (profile || members.some(isSparse));
      // Per-kind cap: a joiner only competes for slots of its OWN kind, so
      // website observers (cap 4) can never push an extension (cap 16) out,
      // and vice versa. The roster itself stays a flat connId list.
      // Retain the legacy pools inside the combined hard ceiling. Sparse
      // occupancy cannot take their reserved admission capacity.
      const sameKind = members.filter((c) => !isSparse(c) && (kinds[c] ?? 'extension') === kind).length;
      if ((key === PUBLIC_ROOM && members.length >= PUBLIC_MEMBERSHIP_CAP)
        || (profile && members.filter(isSparse).length >= PUBLIC_MEMBERSHIP_CAP - ROOM_CAP - WEBSITE_CAP)
        || (!profile && sameKind >= CAP_BY_KIND[kind])) {
        send(connId, { t: 'full' });
        actions.push({ t: 'close', connId });
        break;
      }
      Object.defineProperty(rooms, key, { value: [...members, connId], enumerable: true, configurable: true, writable: true });
      kinds[connId] = kind;
      if (profile) sparse[connId] = now;
      const introductions = mixed ? sampleMembers(members, random) : members;
      // Legacy peers understand the ordinary room response. New peers must
      // observe explicit acknowledgment before using the sampling protocol.
      send(connId, { t: 'room', self: connId, members: introductions,
        ...(profile ? { profile, sampleLimit: INTRODUCTION_LIMIT, sampleIntervalMs: SAMPLE_INTERVAL_MS } : {}) });
      for (const m of introductions) send(m, { t: 'joined', member: connId });
      break;
    }
    case 'sample': {
      const { connId, requestId } = event;
      if (roomKeyOf(rooms, connId) !== PUBLIC_ROOM || !isSparse(connId)
        || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)
        || !Number.isFinite(now) || now - sparse[connId] < SAMPLE_INTERVAL_MS) break;
      sparse[connId] = now;
      send(connId, { t: 'sample', requestId,
        members: sampleMembers(rooms[PUBLIC_ROOM].filter((id) => id !== connId), random) });
      break;
    }
    case 'signal': {
      const { connId, to, payload } = event;
      const key = roomKeyOf(rooms, connId);
      if (!key) break;
      // Targeted relay, room-scoped: `to` must be a CURRENT member of the
      // sender's own room (and not the sender). Anything else is dropped
      // silently — a stale/forged target must not become a probe.
      if (!to || to === connId || !rooms[key].includes(to)) break;
      send(to, { t: 'signal', from: connId, payload }); // opaque — never inspected
      break;
    }
    case 'leave': {
      const { connId } = event;
      const key = roomKeyOf(rooms, connId);
      if (!key) break;
      // Decide before deletion: removing the last sparse member must not
      // suddenly fan its departure out to the whole mixed roster.
      const mixed = key === PUBLIC_ROOM && rooms[key].some(isSparse);
      delete kinds[connId];
      delete sparse[connId];
      const remaining = rooms[key].filter((c) => c !== connId);
      if (remaining.length === 0) {
        delete rooms[key];
      } else {
        rooms[key] = remaining;
        // Public neighbors detect channel loss themselves; broadcasting every
        // departure would reintroduce linear per-client churn traffic.
        if (!mixed) for (const c of remaining) send(c, { t: 'left', member: connId });
      }
      break;
    }
    default:
      break;
  }

  return { state: { rooms, kinds, ...(Object.keys(sparse).length ? { sparse } : {}) }, actions };
};
