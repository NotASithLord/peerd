// peerd-distributed/transport/signaling-client.js — client shell for the
// signaling reducer (the browser side of cold-start rendezvous).
//
// Two layers:
//
//   openRendezvous()      — the Phase 1 room session: join a key, get the
//                           roster, hear joins/leaves, exchange targeted
//                           opaque blobs with members. transport/rooms.js
//                           builds the mesh on this.
//   connectViaSignaling() — the 1:1 convenience: rendezvous with exactly
//                           one peer and resolve to a uniform Channel. The
//                           two-member case of the same protocol; kept for
//                           paste-code-grade flows and the demo pages.
//
// Role is deterministic (reducer contract): THE JOINER OFFERS to every
// member already present. The node only ever relays opaque SDP between
// members and forgets them.

import { createWebrtcTransport } from './transports/webrtc.js';
import { dlog, dwarn } from '../log.js';

// The bootstrap seed(s) — the rendezvous node(s) used for cold-start. This
// is a SEED, not a single point of failure: once a peer holds any room
// channel, newcomers join through that peer (mesh-assisted signaling,
// transport/mesh.js — the kill-the-server beat). The first entry is the
// default when a url isn't given.
//
// The default rendezvous. NOTE: this host must run THIS branch's worker
// (the N-peer room reducer). The older `main` worker speaks the 2-peer
// protocol (waiting/ready) the room client doesn't understand, so the
// join just times out — redeploy signaling-node/worker.js to the
// bootstrap node before relying on this default. The commons join screen
// pre-fills this (via the bridge) so it's visible + overridable; for a
// purely local run, set it to ws://localhost:8799/rendezvous and add
// `ws://localhost:*` to the dev CSP (the manifest only allows wss: today).
export const DEFAULT_SIGNALING = ['wss://bootstrap.peerd.ai/rendezvous'];

/**
 * Join a rendezvous room. Resolves once the node confirms the join (the
 * 'room' message) with a live session:
 *
 *   {
 *     self,                     // our member id at this node (opaque)
 *     members,                  // roster at join time (excl. self) — OFFER to each
 *     sendSignal(to, payload),  // relay an opaque blob to a member
 *     on(ev, cb),               // 'joined' | 'left' | 'signal' | 'closed' → unsubscribe fn
 *     close(),
 *   }
 *
 * 'signal' delivers { from, payload }. The session stays open for roster
 * updates until close() — the WS is the roster feed, not just the dance.
 *
 * @param {{ url?: string, room: string, WebSocket?: any, timeoutMs?: number }} opts
 */
export const openRendezvous = ({
  url = DEFAULT_SIGNALING[0],
  room,
  kind,                       // 'website' = observe-only visitor (own cap pool); omitted/default = extension
  WebSocket: WS = globalThis.WebSocket,
  timeoutMs = 20000,
} = {}) =>
  new Promise((resolve, reject) => {
    dlog('rendezvous', `connecting to ${url} — room "${room}"`);
    // Only append &kind for a non-default kind, so an extension's URL stays
    // byte-identical to before (the node defaults a kind-less join to extension).
    const kindQ = kind && kind !== 'extension' ? `&kind=${encodeURIComponent(kind)}` : '';
    const ws = new WS(`${url}?key=${encodeURIComponent(room)}${kindQ}`);
    // why: WebSocket.send() on a CLOSING/CLOSED socket does NOT throw — it drops
    // the frame and logs a browser warning ("WebSocket is already in CLOSING or
    // CLOSED state"). A signal or keepalive that races a drop (the bootstrap node
    // dropping mid-reconnect) would spam that. Guarding on readyState (OPEN === 1)
    // is the only thing that silences it; the dropped frame is fine — onclose
    // reconnects and the mesh carries on meanwhile.
    const wsSend = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
    const listeners = { joined: new Set(), left: new Set(), signal: new Set(), closed: new Set() };
    const emit = (ev, arg) => { for (const cb of [...listeners[ev]]) cb(arg); };

    let opened = false;
    let closed = false;
    let keepalive = null;
    const timer = setTimeout(() => {
      if (!opened) { try { ws.close(); } catch { /* ignore */ } reject(new Error('signaling: timed out before join confirm')); }
    }, timeoutMs);
    // Keep the WS warm: idle connections get reaped by NAT/proxies and the
    // rendezvous node's edge, which silently strips a node from discovery (it
    // can no longer be dialed). A periodic no-op the reducer ignores (default
    // case) resets those idle timers. rooms.js ALSO reconnects if it drops anyway.
    const KEEPALIVE_MS = 25_000;

    const session = {
      self: null,
      members: [],
      sendSignal: (to, payload) => wsSend({ t: 'signal', to, payload }),
      on: (ev, cb) => { listeners[ev].add(cb); return () => listeners[ev].delete(cb); },
      close: () => { closed = true; clearInterval(keepalive); try { ws.close(); } catch { /* ignore */ } },
    };

    ws.onerror = () => {
      // why debug, not warn: a single failed attempt is usually the expected
      // transient (CF cold start / edge reset). The error still PROPAGATES via
      // reject — the caller decides whether it's worth a warning: rooms.js
      // escalates only after a streak (a persistent outage), and dweb-base warns
      // on a hard startup failure. Warning HERE would spam the transient.
      dlog('rendezvous', `websocket error connecting to ${url} (transient? the caller escalates a real outage)`);
      if (!opened) { clearTimeout(timer); reject(new Error(`signaling: websocket error (${url})`)); }
    };
    ws.onclose = () => {
      clearTimeout(timer);
      clearInterval(keepalive);
      if (!opened) { dlog('rendezvous', 'closed before join confirm (transient? the caller escalates a real outage)'); reject(new Error('signaling: closed before join confirm')); }
      else if (!closed) { dlog('rendezvous', 'node connection closed — reconnecting; mesh survives meanwhile'); emit('closed', undefined); }
    };

    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)); }
      catch { return; }
      switch (m.t) {
        case 'full':
          clearTimeout(timer);
          dwarn('rendezvous', `room "${room}" reported FULL. With real peers this means STALE/ghost connections piled up `
            + 'on the rendezvous node (reloads that never cleanly closed). Fix: try a fresh room code, or restart the '
            + 'node — the server now reaps dead connections on each join, so this should self-heal.');
          return reject(new Error(`signaling: room "${room}" is full (likely stale connections — try a fresh room code)`));
        case 'room':
          opened = true;
          clearTimeout(timer);
          keepalive = setInterval(() => wsSend({ t: 'ping' }), KEEPALIVE_MS);
          session.self = m.self;
          session.members = m.members ?? [];
          dlog('rendezvous', `JOINED room "${room}" as ${m.self} — ${session.members.length} member(s) already here:`, session.members);
          return resolve(session);
        case 'joined': dlog('rendezvous', `peer ${m.member} JOINED the room`); return emit('joined', m.member);
        case 'left': dlog('rendezvous', `peer ${m.member} LEFT the room`); return emit('left', m.member);
        case 'signal': dlog('rendezvous', `SIGNAL from ${m.from}`); return emit('signal', { from: m.from, payload: m.payload });
        default: return;
      }
    };
  });

/**
 * 1:1 rendezvous → a uniform Channel (the two-member case). The joiner
 * that finds a member present offers; the one that joined an empty room
 * answers the first offer that arrives. Resolves { channel, role,
 * transport }; the WS closes once the channel is up (no roster needed).
 */
export const connectViaSignaling = async ({
  url = DEFAULT_SIGNALING[0],
  room,
  transport,
  sameMachine = false,
  iceServers,
  WebSocket: WS = globalThis.WebSocket,
  timeoutMs = 20000,
} = {}) => {
  const t = transport ?? createWebrtcTransport({ iceServers });
  const session = await openRendezvous({ url, room, WebSocket: WS, timeoutMs });

  // why a deadline across the whole dance: openRendezvous only bounds the
  // join confirm; a peer that never answers must not hang the caller.
  let timer;
  const deadline = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('signaling: timed out before connect')), timeoutMs);
  });

  // A buffering trickle signaling channel bound to one peer member: relays
  // outbound payloads, routes inbound session 'signal's from that member
  // (filling `member` lazily for the responder, who learns it from the
  // first offer). Buffers until the transport registers onRemote.
  const makeSignaling = () => {
    let member = null;
    let handler = null;
    const buffer = [];
    const off = session.on('signal', ({ from, payload }) => {
      if (member && from !== member) return;
      if (!member) member = from; // responder: lock to the first offerer
      if (handler) handler(payload); else buffer.push(payload);
    });
    return {
      setMember: (m) => { member = m; },
      dispose: off,
      signaling: {
        send: (payload) => { if (member) session.sendSignal(member, payload); },
        onRemote: (h) => { handler = h; while (buffer.length) h(buffer.shift()); return () => { handler = null; }; },
      },
    };
  };

  const dance = (async () => {
    const sig = makeSignaling();
    if (session.members.length > 0) {
      // A member is present → we are the joiner → we offer (to the first;
      // 1:1 callers use single-purpose room codes).
      sig.setMember(session.members[0]);
      const channel = await t.connect({ did: room }, { sameMachine, iceServers, signaling: sig.signaling });
      return { channel, role: 'initiator', transport: 'webrtc' };
    }
    // Room was empty → wait for the first inbound payload (an offer), which
    // also locks the signaling to that member, then answer it (trickle).
    const offer = await new Promise((res) => {
      const off = session.on('signal', ({ payload }) => { off(); res(payload); });
    });
    const { channel } = await t.accept({ offer, sameMachine, iceServers, signaling: sig.signaling });
    return { channel: await channel, role: 'responder', transport: 'webrtc' };
  })();

  try {
    return await Promise.race([dance, deadline]);
  } finally {
    clearTimeout(timer);
    session.close();
  }
};
