// @ts-check
// a2a-dispatch.js — the mesh-op dispatcher + the ask/reply CORRELATION. This is
// the imperative heart the SW `a2a/call` route runs: it turns a translated mesh
// op (from a2a-api.js) into a real mesh action, and — for `ask` — implements the
// request/response protocol over the mesh's fire-and-forget DMs.
//
// Functional core / imperative shell: every IO surface (sendDm, listPeers,
// publishCard, fetchCard) is INJECTED, so the correlation (tag a request, await
// the matching reply, time out) is unit-testable with fakes — no live mesh.
//
// The wire tag: every a2a DM carries `{ __a2a: 1, kind, reqId, message }` on the
// reserved peerd-agent room's direct channel. `kind:'ask'` is a request (the
// remote agent should answer), `kind:'reply'` carries the answer back keyed by
// the same reqId, `kind:'tell'` is a fire-and-forget notification. An inbound
// 'reply' resolves a pending local ask (never wakes the actor); an inbound
// 'ask'/'tell' is delivered to the actor (the fenced wake) — see handleInbound.

/**
 * @typedef {{ __a2a: 1, kind: 'ask'|'reply'|'tell', reqId: string, message: string, convId?: string }} A2AEnvelope
 *   `convId` (optional) threads a STANDING conversation: an ask/tell that
 *   carries one continues an existing thread on the peer's side, and the
 *   reply carries it back. Absent = the legacy single-shot exchange.
 */

/** @param {unknown} d @returns {d is A2AEnvelope} */
export const isA2AEnvelope = (d) =>
  !!d && typeof d === 'object'
  && /** @type {any} */ (d).__a2a === 1
  && typeof (/** @type {any} */ (d).kind) === 'string'
  && typeof (/** @type {any} */ (d).reqId) === 'string';

/**
 * @param {Object} deps
 * @param {(toDid: string, envelope: A2AEnvelope) => Promise<{ ok: boolean, id?: string, error?: string }>} deps.sendDm
 *   Send one direct message on the peerd-agent room (offscreen op:'dm').
 * @param {() => Promise<Array<{ did: string, name?: string }>>} deps.listPeers
 * @param {(did: string) => Promise<any | null>} deps.fetchCard   fetch a peer's advertised card
 * @param {(card: object) => Promise<{ ok: boolean, did?: string, error?: string }>} deps.publishCard
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.newReqId]
 * @param {number} [deps.defaultTimeoutMs]
 * @param {ReturnType<typeof import('./conversation-registry.js').createConversationRegistry> | null} [deps.conversations]
 *   The standing-conversation registry; absent → converse/say are refused.
 */
export const makeMeshDispatch = (deps) => {
  const {
    sendDm, listPeers, fetchCard, publishCard,
    now = Date.now, newReqId, defaultTimeoutMs = 30_000,
    // The standing-conversation registry (conversation-registry.js), injected
    // so converse/say correlation is testable. Absent → those ops are refused
    // (the base single-shot ask/send/tell surface still works without it).
    conversations = null,
  } = deps;

  // reqId → { resolve, timer, did } for asks awaiting a reply. Lives across the
  // single a2a_run worker call (the worker relays each op to the SW; the pending
  // map is SW-side so a reply that lands after the op returns still resolves it).
  // why `did`: a reply is bound to the peer the ask was SENT to — an inbound
  // 'reply' is only honored when its authenticated mesh sender equals that did,
  // so a third peer who guesses/observes a reqId can't forge the answer.
  /** @type {Map<string, { resolve: (v: any) => void, timer: any, did: string, convId?: string }>} */
  const pendingAsks = new Map();
  // Inbound a2a messages (ask/tell) received during a run, drained by inbox().
  // Bounded: a spamming peer can flood DMs, but the buffer is capped and evicts
  // oldest-first so it can never grow without limit on the keepalive-pinned SW.
  const MAX_INBOX = 200;
  /** @type {Array<{ from: string, message: string, ts: number, reqId: string, kind: string }>} */
  let inboxBuffer = [];

  let idSeq = 0;
  const mkReqId = newReqId ?? (() => `a2a-${now().toString(36)}-${(idSeq += 1).toString(36)}`);

  /**
   * Send an ask DM and await the peer's ONE matching reply (or time out). The
   * shared core of ask/converse/say — the only difference between them is
   * whether a convId rides along and whether the registry records the turns.
   * @param {string} did @param {string} message @param {string} [convId] @param {number} [timeoutMs] @param {AbortSignal} [signal]
   */
  const sendAndAwait = async (did, message, convId, timeoutMs, signal) => {
    if (signal?.aborted) return { ok: false, error: 'a2a: aborted before send' };
    const reqId = mkReqId();
    const env = /** @type {A2AEnvelope} */ ({ __a2a: 1, kind: 'ask', reqId, message });
    if (convId) env.convId = convId;
    const sent = await sendDm(did, env);
    if (!sent?.ok) return { ok: false, error: sent?.error ?? 'ask: could not reach the peer' };
    if (signal?.aborted) return { ok: false, error: 'a2a: aborted after send' };
    const ms = typeof timeoutMs === 'number' ? timeoutMs : defaultTimeoutMs;
    return await new Promise((resolve) => {
      /** @param {any} value */
      const finish = (value) => {
        clearTimeout(timer);
        pendingAsks.delete(reqId);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish({ ok: false, error: 'a2a: aborted while awaiting reply' });
      const timer = setTimeout(() => finish({ ok: true, from: null, reply: null, timedOut: true }), ms);
      pendingAsks.set(reqId, { resolve: finish, timer, did, convId });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };

  /**
   * Run one translated op. `ctx.confirmedDids` is the set the SW has already
   * cleared for first-contact (signing ops to an un-cleared did are refused
   * HERE so the gate can't be bypassed by the worker).
   * @param {string} op @param {any} args
   * @param {{ signs?: boolean, allowed?: (did: string) => boolean, signal?: AbortSignal }} [ctx]
   * @returns {Promise<{ ok: boolean, error?: string } & Record<string, any>>}
   */
  const dispatch = async (op, args, ctx = {}) => {
    if (ctx.signal?.aborted) return { ok: false, error: 'a2a: run aborted' };
    // First-contact gate: a signing op to a peer the user hasn't cleared is
    // refused. The SW resolves consent BEFORE calling dispatch and passes
    // ctx.allowed; a missing allowed fn fails CLOSED for signing ops.
    if (ctx.signs && args?.did) {
      const ok = typeof ctx.allowed === 'function' ? ctx.allowed(args.did) : false;
      if (!ok) return { ok: false, error: `a2a: not permitted to message ${args.did} (first contact needs the user's ok)` };
    }
    switch (op) {
      case 'peers': {
        const peers = await listPeers();
        return { ok: true, peers: peers.map((p) => ({ did: p.did, ...(p.name ? { name: p.name } : {}) })) };
      }
      case 'card': {
        const card = await fetchCard(args.did).catch(() => null);
        return { ok: true, card: card ?? null };
      }
      case 'publishCard': {
        if (ctx.signal?.aborted) return { ok: false, error: 'a2a: run aborted before publish' };
        const r = await publishCard(args.card);
        return r?.ok ? { ok: true, ...(r.did ? { did: r.did } : {}) } : { ok: false, error: r?.error ?? 'publishCard failed' };
      }
      case 'send': {
        if (ctx.signal?.aborted) return { ok: false, error: 'a2a: run aborted before cast' };
        const r = await sendDm(args.did, { __a2a: 1, kind: 'tell', reqId: mkReqId(), message: args.message });
        return r?.ok ? { ok: true, ...(r.id ? { id: r.id } : {}) } : { ok: false, error: r?.error ?? 'send failed' };
      }
      case 'ask':
        // Single-shot: no convId, no registry recording — the legacy exchange.
        return await sendAndAwait(args.did, args.message, undefined, args.timeoutMs, ctx.signal);
      case 'inbox': {
        if (ctx.signal?.aborted) return { ok: false, error: 'a2a: run aborted before inbox drain' };
        const drained = inboxBuffer;
        inboxBuffer = [];
        return { ok: true, messages: drained.map((m) => ({ from: m.from, message: m.message, ts: m.ts })) };
      }
      case 'converse': {
        if (!conversations) return { ok: false, error: 'a2a: standing conversations are not available' };
        const { convId } = conversations.open(args.did, args.message);
        const r = await sendAndAwait(args.did, args.message, convId, args.timeoutMs, ctx.signal);
        if (r.ok && !r.timedOut && typeof r.reply === 'string') conversations.record(convId, 'peer', r.reply);
        return { ...r, convId };
      }
      case 'say': {
        if (!conversations) return { ok: false, error: 'a2a: standing conversations are not available' };
        const did = conversations.didFor(args.convId);
        if (!did) return { ok: false, error: `a2a: no standing conversation ${args.convId}` };
        conversations.record(args.convId, 'self', args.message);
        const r = await sendAndAwait(did, args.message, args.convId, args.timeoutMs, ctx.signal);
        if (r.ok && !r.timedOut && typeof r.reply === 'string') conversations.record(args.convId, 'peer', r.reply);
        return { ...r, convId: args.convId };
      }
      default:
        return { ok: false, error: `a2a: unknown op ${op}` };
    }
  };

  /**
   * Route an inbound mesh DM. A 'reply' resolves a matching pending ask and is
   * CONSUMED (returns { consumed:true }) so it never wakes the actor. An 'ask' or
   * 'tell' is buffered for inbox() AND returned for the actor's fenced wake.
   * A non-a2a DM is passed through untouched (returns { consumed:false }).
   * @param {string} from @param {unknown} data
   * @returns {{ consumed: boolean, deliver?: { from: string, kind: string, reqId: string, message: string, convId?: string } }}
   */
  const handleInbound = (from, data) => {
    if (!isA2AEnvelope(data)) return { consumed: false };
    const env = /** @type {A2AEnvelope} */ (data);
    if (env.kind === 'reply') {
      const pending = pendingAsks.get(env.reqId);
      // Only the peer the ask was SENT to may answer it. `from` is the mesh's
      // cryptographically authenticated sender (signed HELLO), so a third peer
      // who guessed the reqId can't resolve someone else's ask. A mismatched or
      // orphan reply is dropped, never resolved — but still CONSUMED, so a forged
      // reply can't wake the actor either.
      if (pending && pending.did === from) {
        clearTimeout(pending.timer);
        pendingAsks.delete(env.reqId);
        pending.resolve({ ok: true, from, reply: String(env.message ?? ''), ...(pending.convId ? { convId: pending.convId } : {}) });
      }
      return { consumed: true };   // a reply is plumbing, never a wake
    }
    // ask / tell → buffer for a live inbox() and hand to the caller for the wake.
    const msg = { from, message: String(env.message ?? ''), ts: now(), reqId: env.reqId, kind: env.kind };
    inboxBuffer.push(msg);
    if (inboxBuffer.length > MAX_INBOX) inboxBuffer.splice(0, inboxBuffer.length - MAX_INBOX);
    return { consumed: false, deliver: { from, kind: env.kind, reqId: env.reqId, message: msg.message, ...(env.convId ? { convId: env.convId } : {}) } };
  };

  /** Send a reply back to a peer's ask (the inbound-wake path once the actor
   * answers). Threads convId so the peer's side keeps the same standing thread.
   * @param {string} toDid @param {string} reqId @param {string} message @param {string} [convId] */
  const reply = (toDid, reqId, message, convId) =>
    sendDm(toDid, /** @type {A2AEnvelope} */ ({ __a2a: 1, kind: 'reply', reqId, message, ...(convId ? { convId } : {}) }));

  return { dispatch, handleInbound, reply, _pendingCount: () => pendingAsks.size };
};
