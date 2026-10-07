// peerd signaling node — Cloudflare Worker + Durable Object shell.
//
// The edge counterpart of bun-server.mjs. It runs the SAME signalingStep
// reducer (../extension/peerd-distributed/transport/signaling.js) — this
// file is only the shell that maps WebSocket + Durable Object IO onto the
// reducer's events/actions. One reducer, two shells; no duplicated logic.
//
// Topology: each rendezvous `key` maps to one Durable Object instance
// (idFromName(key)) — DOs are single-instance per id, so every member of a
// room lands on the same object, which is exactly the rendezvous primitive we
// need. The reducer owns separate legacy and negotiated public membership
// budgets; rooms remain ephemeral.
//
// WebSocket Hibernation (HIBERNATION-SPEC.md): the sockets are handed to the
// runtime via `ctx.acceptWebSocket`, so the DO can be evicted while idle and
// re-instantiated on the next event WITH its sockets intact. That removes the
// cold-start / idle-eviction resets that surfaced in the client as
// "websocket error connecting" / "closed before join confirm". Because the DO
// heap can vanish between events, NOTHING per-connection lives in instance
// memory: the roster is DERIVED from the live socket set on every event
// (getWebSockets), and per-connection bookkeeping rides each socket's
// serialized attachment. The reducer is the source of truth for the protocol;
// its state is rebuilt from the sockets each step (the room is just "who's
// connected"), never persisted across a wake.
//
// Deploy needs YOUR Cloudflare account (BYOC): `wrangler dev` runs it
// locally; `wrangler deploy` ships it. The Bun shell is the no-account
// equivalent for local testing (a long-lived process, so no hibernation).

import {
  signalingStep, sparsePublicProfile, PUBLIC_ROOM,
} from '../extension/peerd-distributed/transport/signaling.js';

// DoS guards complement the reducer's membership and sampling budgets.
// SDP blobs are a few KB; flooding faster than the rate limit closes the
// socket. Mirrors bun-server.mjs. The rate-limit window rides the socket
// attachment, so it survives hibernation (a wake doesn't reset it).
const MAX_MSG_BYTES = 64 * 1024;
const utf8 = new TextEncoder();
const MSG_RATE_LIMIT = 120;          // messages …
const MSG_RATE_WINDOW_MS = 10_000;   // … per 10s window, per connection

// The single room key: the DO instance IS the room (idFromName(key)), so the
// reducer's key dimension collapses to a constant inside one object.
const ROOM = 'room';

export class SignalingRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Answer the client keepalive ({t:'ping'}, every 25s) at the EDGE so an
    // idle room is never woken just to pong — the main cost saver hibernation
    // unlocks. The client ignores unknown {t:'pong'}. (HIBERNATION-SPEC §4.)
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'),
    );
  }

  // --- per-connection state, recovered from the socket (survives a wake) ---
  #att(ws) { try { return ws.deserializeAttachment() || {}; } catch { return {}; } }
  #connId(ws) { return this.#att(ws).connId; }
  #socket(connId) { const m = this.ctx.getWebSockets(connId); return m && m[0]; }
  // Reconstruct negotiated state only from server-stamped attachments. Old
  // attachments remain legacy; a profile on a private key is never sufficient.
  #state(exclude, departed) {
    const sockets = this.ctx.getWebSockets().filter((ws) => ws.readyState === 1 && this.#connId(ws) !== exclude);
    if (departed) sockets.push(departed);
    const attachments = sockets.map((ws) => this.#att(ws)).filter((a) => a.connId && a.admitted !== false);
    const key = attachments.some((a) => a.key === PUBLIC_ROOM) ? PUBLIC_ROOM : ROOM;
    const kinds = {}, sparse = {};
    for (const a of attachments) {
      kinds[a.connId] = a.kind || 'extension';
      if (sparsePublicProfile(a.key, a.profile) && a.kind !== 'website') sparse[a.connId] = a.lastSampleAt ?? 0;
    }
    return { rooms: { [key]: attachments.map((a) => a.connId) }, kinds, sparse };
  }

  #step(state, event) {
    const result = signalingStep(state, event, { now: Date.now(), random: Math.random });
    // Admission and the sampling lease must be durable before a reply escapes.
    // A failed close cannot enroll a rejected socket. A wake
    // cannot grant a fresh burst or turn an unacknowledged profile into one.
    const ws = this.#socket(event.connId);
    if (ws && event.t === 'join') {
      const admitted = Object.values(result.state.rooms).some((members) => members.includes(event.connId));
      ws.serializeAttachment({ ...this.#att(ws), admitted });
    }
    if (ws && Object.hasOwn(result.state.sparse ?? {}, event.connId)) {
      ws.serializeAttachment({ ...this.#att(ws), lastSampleAt: result.state.sparse[event.connId] });
    }
    this.#dispatch(result.actions);
    return result.actions;
  }

  // The roster IS the set of OPEN sockets' connIds. Deriving it (rather than
  // holding a map) is what makes hibernation safe: a wake rebuilds it for free,
  // and ghosts (sockets workerd considers CLOSING/CLOSED whose `close` never
  // fired) are excluded by the readyState filter, so they can't silently fill
  // a ROOM_CAP slot. `exclude` drops one connId (e.g. the joiner, or a leaver).
  #roster(exclude) {
    return this.ctx.getWebSockets()
      .filter((ws) => ws.readyState === 1) // 1 = OPEN; drop CONNECTING/CLOSING/CLOSED
      .filter((ws) => this.#att(ws).admitted !== false)
      .map((ws) => this.#connId(ws))
      .filter((c) => c && c !== exclude);
  }

  // Run one reducer step against a roster rebuilt from the sockets, then
  // dispatch its actions to the sockets resolved by connId tag.
  #dispatch(actions) {
    for (const a of actions) {
      const ws = this.#socket(a.connId);
      if (!ws) continue;
      if (a.t === 'send') {
        try { ws.send(JSON.stringify(a.msg)); } catch { /* socket gone */ }
      } else if (a.t === 'close') {
        // A reducer 'close' is an over-ROOM_CAP kick; the peer was never added
        // to the roster, so closing the socket is the whole cleanup.
        try { ws.close(); } catch { /* already closing */ }
      }
    }
  }

  // Reducer 'leave' for connId: notify the remaining members. We rebuild the
  // room as {remaining ∪ connId} so roomKeyOf finds it, then the reducer drops
  // connId; only legacy-only rooms broadcast the departure.
  #leave(ws) {
    const connId = this.#connId(ws);
    this.#step(this.#state(connId, ws), { t: 'leave', connId });
  }

  // Close + announce sockets workerd already considers closed/closing but whose
  // `close` never fired. With the readyState-filtered roster these no longer
  // leak a room slot, but reaping still frees the socket and tells members
  // they left. Runs before each new join (over getWebSockets, not a map).
  #reapDead() {
    let reaped = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const rs = ws.readyState; // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
      if (rs === 2 || rs === 3) {
        const connId = this.#connId(ws);
        try { ws.close(); } catch { /* no-op */ }
        if (connId) this.#leave(ws);
        reaped += 1;
      }
    }
    if (reaped) console.log(`[dweb-rendezvous] 🧹 reaped ${reaped} dead connection(s)`);
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const u = new URL(req.url);
    const roomName = u.searchParams.get('key') ?? '?';
    // 'website' = an observe-only visitor (own small cap pool); anything else
    // (including omitted) is a full extension peer. Stamped on the socket so the
    // per-kind cap survives a hibernation wake.
    const kind = u.searchParams.get('kind') === 'website' ? 'website' : 'extension';
    const key = roomName === PUBLIC_ROOM ? PUBLIC_ROOM : ROOM;
    const profile = kind === 'website' ? null : sparsePublicProfile(roomName, u.searchParams.get('profile'));
    const { 0: client, 1: server } = new WebSocketPair();
    // Full entropy prevents connection-label collisions at larger occupancy;
    // this opaque label is not an authenticated peer identity.
    const connId = crypto.randomUUID();

    this.#reapDead(); // clear ghosts BEFORE this join is counted

    // Hand the socket to the runtime (it survives DO eviction); tag it by
    // connId for O(1) lookup, and stash the per-connection bookkeeping the
    // hibernation handlers will need (they can't close over locals).
    this.ctx.acceptWebSocket(server, [connId]);
    server.serializeAttachment({ connId, kind, key, profile, admitted: false, windowStart: Date.now(), msgCount: 0 });

    // Existing members = the live roster excluding the socket we just accepted;
    // kind/profile drive the independent pools and combined membership cap.
    const state = this.#state(connId);
    // A first public join has no attachment from which to recover its key.
    state.rooms = { [key]: Object.values(state.rooms)[0] };
    const actions = this.#step(state, { t: 'join', connId, key, kind, profile });

    const full = actions.some((a) => a.t === 'send' && a.msg?.t === 'full');
    if (full) {
      console.log(`[dweb-rendezvous] 🚫 FULL — rejected ${kind} ${connId} (room "${roomName}" ${kind} pool at cap)`);
    } else {
      const r = this.#roster();
      console.log(`[dweb-rendezvous] ➕ JOIN ${connId} → room "${roomName}": now ${r.length}`);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- Hibernation handlers (DO methods, called on a possibly fresh heap) ----

  async webSocketMessage(ws, data) {
    const att = this.#att(ws);
    const connId = att.connId;
    if (!connId || ws.readyState !== 1 || att.admitted === false) return; // retired / lost its tag

    let size = typeof data === 'string' ? data.length : (data?.byteLength ?? 0);
    // UTF-16 code units undercount non-ASCII wire bytes. Reject obviously huge
    // strings before encoding, and enforce the actual UTF-8 limit before parse.
    if (typeof data === 'string' && size <= MAX_MSG_BYTES) size = utf8.encode(data).byteLength;
    if (size > MAX_MSG_BYTES) { try { ws.close(1009, 'message too large'); } catch { /* */ } return; }

    // Per-connection rate limit, persisted on the socket so it holds across a
    // wake. Re-instantiation preserves the current window exactly.
    const now = Date.now();
    let windowStart = att.windowStart ?? now;
    let msgCount = att.msgCount ?? 0;
    if (now - windowStart > MSG_RATE_WINDOW_MS) { windowStart = now; msgCount = 0; }
    msgCount += 1;
    // The attachment is the durable connection identity, not just rate state.
    // Dropping kind here moves website visitors into the extension pool on the
    // next event, including after a hibernation wake.
    ws.serializeAttachment({ ...att, windowStart, msgCount });
    if (msgCount > MSG_RATE_LIMIT) { try { ws.close(1008, 'rate limit exceeded'); } catch { /* */ } return; }

    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m && (m.t === 'signal' || m.t === 'sample')) {
      this.#step(this.#state(), { t: m.t, connId, to: m.to, payload: m.payload, requestId: m.requestId });
    }
    // {t:'ping'} is answered at the edge by the auto-response — no wake, no work.
  }

  async webSocketClose(ws) {
    const connId = this.#connId(ws);
    if (!connId) return;
    this.#leave(ws);
    const r = this.#roster(connId);
    console.log(`[dweb-rendezvous] ➖ LEAVE ${connId}: now ${r.length}`);
  }

  async webSocketError(ws) {
    const connId = this.#connId(ws);
    if (connId) this.#leave(ws);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/rendezvous') {
      return new Response('peerd signaling node', { status: 200 });
    }
    const key = url.searchParams.get('key');
    if (!key) return new Response('missing ?key', { status: 400 });
    const id = env.SIGNAL_ROOM.idFromName(key);
    return env.SIGNAL_ROOM.get(id).fetch(req);
  },
};
