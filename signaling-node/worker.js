// peerd signaling node — Cloudflare Worker + Durable Object shell.
//
// Each rendezvous key maps to one Durable Object via idFromName(key). The
// shared signalingStep reducer remains the source of protocol behavior;
// the shell owns WebSocket IO, durable admission and resource custody.
//
// Hibernation can discard the heap while sockets remain attached. Membership
// is therefore reconstructed from OPEN sockets and server-stamped attachments,
// including legacy kind and negotiated sampling leases. Aggregate room credit
// cannot live on sockets: departures would otherwise replenish the allowance.
// Its independent durable record survives both socket churn and fresh heaps.
//
// This is not a cross-room/account quota or a deployment/activation mechanism.
// The rendezvous relays opaque signaling blobs without inspecting/logging SDP
// or accepting a claimed DID as identity. Authentication happens peer-to-peer.
import { signalingStep, sparsePublicProfile, PUBLIC_ROOM, PUBLIC_MEMBERSHIP_CAP } from '../extension/peerd-distributed/transport/signaling.js';
import { validRoomKey } from './admission-budget.js';
import { createDurableRoomBudget } from './durable-room-budget.js';

const MAX_MSG_BYTES = 64 * 1024;
const MSG_RATE_LIMIT = 120;
const MSG_RATE_WINDOW_MS = 10_000;
const MAX_PENDING = 8;
const MAX_PENDING_BYTES = MAX_PENDING * MAX_MSG_BYTES;
const ROOM = 'room';
const utf8 = new TextEncoder();

export class SignalingRoom {
  #queue = [];
  #running = false;
  #pending = 0;
  #pendingBytes = 0;
  #retired = new WeakSet();
  #custodyFailed = false;
  /** @param {any} ctx @param {any} env @param {{now?:()=>number, limits?:Record<string,number>, parse?:(data:any)=>any, attachedLimit?:number}} [options] */
  constructor(ctx, env, { now = Date.now, limits, parse = JSON.parse, attachedLimit = PUBLIC_MEMBERSHIP_CAP } = {}) {
    if (!Number.isSafeInteger(attachedLimit) || attachedLimit < 1 || attachedLimit > PUBLIC_MEMBERSHIP_CAP) {
      throw new Error('invalid attached socket ceiling');
    }
    this.ctx = ctx;
    this.env = env;
    this.now = now;
    this.parse = parse;
    this.attachedLimit = attachedLimit;
    this.budget = createDurableRoomBudget(ctx.storage, { now, limits });
    // Runtime auto-responses deliberately avoid waking the object. They bypass
    // these application quotas; transport/account abuse controls are separate.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  #att(ws) {
    try { return ws.deserializeAttachment() || {}; }
    catch { return {}; }
  }
  #live(ws) {
    const att = this.#att(ws);
    return !this.#custodyFailed && ws.readyState === 1 && !this.#retired.has(ws)
      && !att.retired && att.admitted !== false && !!att.connId;
  }
  #socket(id) { return this.ctx.getWebSockets(id)?.[0]; }
  // The roster is derived from runtime-owned OPEN sockets, never a heap map.
  // Old attachments remain legacy; only a server-stamped public key/profile
  // can restore sparse membership. Closing or rejected sockets own no slot.
  // A departure snapshot temporarily restores only the leaver so the reducer
  // can produce its existing legacy notification behavior.
  #state(departed) {
    const attachments = this.ctx.getWebSockets().filter(ws => this.#live(ws)).map(ws => this.#att(ws));
    if (departed?.admitted !== false && departed?.connId) attachments.push(departed);
    const key = attachments.some(a => a.key === PUBLIC_ROOM) ? PUBLIC_ROOM : ROOM;
    const kinds = {}, sparse = {};
    for (const a of attachments) {
      kinds[a.connId] = a.kind || 'extension';
      if (sparsePublicProfile(a.key, a.profile) && a.kind !== 'website') sparse[a.connId] = a.lastSampleAt ?? 0;
    }
    return { rooms: { [key]: attachments.map(a => a.connId) }, kinds, sparse };
  }

  // Serialize the complete operation, not only its debit: a reducer snapshot
  // must not cross another operation's admission while awaiting egress credit.
  // This bounds application-held work, not Cloudflare's runtime ingress buffers.
  #work(bytes, run, refused) {
    if (this.#custodyFailed || this.#pending >= MAX_PENDING || bytes > MAX_PENDING_BYTES - this.#pendingBytes) {
      return Promise.resolve(refused());
    }
    this.#pending++;
    this.#pendingBytes += bytes;
    const result = new Promise(resolve => this.#queue.push({ bytes, run, refused, resolve }));
    void this.#drain();
    return result;
  }
  async #drain() {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length) {
        const task = this.#queue.shift();
        try { task.resolve(this.#custodyFailed ? task.refused() : await task.run()); }
        catch { task.resolve(task.refused()); }
        finally {
          this.#pending--;
          this.#pendingBytes -= task.bytes;
        }
      }
    } finally { this.#running = false; }
  }
  #overloaded() { return new Response('bootstrap overloaded', { status: 503 }); }

  // Retirement precedes native close, including close callbacks that reenter.
  // A single bounded notice task preserves legacy departure behavior; failures
  // discovered by its dispatch append work instead of recursively broadcasting.
  #retire(ws, code = 1013) {
    const att = this.#att(ws);
    if (this.#retired.has(ws) || att.retired) return null;
    this.#retired.add(ws);
    let attachmentFailed = false;
    try { ws.serializeAttachment({ ...att, admitted: false, retired: true }); }
    catch { attachmentFailed = true; }
    const reason = code === 1013 ? 'bootstrap overloaded'
      : code === 1008 ? 'rate limit exceeded'
      : code === 1009 ? 'message too large' : '';
    try { ws.close(code, reason); }
    catch {
      // If BOTH platform custody operations fail, this heap refuses all future
      // work. Residual sockets still count against the attached ceiling. This
      // is not a proof of retirement across a wake: native runtime acceptance
      // must establish what a failed attachment write/close actually means.
      if (attachmentFailed) this.#custodyFailed = true;
    }
    return this.#work(0, () => this.#notice(att), () => {});
  }
  // Encode/reserve the entire outbound batch before committing a join or
  // sampling lease. A failed send consumes its debit; it cannot refill credit.
  async #prepare(actions, control) {
    const encoded = actions.map(a => a.t === 'send' ? { ...a, text: JSON.stringify(a.msg) } : a);
    let frames = 0, bytes = 0;
    for (const action of encoded) {
      if (action.t === 'send') {
        frames++;
        bytes += utf8.encode(action.text).byteLength;
      }
    }
    return await this.budget.egress(frames, bytes, control) ? encoded : null;
  }
  #dispatch(actions) {
    for (const a of actions) {
      if (this.#custodyFailed) return;
      const ws = this.#socket(a.connId);
      if (!ws || ws.readyState !== 1 || this.#retired.has(ws) || this.#att(ws).retired) continue;
      if (a.t === 'send') {
        try { ws.send(a.text); } catch { this.#retire(ws); }
      } else if (a.t === 'close') this.#retire(ws, 1000);
    }
  }
  async #step(ws, event, join = false) {
    const state = this.#state();
    if (join) state.rooms = { [event.key]: Object.values(state.rooms)[0] };
    const result = signalingStep(state, event, { now: this.now(), random: Math.random });
    const actions = await this.#prepare(result.actions, join);
    // The socket can retire synchronously while its storage debit is pending.
    const att = this.#att(ws);
    if (this.#custodyFailed || ws.readyState !== 1 || this.#retired.has(ws) || att.retired || (!join && !this.#live(ws))) return;
    if (!actions) {
      this.#retire(ws);
      return;
    }
    const next = { ...att };
    if (join) next.admitted = Object.values(result.state.rooms).some(members => members.includes(event.connId));
    if (Object.hasOwn(result.state.sparse ?? {}, event.connId)) next.lastSampleAt = result.state.sparse[event.connId];
    ws.serializeAttachment(next);
    this.#dispatch(actions);
  }
  async #notice(departed) {
    if (!departed?.connId || departed.admitted === false) return;
    const result = signalingStep(this.#state(departed), { t: 'leave', connId: departed.connId });
    const actions = await this.#prepare(result.actions, true);
    if (actions) this.#dispatch(actions);
  }

  async fetch(req) {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    const u = new URL(req.url);
    const roomName = u.searchParams.get('key');
    if (!validRoomKey(roomName)) return new Response('invalid room key', { status: 400 });
    // The untrusted website label selects its separate pool, never identity.
    const kind = u.searchParams.get('kind') === 'website' ? 'website' : 'extension';
    const key = roomName === PUBLIC_ROOM ? PUBLIC_ROOM : ROOM;
    const profile = kind === 'website' ? null : sparsePublicProfile(roomName, u.searchParams.get('profile'));
    return this.#work(0, async () => {
      // Debit before socket-pair creation, roster reconstruction or reaping.
      if (!await this.budget.join()) return this.#overloaded();
      const attached = this.ctx.getWebSockets();
      for (const ws of attached) {
        if (ws.readyState === 2 || ws.readyState === 3) this.#retire(ws, 1000);
      }
      // Count physical custody, not only reducer membership. Retired sockets
      // whose native close stalls must not accumulate through successive windows.
      if (this.#custodyFailed || attached.length >= this.attachedLimit) return this.#overloaded();
      const { 0: client, 1: server } = new WebSocketPair();
      const connId = crypto.randomUUID();
      try {
        this.ctx.acceptWebSocket(server, [connId]);
        server.serializeAttachment({ connId, kind, key, profile, admitted: false, windowStart: this.now(), msgCount: 0 });
        await this.#step(server, { t: 'join', connId, key, kind, profile }, true);
        return new Response(null, { status: 101, webSocket: client });
      } catch {
        this.#retire(server);
        return this.#overloaded();
      }
    }, () => this.#overloaded());
  }

  async webSocketMessage(ws, data) {
    if (!this.#live(ws)) return;
    if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) { this.#retire(ws, 1003); return; }
    let size = typeof data === 'string' ? data.length : data.byteLength;
    if (typeof data === 'string' && size <= MAX_MSG_BYTES) size = utf8.encode(data).byteLength;
    if (size > MAX_MSG_BYTES) { this.#retire(ws, 1009); return; }
    return this.#work(size, async () => {
      if (!this.#live(ws)) return;
      // Per-connection rate state remains on its attachment across a wake,
      // independently of the room-wide durable record. Preserve kind/profile.
      const att = this.#att(ws);
      const time = this.now();
      let windowStart = att.windowStart ?? time;
      let msgCount = att.msgCount ?? 0;
      if (time - windowStart > MSG_RATE_WINDOW_MS) { windowStart = time; msgCount = 0; }
      ws.serializeAttachment({ ...att, windowStart, msgCount: ++msgCount });
      if (msgCount > MSG_RATE_LIMIT) { this.#retire(ws, 1008); return; }
      if (!await this.budget.ingress(size)) {
        this.#retire(ws);
        return;
      }
      if (!this.#live(ws)) return;
      let m;
      try { m = this.parse(data); } catch { return; }
      if (m && (m.t === 'signal' || m.t === 'sample')) {
        await this.#step(ws, { t: m.t, connId: att.connId, to: m.to, payload: m.payload, requestId: m.requestId });
      }
    }, () => { this.#retire(ws); });
  }
  async webSocketClose(ws) {
    await this.#retire(ws, 1000);
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/rendezvous') return new Response('peerd signaling node');
    const key = url.searchParams.get('key');
    if (!validRoomKey(key)) return new Response('invalid room key', { status: 400 });
    const id = env.SIGNAL_ROOM.idFromName(key);
    return env.SIGNAL_ROOM.get(id).fetch(req);
  },
};
