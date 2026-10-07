// peerd signaling node — Bun shell.
//
// "peerd is the runtime, server-side." This is a server peerd: it runs the
// SAME signalingStep reducer the browser client and the Cloudflare Worker
// use (../extension/peerd-distributed/transport/signaling.js). This file
// is only the shell — it binds a WebSocket, feeds the reducer events, and
// runs the reducer's actions. Aggregate admission is Bun process-local.
//
//   run:  bun signaling-node/bun-server.mjs        (override: PORT=9000 bun …)
//   dial: ws://localhost:8799/rendezvous?key=<room>
//
// Locally runnable with no cloud account — the exact same reducer that the
// edge Worker runs. Bun aggregate quotas do not imply Worker budget parity.
//
// Logs contain only the listening address, never signaling payloads.

import {
  signalingStep,
  initialSignalingState, sparsePublicProfile,
} from '../extension/peerd-distributed/transport/signaling.js';

import { createAdmissionBudget, validRoomKey } from './admission-budget.js';

const MAX_MSG_BYTES = 64 * 1024;
const MSG_RATE_LIMIT = 120;
const MSG_RATE_WINDOW_MS = 10_000;
const utf8 = new TextEncoder();
const decoder = new TextDecoder();

// Factory injection exists for deterministic policy tests, not remote runtime
// configuration. Worker hibernation/account-wide quotas are separate work.
/** @param {{ port?: number, hostname?: string, limits?: any, now?: ()=>number,
 * random?: ()=>number, parse?: (raw:string)=>any, serve?: typeof Bun.serve, log?: (text:string)=>void }} [options] */
export const createSignalingServer = ({ port = 8799, hostname, limits, now = Date.now,
  random = Math.random, parse = JSON.parse, serve = Bun.serve, log = console.log } = {}) => {
  const budget = createAdmissionBudget({ now, limits });
  let state = initialSignalingState();
  const conns = new Map();
  let nextId = 1, cleanupErrors = 0;

  // Serialization is bounded by the ingress cap and reducer action limits.
  // Reserve the entire batch before state admission or any recipient sees it.
  const prepare = (key, actions, control) => {
    const encoded = actions.map(action => action.t === 'send'
      ? { ...action, text: JSON.stringify(action.msg) } : action);
    let frames = 0, bytes = 0;
    for (const action of encoded) if (action.t === 'send') { frames++; bytes += utf8.encode(action.text).byteLength; }
    return budget.egress(key, frames, bytes, control) ? encoded : null;
  };
  // Failed recipients are retired iteratively. A room-wide departure can
  // discover more failed sockets, but never recursively grow the JS stack or
  // retain a quadratic queue of encoded departure batches.
  const retirements = new Map();
  let applying = 0, draining = false;
  const drain = () => {
    if (applying || draining) return;
    draining = true;
    try {
      while (retirements.size) {
        const [ws, code] = retirements.entries().next().value;
        retirements.delete(ws);
        try { cleanup(ws); }
        finally { try { ws.close(code, code === 1013 ? 'bootstrap overloaded' : ''); } catch { /* already gone */ } }
      }
    } finally { draining = false; }
  };
  const apply = actions => {
    applying++;
    try {
      for (const action of actions) {
        const ws = conns.get(action.connId);
        if (!ws || ws.data.retired || retirements.has(ws)) continue;
        if (action.t === 'send') {
          // Bun returns zero for a dropped write; -1 means buffered and remains
          // subject to its independently configured native backpressure limit.
          try { if (ws.send(action.text) === 0) retire(ws, 1013); }
          catch { retire(ws, 1013); }
        } else if (action.t === 'close') retire(ws, 1000);
      }
    } finally { applying--; drain(); }
  };
  const cleanup = ws => {
    if (ws.data.retired) return;
    ws.data.retired = true;
    conns.delete(ws.data.connId);
    try {
      // Departure state always commits, even if its notices lack credit.
      // Retain accounting custody until the final cleanup batch is reserved.
      if (ws.data.admitted) {
        const result = signalingStep(state, { t: 'leave', connId: ws.data.connId });
        state = result.state;
        const encoded = prepare(ws.data.key, result.actions, true);
        if (encoded) apply(encoded);
      }
    } catch { cleanupErrors++; } // custody release must survive failed notice accounting
    finally { ws.data.release(); }
  };
  const retire = (ws, code) => {
    if (ws.data.retired || retirements.has(ws)) return;
    retirements.set(ws, code);
    drain();
  };
  const step = (ws, event) => {
    const result = signalingStep(state, event, { now: now(), random });
    const encoded = prepare(ws.data.key, result.actions, event.t === 'join');
    if (!encoded) { retire(ws, 1013); return; }
    state = result.state;
    if (event.t === 'join') ws.data.admitted = (state.rooms[ws.data.key] ?? []).includes(ws.data.connId);
    apply(encoded);
  };
  const reapDead = () => {
    for (const ws of [...conns.values()]) if (ws.readyState === 2 || ws.readyState === 3) cleanup(ws);
  };
  const overloaded = () => new Response('bootstrap overloaded', {
    status: 503, headers: { 'Retry-After': String(budget.retryAfter()) },
  });
  const server = serve({
    port, ...(hostname ? { hostname } : {}),
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname !== '/rendezvous') return new Response('peerd signaling node');
      if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
      const key = url.searchParams.get('key');
      if (!validRoomKey(key)) return new Response('invalid room key', { status: 400 });
      // Bound room counter allocation and roster reaping before native upgrade.
      if (!budget.join(key)) return overloaded();
      reapDead();
      const release = budget.reserveSocket(key);
      if (!release) return overloaded();
      const kind = url.searchParams.get('kind') === 'website' ? 'website' : 'extension';
      const profile = kind === 'website' ? null : sparsePublicProfile(key, url.searchParams.get('profile'));
      let upgraded = false;
      try {
        upgraded = server.upgrade(req, { data: { connId: String(nextId++), key, kind, profile,
          release, retired: false, admitted: false, windowStart: now(), msgCount: 0 } });
        if (upgraded) return undefined;
        return new Response('expected websocket', { status: 426 });
      } finally { if (!upgraded) release(); }
    },
    websocket: {
      maxPayloadLength: MAX_MSG_BYTES,
      // Native queues are independently bounded; frame/window quotas alone do
      // not bound a slow recipient's buffered writes.
      backpressureLimit: 256 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        conns.set(ws.data.connId, ws);
        step(ws, { t: 'join', connId: ws.data.connId, key: ws.data.key, kind: ws.data.kind, profile: ws.data.profile });
      },
      message(ws, raw) {
        if (ws.data.retired || !ws.data.admitted) return;
        if (typeof raw !== 'string' && !ArrayBuffer.isView(raw) && !(raw instanceof ArrayBuffer)) { retire(ws, 1003); return; }
        let size = typeof raw === 'string' ? raw.length : raw.byteLength;
        if (size > MAX_MSG_BYTES) { retire(ws, 1009); return; }
        if (typeof raw === 'string') size = utf8.encode(raw).byteLength;
        if (size > MAX_MSG_BYTES) { retire(ws, 1009); return; }
        const time = now();
        if (time - ws.data.windowStart > MSG_RATE_WINDOW_MS) { ws.data.windowStart = time; ws.data.msgCount = 0; }
        if (++ws.data.msgCount > MSG_RATE_LIMIT) { retire(ws, 1008); return; }
        // Even malformed/unsupported JSON consumes room AND process credit.
        // No message parse or dispatch follows refusal; departure cleanup remains.
        if (!budget.ingress(ws.data.key, size)) { retire(ws, 1013); return; }
        let message;
        try { message = parse(typeof raw === 'string' ? raw : decoder.decode(raw)); } catch { return; }
        if (message && (message.t === 'signal' || message.t === 'sample')) {
          step(ws, { t: message.t, connId: ws.data.connId, to: message.to, payload: message.payload, requestId: message.requestId });
        }
      },
      close: cleanup,
    },
  });
  log(`[dweb-rendezvous] listening: ws://localhost:${server.port}/rendezvous?key=<room>`);
  return {
    server,
    stats: () => ({ ...budget.stats(), connections: conns.size, cleanupErrors,
      memberships: Object.values(state.rooms).reduce((sum, members) => sum + members.length, 0) }),
    stop() { for (const ws of [...conns.values()]) retire(ws, 1001); server.stop(true); },
  };
};

if (import.meta.main) createSignalingServer({
  port: process.env.PORT !== undefined ? Number(process.env.PORT) : 8799,
});
