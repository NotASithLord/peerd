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
 *   store: any, providers?: any, dial?: ((contact: any) => Promise<boolean>) | null,
 *   timeoutMs?: number, now?: () => number, k?: number, alpha?: number,
 * }} opts
 * @returns {{ node: any, detach: () => void }}
 */
export const attachDht = ({ mesh, identity, selfId, store, providers = null, dial = null, timeoutMs = 8000, now = Date.now, k, alpha }) => {
  const pending = new Map(); // reqId -> { resolve, timer }
  let reqSeq = 0;

  // The transport the node calls to query a contact. Ensures a link first.
  const rpc = async (contact, msg) => {
    const did = contact.did;
    if (did === identity.did) throw new Error('dht: refusing to rpc self');
    if (!mesh.hasLink(did)) {
      if (!dial || !(await dial(contact))) throw new Error(`dht: no path to ${did.slice(-8)}`);
    }
    const reqId = `${identity.did.slice(-6)}:${++reqSeq}`;
    const env = await mesh.sign(CH_DHT, REQ, { reqId, msg });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(reqId); reject(new Error('dht: rpc timeout')); }, timeoutMs);
      pending.set(reqId, { resolve, timer });
      if (!mesh.send(did, env)) { clearTimeout(timer); pending.delete(reqId); reject(new Error('dht: link lost mid-send')); }
    });
  };

  const node = createDhtNode({ identity, selfId, store, providers, rpc, now, k, alpha });

  const off = mesh.onEnvelope(async ({ env }) => {
    if (env.ch !== CH_DHT || !env.body) return;
    if (env.typ === REQ) {
      // Serve it. env.from is the authenticated neighbour (mesh guaranteed it).
      const resp = await node.handle(env.from, env.body.msg);
      mesh.send(env.from, await mesh.sign(CH_DHT, RESP, { reqId: env.body.reqId, resp }));
    } else if (env.typ === RESP) {
      const p = pending.get(env.body.reqId);
      if (p) { clearTimeout(p.timer); pending.delete(env.body.reqId); p.resolve(env.body.resp); }
    }
  });

  return {
    node,
    detach() {
      off();
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
    },
  };
};
