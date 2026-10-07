// @ts-check
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
import { SPARSE_PUBLIC_PROFILE, INTRODUCTION_LIMIT, SAMPLE_INTERVAL_MS, sparsePublicProfile } from './rendezvous-profile.js';

export class SignalingError extends Error {
  /** @param {string} message */
  constructor(message) { super(`signaling: ${message}`); this.name = 'SignalingError'; }
}

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
 * @param {{ url?: string, room?: string, kind?: string, WebSocket?: any, timeoutMs?: number, profile?: string, signal?: AbortSignal, now?: () => number, timers?: any }} [opts]
 * @returns {Promise<RendezvousSession>}
 *
 * @typedef {'joined' | 'left' | 'signal' | 'closed'} RendezvousEvent
 * @typedef {{
 *   profile: string | null,
 *   sample: (opts?: {signal?: AbortSignal}) => Promise<string[]>,
 *   self: string | null,
 *   members: string[],
 *   sendSignal: (to: string, payload: any) => void,
 *   on: (ev: RendezvousEvent, cb: (arg: any) => void) => (() => void),
 *   close: () => void,
 * }} RendezvousSession
 */
export const openRendezvous = ({
  url = DEFAULT_SIGNALING[0], room, kind, WebSocket: WS = globalThis.WebSocket,
  timeoutMs = 20000, profile, signal, now = Date.now, timers = globalThis,
} = {}) =>
  /** @type {Promise<RendezvousSession>} */ (new Promise((resolve, reject) => {
    const requested = kind === 'website' ? null : sparsePublicProfile(room, profile);
    if (signal?.aborted) { reject(new SignalingError('cancelled')); return; }
    const kindQ = kind && kind !== 'extension' ? `&kind=${encodeURIComponent(kind)}` : '';
    const profileQ = requested ? `&profile=${requested}` : '';
    const ws = new WS(`${url}?key=${encodeURIComponent(/** @type {string} */ (room))}${kindQ}${profileQ}`);
    /** @type {Record<RendezvousEvent, Set<(arg: any) => void>>} */
    const listeners = { joined: new Set(), left: new Set(), signal: new Set(), closed: new Set() };
    /** @param {RendezvousEvent} event @param {any} value */
    const emit = (event, value) => { for (const cb of [...listeners[event]]) cb(value); };
    let opened = false, ended = false;
    let sequence = 0, nextSampleAt = Infinity;
    /** @type {any} */
    let keepalive;
    /** @type {{ id: string, resolve: (members: string[]) => void, reject: (error: Error) => void, timer: any, detach: () => void } | null} */
    let pending = null;
    /** @param {Error | null} error @param {string[]} [members] */
    const finishSample = (error, members = []) => {
      const request = pending;
      if (!request) return;
      pending = null;
      timers.clearTimeout(request.timer);
      request.detach();
      if (error) request.reject(error); else request.resolve(members);
    };
    /** @param {Error} error @param {boolean} [notify] */
    const end = (error, notify = true) => {
      if (ended) return;
      ended = true;
      timers.clearTimeout(joinTimer);
      timers.clearInterval(keepalive);
      signal?.removeEventListener('abort', cancel);
      finishSample(error);
      try { ws.close(); } catch { /* already gone */ }
      try {
        if (!opened) reject(error);
        else if (notify) emit('closed', undefined);
      } finally { for (const callbacks of Object.values(listeners)) callbacks.clear(); }
    };
    const cancel = () => end(new SignalingError('cancelled'));
    /** @param {any} message */
    const send = (message) => {
      if (ended || ws.readyState !== 1) throw new SignalingError('connection closed');
      ws.send(JSON.stringify(message));
    };
    /** @param {unknown} id */
    const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 512;
    /** @param {any} value @param {number} limit @param {string | null} self */
    const validMembers = (value, limit, self) => Array.isArray(value) && value.length <= limit
      && value.every((id) => validId(id) && id !== self) && new Set(value).size === value.length;
    /** @type {RendezvousSession} */
    const session = {
      profile: null, self: null, members: [],
      sendSignal: (to, payload) => send({ t: 'signal', to, payload }),
      on: (event, callback) => { if (!ended) listeners[event].add(callback); return () => listeners[event].delete(callback); },
      close: () => end(new SignalingError('connection closed'), false),
      sample: ({ signal: requestSignal } = {}) => {
        if (ended || requestSignal?.aborted) return Promise.reject(new SignalingError('cancelled'));
        if (session.profile !== SPARSE_PUBLIC_PROFILE) return Promise.reject(new SignalingError('sampling unavailable'));
        if (pending) return Promise.reject(new SignalingError('sample already pending'));
        if (now() < nextSampleAt) return Promise.reject(new SignalingError('sample cooldown'));
        return new Promise((sampleResolve, sampleReject) => {
          const id = `sample-${++sequence}`;
          const abort = () => finishSample(new SignalingError('sample cancelled'));
          pending = { id, resolve: sampleResolve, reject: sampleReject,
            timer: timers.setTimeout(() => finishSample(new SignalingError('sample timed out')), timeoutMs),
            detach: () => requestSignal?.removeEventListener('abort', abort) };
          requestSignal?.addEventListener('abort', abort, { once: true });
          // Charge attempts, including failures: remote silence never accelerates
          // retries. One request/timer is retained, regardless of caller pressure.
          nextSampleAt = now() + SAMPLE_INTERVAL_MS;
          try { send({ t: 'sample', requestId: id }); } catch (error) { finishSample(/** @type {Error} */ (error)); }
        });
      },
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const joinTimer = timers.setTimeout(() => end(new SignalingError('timed out before join confirm')), timeoutMs);
    ws.onerror = () => end(new SignalingError(`websocket error (${url})`));
    ws.onclose = () => end(new SignalingError('connection closed'));
    ws.onmessage = (/** @type {MessageEvent} */ event) => {
      if (ended) return;
      if (typeof event.data !== 'string' && (!(event.data instanceof ArrayBuffer) && !ArrayBuffer.isView(event.data)
        || event.data.byteLength > 64 * 1024)) {
        end(new SignalingError('unsupported or oversized response')); return;
      }
      let text;
      try { text = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data); }
      catch { end(new SignalingError('invalid response encoding')); return; }
      if (text.length > 64 * 1024 || new TextEncoder().encode(text).byteLength > 64 * 1024) {
        end(new SignalingError('oversized response')); return;
      }
      let message;
      try { message = JSON.parse(text); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (message.t === 'room' && !opened) {
        const acknowledged = message.profile === SPARSE_PUBLIC_PROFILE;
        if (!validId(message.self) || !validMembers(message.members, acknowledged ? INTRODUCTION_LIMIT : 20, message.self)
          || (message.profile != null && (!requested || !acknowledged))
          || (acknowledged && (message.sampleLimit !== INTRODUCTION_LIMIT || message.sampleIntervalMs !== SAMPLE_INTERVAL_MS))) {
          end(new SignalingError('invalid room response')); return;
        }
        opened = true;
        timers.clearTimeout(joinTimer);
        session.self = message.self;
        session.members = message.members;
        session.profile = acknowledged ? SPARSE_PUBLIC_PROFILE : null;
        nextSampleAt = now() + SAMPLE_INTERVAL_MS;
        keepalive = timers.setInterval(() => { try { send({ t: 'ping' }); } catch { end(new SignalingError('keepalive failed')); } }, 25_000);
        resolve(session);
      } else if (message.t === 'full' && !opened) end(new SignalingError(`room "${room}" is at capacity`));
      else if (message.t === 'sample' && pending && message.requestId === pending.id) {
        if (!validMembers(message.members, INTRODUCTION_LIMIT, session.self)) end(new SignalingError('invalid sample response'));
        else finishSample(null, message.members);
      } else if (opened && (message.t === 'joined' || message.t === 'left') && validId(message.member)) emit(message.t, message.member);
      else if (opened && message.t === 'signal' && validId(message.from) && message.from !== session.self) emit('signal', { from: message.from, payload: message.payload });
    };
  }));

/**
 * 1:1 rendezvous → a uniform Channel (the two-member case). The joiner
 * that finds a member present offers; the one that joined an empty room
 * answers the first offer that arrives. Resolves { channel, role,
 * transport }; the WS closes once the channel is up (no roster needed).
 */
/**
 * @param {{
 *   url?: string, room?: string, transport?: any, sameMachine?: boolean,
 *   iceServers?: RTCIceServer[], WebSocket?: any, timeoutMs?: number,
 * }} [opts]
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
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const deadline = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('signaling: timed out before connect')), timeoutMs);
  });

  // A buffering trickle signaling channel bound to one peer member: relays
  // outbound payloads, routes inbound session 'signal's from that member
  // (filling `member` lazily for the responder, who learns it from the
  // first offer). Buffers until the transport registers onRemote.
  const makeSignaling = () => {
    /** @type {string | null} */
    let member = null;
    /** @type {((payload: any) => void) | null} */
    let handler = null;
    /** @type {any[]} */
    const buffer = [];
    const off = session.on('signal', (/** @type {{ from: string, payload: any }} */ { from, payload }) => {
      if (member && from !== member) return;
      if (!member) member = from; // responder: lock to the first offerer
      if (handler) handler(payload); else buffer.push(payload);
    });
    return {
      /** @param {string} m */
      setMember: (m) => { member = m; },
      dispose: off,
      signaling: {
        /** @param {any} payload */
        send: (payload) => { if (member) session.sendSignal(member, payload); },
        /** @param {(payload: any) => void} h */
        onRemote: (h) => { handler = h; while (buffer.length) h(buffer.shift()); return () => { handler = null; }; },
      },
    };
  };

  // why ac: when `deadline` wins the race below (the peer never pairs), the
  // in-flight t.connect/t.accept pc is abandoned — abort closes it (the D2 leak
  // the rooms.js sites also fix). The transport ignores the abort once the
  // channel has opened, so aborting in finally never harms a live link.
  const ac = new AbortController();
  const dance = (async () => {
    const sig = makeSignaling();
    if (session.members.length > 0) {
      // A member is present → we are the joiner → we offer (to the first;
      // 1:1 callers use single-purpose room codes).
      sig.setMember(session.members[0]);
      const channel = await t.connect({ did: room }, { sameMachine, iceServers, signaling: sig.signaling, signal: ac.signal });
      return { channel, role: 'initiator', transport: 'webrtc' };
    }
    // Room was empty → wait for the first inbound payload (an offer), which
    // also locks the signaling to that member, then answer it (trickle).
    const offer = await new Promise((res) => {
      const off = session.on('signal', (/** @type {{ payload: any }} */ { payload }) => { off(); res(payload); });
    });
    const { channel } = await t.accept({ offer, sameMachine, iceServers, signaling: sig.signaling, signal: ac.signal });
    return { channel: await channel, role: 'responder', transport: 'webrtc' };
  })();

  try {
    return await Promise.race([dance, deadline]);
  } finally {
    ac.abort();
    clearTimeout(timer);
    session.close();
  }
};
