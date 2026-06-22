// peerd signaling node — Bun shell.
//
// "peerd is the runtime, server-side." This is a server peerd: it runs the
// SAME signalingStep reducer the browser client and the Cloudflare Worker
// use (../extension/peerd-distributed/transport/signaling.js). This file
// is only the shell — it binds a WebSocket, feeds the reducer events, and
// runs the reducer's actions. Zero signaling logic of its own.
//
//   run:  bun signaling-node/bun-server.mjs        (override: PORT=9000 bun …)
//   dial: ws://localhost:8799/rendezvous?key=<room>
//
// Locally runnable with no cloud account — the exact same reducer that the
// edge Worker runs, so "test on Bun, deploy on Workers" is one codebase.
//
// VERBOSE by default (every join/leave/signal/reap with room sizes) so the
// terminal IS the troubleshooting view. The Bun node is the easiest way to
// see what the rendezvous is doing — far more visible than `wrangler tail`.

import {
  signalingStep,
  initialSignalingState,
} from '../extension/peerd-distributed/transport/signaling.js';

// PORT unset → the default 8799; PORT=0 → an OS-chosen ephemeral port (the
// test harness uses this and reads the real port off the "listening" log line).
// A bare `|| 8799` would wrongly treat 0 as "unset" and re-pin 8799.
const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 8799;
const T = '\x1b[35m[dweb-rendezvous]\x1b[0m'; // magenta tag — the d-module color

// DoS guards (shell-level; the reducer caps a room at ROOM_CAP members).
// SDP offer/answer blobs are a few KB; 64 KiB is generous. We set it as the
// runtime maxPayloadLength too, so an oversized frame is rejected before the
// runtime buffers it (the in-handler check is then belt-and-suspenders /
// parse-time guard). A peer sending faster than the rate limit is flooding —
// close it.
const MAX_MSG_BYTES = 64 * 1024;
const MSG_RATE_LIMIT = 120;          // messages …
const MSG_RATE_WINDOW_MS = 10_000;   // … per 10s window, per connection

let state = initialSignalingState();
const conns = new Map(); // connId -> ServerWebSocket
let nextId = 1;

const roster = (key) => state.rooms[key] ?? [];

// Apply the reducer's actions against real sockets. Note we never read the
// relayed `payload` — same privacy posture as the protocol requires.
const apply = (actions) => {
  for (const a of actions) {
    const ws = conns.get(a.connId);
    if (!ws) continue;
    if (a.t === 'send') {
      ws.send(JSON.stringify(a.msg));
    } else if (a.t === 'close') {
      // Drop the shell bookkeeping inline (parity with worker.js): a peer
      // the reducer kicks (over ROOM_CAP) is never added to a room, so the
      // reducer state is already clean; if the runtime doesn't fire `close`
      // on a server-initiated close, this is what frees the conns entry.
      ws.close();
      conns.delete(a.connId);
    }
  }
};
const step = (event) => {
  const r = signalingStep(state, event);
  state = r.state;
  apply(r.actions);
  return r.actions;
};

// Reap connections the runtime already considers closed/closing but whose
// `close` event never fired (the failure that silently fills a room with
// dead connIds across reloads). Runs before every new join, so a fresh
// joiner never inherits a roster full of ghosts. readyState: 0 CONNECTING,
// 1 OPEN, 2 CLOSING, 3 CLOSED.
const reapDead = () => {
  let reaped = 0;
  for (const [connId, ws] of [...conns]) {
    const rs = ws.readyState;
    if (rs === 2 || rs === 3) {
      step({ t: 'leave', connId });
      conns.delete(connId);
      reaped += 1;
    }
  }
  if (reaped) console.log(`${T} 🧹 reaped ${reaped} dead connection(s)`);
  return reaped;
};

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname !== '/rendezvous') {
      return new Response('peerd signaling node', { status: 200 });
    }
    const key = url.searchParams.get('key');
    if (!key) return new Response('missing ?key', { status: 400 });
    // 'website' = observe-only visitor (own cap pool); omitted/default = extension.
    const kind = url.searchParams.get('kind') === 'website' ? 'website' : 'extension';
    if (server.upgrade(req, { data: { connId: String(nextId++), key, kind } })) return undefined;
    return new Response('expected websocket', { status: 426 });
  },
  websocket: {
    // Reject oversized frames at the runtime layer (before buffering).
    maxPayloadLength: MAX_MSG_BYTES,
    open(ws) {
      const { connId, key, kind } = ws.data;
      ws.data.windowStart = Date.now();
      ws.data.msgCount = 0;
      reapDead(); // clear ghosts BEFORE this join is counted
      conns.set(connId, ws);
      const actions = step({ t: 'join', connId, key, kind });
      const full = actions.some((a) => a.t === 'send' && a.msg?.t === 'full');
      if (full) {
        console.log(`${T} 🚫 FULL — rejected ${connId} (room "${key}" already at cap with [${roster(key).join(', ')}])`);
      } else {
        console.log(`${T} ➕ JOIN ${connId} → room "${key}" — now ${roster(key).length}: [${roster(key).join(', ')}]`);
      }
    },
    message(ws, raw) {
      const size = typeof raw === 'string' ? raw.length : (raw?.byteLength ?? 0);
      if (size > MAX_MSG_BYTES) { ws.close(1009, 'message too large'); return; }
      const now = Date.now();
      if (now - ws.data.windowStart > MSG_RATE_WINDOW_MS) {
        ws.data.windowStart = now; ws.data.msgCount = 0;
      }
      if (++ws.data.msgCount > MSG_RATE_LIMIT) { ws.close(1008, 'rate limit exceeded'); return; }
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m && m.t === 'signal') {
        // `to` is the target member id; the reducer enforces room scoping.
        console.log(`${T} 🔁 SIGNAL ${ws.data.connId} → ${m.to} (opaque ${typeof m.payload === 'object' && m.payload?.type ? m.payload.type : '?'})`);
        step({ t: 'signal', connId: ws.data.connId, to: m.to, payload: m.payload });
      }
    },
    close(ws) {
      const { connId, key } = ws.data;
      step({ t: 'leave', connId });
      conns.delete(connId);
      console.log(`${T} ➖ LEAVE ${connId} → room "${key}" — now ${roster(key).length}: [${roster(key).join(', ')}]`);
    },
  },
});

// why server.port (not PORT): a caller may pass PORT=0 for an ephemeral port
// (the two-peer test harness does) — print the ACTUAL bound port so it can read
// it back, instead of probing-then-binding (a TOCTOU race on the port).
console.log(`${T} listening — ws://localhost:${server.port}/rendezvous?key=<room>  (verbose; Ctrl-C to stop)`);
