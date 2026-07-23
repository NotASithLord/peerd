// @ts-check
// a2a-api.js — the PURE translation core for the mesh (agent-to-agent) code
// surface, the direct twin of page-api.js (PR #119).
//
// The bet (owner call 2026-07-04): models write "talk to a peer" code most
// fluently in the DEEPEST idiom — promise request/response — not in Google A2A's
// brand-new wire (too young to be in the training corpus). So the dweb actor
// drives the mesh by WRITING JS against a `mesh` client (mesh.peers/card/ask/
// send/publishCard/inbox), and THIS pure core maps each call to a gated mesh OP
// and shapes the reply back. We RHYME with A2A's DATA MODEL (the Agent Card,
// message shape — see the dweb agent-card module) so future interop with a
// non-peerd A2A agent is a thin adapter; we REJECT A2A's HTTP+SSE transport (the
// mesh is the transport, did:key is the address, the fenced inbound-wake is the
// stream).
//
// Pure — values in, values out, no IO, no imports. Keeping the translation pure
// makes the semantics (validation, the ask/send split, the signing boundary)
// unit-testable without a browser or a live mesh. The imperative shell — the
// worker bridge, the SW route, the ask CORRELATION (send a request-tagged DM,
// await the matching inbound reply) — lives in separate files.

/** A failed mesh op REJECTS like a thrown call — so `await mesh.ask(...)` throws. */
export class MeshApiError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'MeshApiError'; }
}

/** A did:key is the peer address (replaces A2A's HTTP url). Light shape check only —
 * the authoritative decode lives in the dweb identity module. @param {unknown} v */
const isDid = (v) => typeof v === 'string' && v.startsWith('did:key:') && v.length > 12;

/** @param {unknown} v @param {string} what */
const nonEmptyString = (v, what) => {
  if (typeof v !== 'string' || v.length === 0) throw new MeshApiError(`${what} must be a non-empty string`);
  return v;
};

/**
 * @typedef {{ op: string, toArgs: (a: any) => object, shape: (c: any) => any, signs?: boolean }} MeshMethodSpec
 */

// The method table. `signs:true` marks an op that SIGNS AS THE USER + emits onto
// the mesh (send/ask/publishCard) — the SW route holds those behind the
// first-contact consent gate (the notWired boundary: reads wire freely, writes
// need a grant). Reads (peers/card/inbox) are side-effect-free.
/** @type {Record<string, MeshMethodSpec>} */
const MESH_METHODS = {
  // Who's on the mesh right now — the live roster. Read.
  peers: {
    op: 'peers',
    toArgs: () => ({}),
    shape: (c) => Array.isArray(c?.peers) ? c.peers : [],
  },
  // Fetch a peer's Agent Card (capabilities), or null if it advertises none. Read.
  card: {
    op: 'card',
    toArgs: (a) => ({ did: isDid(a?.did) ? a.did : (() => { throw new MeshApiError('mesh.card(did): did must be a did:key'); })() }),
    shape: (c) => c?.card ?? null,
  },
  // Advertise MY agent's card so peers can discover what I can do. Signs.
  publishCard: {
    op: 'publishCard',
    toArgs: (a) => {
      const card = a?.card;
      if (!card || typeof card !== 'object' || typeof card.name !== 'string' || card.name.length === 0) {
        throw new MeshApiError('mesh.publishCard(card): card must be an object with a name');
      }
      return { card };
    },
    shape: (c) => ({ ok: c?.ok === true, ...(c?.did ? { did: c.did } : {}) }),
    signs: true,
  },
  // ASK — the demo primitive: send a request-tagged DM to a peer and await its
  // ONE reply (the SW route correlates by request id + times out). Signs.
  ask: {
    op: 'ask',
    toArgs: (a) => {
      const did = isDid(a?.did) ? a.did : (() => { throw new MeshApiError('mesh.ask(did, message): did must be a did:key'); })();
      const message = nonEmptyString(a?.message, 'mesh.ask(did, message): message');
      const timeoutMs = typeof a?.timeoutMs === 'number' && a.timeoutMs > 0 ? Math.min(a.timeoutMs, 120_000) : undefined;
      return { did, message, ...(timeoutMs ? { timeoutMs } : {}) };
    },
    shape: (c) => ({ from: c?.from ?? null, reply: c?.reply ?? null, ...(c?.timedOut ? { timedOut: true } : {}) }),
    signs: true,
  },
  // Fire-and-forget DM (no awaited reply) — a notification, or an out-of-band
  // continuation the code doesn't block on. Signs.
  send: {
    op: 'send',
    toArgs: (a) => {
      const did = isDid(a?.did) ? a.did : (() => { throw new MeshApiError('mesh.send(did, message): did must be a did:key'); })();
      const message = nonEmptyString(a?.message, 'mesh.send(did, message): message');
      return { did, message };
    },
    shape: (c) => ({ sent: c?.ok === true, ...(c?.id ? { id: c.id } : {}) }),
    signs: true,
  },
  // Drain inbound DMs received DURING this run (a code loop can poll it). Read —
  // the durable inbound path is still the fenced actor wake; this is for a script
  // that wants to converse within one a2a_run. Returns [{ from, message, ts }].
  inbox: {
    op: 'inbox',
    toArgs: () => ({}),
    shape: (c) => Array.isArray(c?.messages) ? c.messages : [],
  },
  // CONVERSE — open a STANDING conversation with a peer: like ask, but the SW
  // mints a convId and remembers the thread, so a later peer message continues
  // it (waking the dweb actor with the prior turns as context) and the actor's
  // answers go back to the peer under per-conversation consent. Returns the
  // convId to continue with. Signs.
  converse: {
    op: 'converse',
    toArgs: (a) => {
      const did = isDid(a?.did) ? a.did : (() => { throw new MeshApiError('mesh.converse(did, message): did must be a did:key'); })();
      const message = nonEmptyString(a?.message, 'mesh.converse(did, message): message');
      const timeoutMs = typeof a?.timeoutMs === 'number' && a.timeoutMs > 0 ? Math.min(a.timeoutMs, 120_000) : undefined;
      return { did, message, ...(timeoutMs ? { timeoutMs } : {}) };
    },
    shape: (c) => ({ convId: c?.convId ?? null, from: c?.from ?? null, reply: c?.reply ?? null, ...(c?.timedOut ? { timedOut: true } : {}) }),
    signs: true,
  },
  // SAY — continue a standing conversation opened by converse (or adopted from
  // an inbound thread): send the next turn on an existing convId and await the
  // peer's reply. Signs.
  say: {
    op: 'say',
    toArgs: (a) => {
      const convId = nonEmptyString(a?.convId, 'mesh.say(convId, message): convId');
      const message = nonEmptyString(a?.message, 'mesh.say(convId, message): message');
      const timeoutMs = typeof a?.timeoutMs === 'number' && a.timeoutMs > 0 ? Math.min(a.timeoutMs, 120_000) : undefined;
      return { convId, message, ...(timeoutMs ? { timeoutMs } : {}) };
    },
    shape: (c) => ({ convId: c?.convId ?? null, from: c?.from ?? null, reply: c?.reply ?? null, ...(c?.timedOut ? { timedOut: true } : {}) }),
    signs: true,
  },
};

/** The method names — drives the worker stub + the lore. */
export const MESH_API_METHODS = Object.freeze(Object.keys(MESH_METHODS));

/** Names of the SIGNING ops (send/ask/publishCard) — the SW gates these. */
export const MESH_SIGNING_METHODS = Object.freeze(
  Object.entries(MESH_METHODS).filter(([, s]) => s.signs).map(([k]) => k),
);

/** Does this method sign as the user (emit onto the mesh)? Pure. @param {string} method */
export const meshMethodSigns = (method) => MESH_METHODS[method]?.signs === true;

/**
 * Translate a `mesh.<method>(args)` call into a gated mesh OP + validated args.
 * Throws MeshApiError on an unknown method or bad args (rejects the worker call).
 * @param {{ method?: string, args?: any }} call
 * @returns {{ op: string, args: object, signs: boolean }}
 */
export const meshCallToOp = (call) => {
  const method = call?.method;
  const spec = typeof method === 'string' ? MESH_METHODS[method] : undefined;
  if (!spec) throw new MeshApiError(`unknown mesh method: ${String(method)}`);
  return { op: spec.op, args: spec.toArgs(call?.args ?? {}), signs: spec.signs === true };
};

/**
 * Shape a completed mesh op's result back into the client return value. Throws
 * MeshApiError when the op reported failure (so the awaited call rejects).
 * @param {string} method @param {{ ok?: boolean, error?: string } & Record<string, any>} opResult
 */
export const shapeMeshResult = (method, opResult) => {
  const spec = MESH_METHODS[method];
  if (!spec) throw new MeshApiError(`unknown mesh method: ${String(method)}`);
  if (!opResult || opResult.ok !== true) {
    throw new MeshApiError(opResult?.error ?? `mesh.${method} failed`);
  }
  return spec.shape(opResult);
};
