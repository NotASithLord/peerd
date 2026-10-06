// @ts-check
// peerd-distributed/dht/transport.js — the DHT over the mesh (PROTOCOL §5.2).
//
// Binds a Kademlia node (dht/node.js) to the authenticated WebRTC mesh
// (transport/mesh.js). DHT RPCs ride ch=1 signed envelopes as request/response
// pairs correlated by a reqId. Because ch≠0 frames are link-local in the mesh
// (handle() requires env.from === link.did) and never forwarded, a DHT RPC is a
// point-to-point exchange between two directly-connected, mutually-authenticated
// peers — exactly the guarantee Kademlia-over-UDP lacks.
//
// THE reach problem (and why this is the right home for the DHT): a lookup must
// query routing-table contacts we may not currently hold a link to. Over UDP
// you just send a datagram; over WebRTC you must connect first. So rpc() ensures
// a link — reuse the mesh link if present, else `dial(contact)` (the base layer
// supplies the dialer: rendezvous / mesh-assisted signaling). This is exactly
// the per-hop connection cost the prior art warns about — which is why the DHT
// lives in the OFFSCREEN document (session-lifetime, shares the base connection
// pool) and not in a tab.

import { createDhtNode } from './node.js';

const CH_DHT = 1;
const REQ = 0;
const RESP = 1;

/**
 * @param {{
 *   mesh: any, identity: { did: string }, selfId: Uint8Array,
 *   store: any, providers?: any, dial?: ((contact: any, opts?: {signal?: AbortSignal}) => Promise<boolean>) | null,
 *   timeoutMs?: number, now?: () => number, k?: number, alpha?: number,
 * }} opts
 * @returns {{ node: any, detach: () => void }}
 */
export const attachDht = ({ mesh, identity, selfId, store, providers = null, dial = null, timeoutMs = 8000, now = Date.now, k, alpha }) => {
  /** @type {Map<string, { did: string, resolve: (v: any) => void, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map(); // reqId -> { resolve, timer }
  let reqSeq = 0;
  let closed = false;
  /** @type {Set<AbortController>} */
  const active = new Set();

  // The transport the node calls to query a contact. Ensures a link first.
  /**
   * @param {{ did: string }} contact
   * @param {any} msg
   */
  const rpc = async (contact, msg, { signal } = /** @type {{signal?: AbortSignal}} */ ({})) => {
    const did = contact.did;
    if (closed || signal?.aborted) throw new Error('dht: closed or cancelled');
    if (did === identity.did) throw new Error('dht: refusing to rpc self');
    const ac = new AbortController();
    active.add(ac);
    const cancel = () => ac.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const reqId = `${identity.did.slice(-6)}:${++reqSeq}`;
    const timer = setTimeout(cancel, timeoutMs);
    const aborted = new Promise((_, reject) => {
      ac.signal.addEventListener('abort', () => reject(new Error('dht: rpc cancelled or timed out')), { once: true });
    });
    const run = async () => {
      if (!mesh.hasLink(did)) {
        if (!dial || !(await dial(contact, { signal: ac.signal }))) throw new Error(`dht: no path to ${did.slice(-8)}`);
      }
      ac.signal.throwIfAborted();
      const env = await mesh.sign(CH_DHT, REQ, { reqId, msg });
      ac.signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        pending.set(reqId, { did, resolve, timer });
        if (!mesh.send(did, env)) reject(new Error('dht: link lost mid-send'));
      });
    };
    try { return await Promise.race([aborted, run()]); }
    finally {
      clearTimeout(timer);
      pending.delete(reqId);
      signal?.removeEventListener('abort', cancel);
      active.delete(ac);
      ac.abort();
    }
  };

  const node = createDhtNode({ identity, selfId, store, providers, rpc, now, k, alpha });

  const off = mesh.onEnvelope(async (/** @type {{ env: any }} */ { env }) => {
    if (closed || env.ch !== CH_DHT || !env.body) return;
    if (env.typ === REQ) {
      // Serve it. env.from is the authenticated neighbour (mesh guaranteed it).
      // Backstop: a malformed frame must never throw out of this fire-and-forget
      // callback (unhandled rejection) nor black-hole the RESP — always answer.
      let resp;
      try { resp = await node.handle(env.from, env.body.msg); }
      catch { resp = { t: 'ERR', reason: 'handler-error' }; }
      mesh.send(env.from, await mesh.sign(CH_DHT, RESP, { reqId: env.body.reqId, resp }));
    } else if (env.typ === RESP) {
      const p = pending.get(env.body.reqId);
      if (p && p.did === env.from) { clearTimeout(p.timer); pending.delete(env.body.reqId); p.resolve(env.body.resp); }
    }
  });

  return {
    node,
    detach() {
      closed = true;
      off();
      for (const ac of active) ac.abort();
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
    },
  };
};
