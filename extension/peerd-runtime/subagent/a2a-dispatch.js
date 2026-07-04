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

/** @typedef {{ __a2a: 1, kind: 'ask'|'reply'|'tell', reqId: string, message: string }} A2AEnvelope */

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
 */
export const makeMeshDispatch = (deps) => {
  const {
    sendDm, listPeers, fetchCard, publishCard,
    now = Date.now, newReqId, defaultTimeoutMs = 30_000,
  } = deps;

  // reqId → { resolve, timer } for asks awaiting a reply. Lives across the single
  // a2a_run worker call (the worker relays each op to the SW; the pending map is
  // SW-side so a reply that lands after the op returns still resolves it).
  /** @type {Map<string, { resolve: (v: any) => void, timer: any }>} */
  const pendingAsks = new Map();
  // Inbound a2a messages (ask/tell) received during a run, drained by inbox().
  /** @type {Array<{ from: string, message: string, ts: number, reqId: string, kind: string }>} */
  let inboxBuffer = [];

  let idSeq = 0;
  const mkReqId = newReqId ?? (() => `a2a-${now().toString(36)}-${(idSeq += 1).toString(36)}`);

  /**
   * Run one translated op. `ctx.confirmedDids` is the set the SW has already
   * cleared for first-contact (signing ops to an un-cleared did are refused
   * HERE so the gate can't be bypassed by the worker).
   * @param {string} op @param {any} args
   * @param {{ signs?: boolean, allowed?: (did: string) => boolean }} [ctx]
   * @returns {Promise<{ ok: boolean, error?: string } & Record<string, any>>}
   */
  const dispatch = async (op, args, ctx = {}) => {
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
        const r = await publishCard(args.card);
        return r?.ok ? { ok: true, ...(r.did ? { did: r.did } : {}) } : { ok: false, error: r?.error ?? 'publishCard failed' };
      }
      case 'send': {
        const r = await sendDm(args.did, { __a2a: 1, kind: 'tell', reqId: mkReqId(), message: args.message });
        return r?.ok ? { ok: true, ...(r.id ? { id: r.id } : {}) } : { ok: false, error: r?.error ?? 'send failed' };
      }
      case 'ask': {
        const reqId = mkReqId();
        const sent = await sendDm(args.did, { __a2a: 1, kind: 'ask', reqId, message: args.message });
        if (!sent?.ok) return { ok: false, error: sent?.error ?? 'ask: could not reach the peer' };
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : defaultTimeoutMs;
        return await new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingAsks.delete(reqId);
            resolve({ ok: true, from: null, reply: null, timedOut: true });
          }, timeoutMs);
          pendingAsks.set(reqId, { resolve, timer });
        });
      }
      case 'inbox': {
        const drained = inboxBuffer;
        inboxBuffer = [];
        return { ok: true, messages: drained.map((m) => ({ from: m.from, message: m.message, ts: m.ts })) };
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
   * @returns {{ consumed: boolean, deliver?: { from: string, kind: string, reqId: string, message: string } }}
   */
  const handleInbound = (from, data) => {
    if (!isA2AEnvelope(data)) return { consumed: false };
    const env = /** @type {A2AEnvelope} */ (data);
    if (env.kind === 'reply') {
      const pending = pendingAsks.get(env.reqId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingAsks.delete(env.reqId);
        pending.resolve({ ok: true, from, reply: String(env.message ?? '') });
      }
      return { consumed: true };   // a reply is plumbing, never a wake
    }
    // ask / tell → buffer for a live inbox() and hand to the caller for the wake.
    const msg = { from, message: String(env.message ?? ''), ts: now(), reqId: env.reqId, kind: env.kind };
    inboxBuffer.push(msg);
    return { consumed: false, deliver: { from, kind: env.kind, reqId: env.reqId, message: msg.message } };
  };

  /** Send a reply back to a peer's ask (used by the inbound-wake path once the
   * actor answers). @param {string} toDid @param {string} reqId @param {string} message */
  const reply = (toDid, reqId, message) =>
    sendDm(toDid, { __a2a: 1, kind: 'reply', reqId, message });

  return { dispatch, handleInbound, reply, _pendingCount: () => pendingAsks.size };
};
