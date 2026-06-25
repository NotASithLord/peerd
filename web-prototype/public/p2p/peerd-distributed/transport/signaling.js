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
// PHASE 1 (NORTH-STAR D-9): rooms hold up to ROOM_CAP members, not 2. The
// node hands each joiner the current roster and notifies members of
// joins/leaves; SDP relay is TARGETED (`to` a member id). Roles are
// deterministic: THE JOINER INITIATES (offers) toward every member already
// present — an existing member never offers to a joiner, so offer/offer
// "glare" is structurally impossible. The old 2-peer dance is just the
// two-member case of this protocol (pre-release: the old protocol was
// replaced, not kept — DECISIONS #17 ethos).
//
// Member ids are the shell's connIds: opaque, per-connection, meaningless
// outside the node. Identity (did:key) is established peer-to-peer by the
// signed HELLO after the data channel opens — the rendezvous never learns
// or relays identity, only socket-local labels.
//
// Pure: signalingStep(state, event) -> { state, actions }. State is plain
// JSON (a map of key -> [connId, …]); the shell owns sockets, TTLs, and
// executing `actions`. That purity is exactly why the same logic tests
// deterministically in Bun and runs unchanged on the edge.
//
// Events (shell → reducer):
//   { t:'join',   connId, key }           peer wants to rendezvous at `key`
//   { t:'signal', connId, to, payload }   opaque blob to relay to member `to`
//   { t:'leave',  connId }                peer disconnected
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
const CAP_BY_KIND = { extension: ROOM_CAP, website: WEBSITE_CAP };
const kindOf = (k) => (k === 'website' ? 'website' : 'extension');

const roomKeyOf = (rooms, connId) => {
  for (const [key, members] of Object.entries(rooms)) {
    if (members.includes(connId)) return key;
  }
  return null;
};

export const initialSignalingState = () => ({ rooms: {}, kinds: {} });

export const signalingStep = (state, event) => {
  const rooms = { ...state.rooms };
  const kinds = { ...(state.kinds ?? {}) };
  const actions = [];
  const send = (connId, msg) => actions.push({ t: 'send', connId, msg });

  switch (event && event.t) {
    case 'join': {
      const { connId, key } = event;
      const kind = kindOf(event.kind);
      const members = rooms[key] ?? [];
      if (members.includes(connId)) break; // idempotent
      // Per-kind cap: a joiner only competes for slots of its OWN kind, so
      // website observers (cap 4) can never push an extension (cap 16) out,
      // and vice versa. The roster itself stays a flat connId list.
      const sameKind = members.filter((c) => (kinds[c] ?? 'extension') === kind).length;
      if (sameKind >= CAP_BY_KIND[kind]) {
        send(connId, { t: 'full' });
        actions.push({ t: 'close', connId });
        break;
      }
      rooms[key] = [...members, connId];
      kinds[connId] = kind;
      // Joiner gets the roster (it offers to each); members get the join.
      send(connId, { t: 'room', self: connId, members });
      for (const m of members) send(m, { t: 'joined', member: connId });
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
      delete kinds[connId];
      const remaining = rooms[key].filter((c) => c !== connId);
      if (remaining.length === 0) {
        delete rooms[key];
      } else {
        rooms[key] = remaining;
        for (const c of remaining) send(c, { t: 'left', member: connId });
      }
      break;
    }
    default:
      break;
  }

  return { state: { rooms, kinds }, actions };
};
