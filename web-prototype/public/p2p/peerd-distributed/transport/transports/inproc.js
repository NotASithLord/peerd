// peerd-distributed/transport/transports/inproc.js — same-realm transport.
//
// The cheapest transport: two peers sharing a JS realm (e.g. two agents
// in one worker/page) link through an in-memory channel pair — zero ICE,
// zero latency, no network at all. why: peerd's thesis is many agents per
// user; agent-to-agent in the same browser should never pay for WebRTC.
//
// Rendezvous is a module-level hub: same realm = same module instance =
// same hub. A peer that wants to be reachable in-process `listen`s under
// its did; a peer that `connect`s to that did is linked instantly. This
// is one Transport implementation behind the uniform connect() selector —
// callers never branch on "is this peer local?"; the hub answers it.

import { memoryPair } from '../channel.js';

const hub = new Map(); // did -> onInbound(channel)

export const createInprocTransport = () => ({
  name: 'inproc',

  // Become reachable in-process under `selfDid`. Returns an unlisten fn.
  listen(selfDid, onInbound) {
    hub.set(selfDid, onInbound);
    return () => {
      if (hub.get(selfDid) === onInbound) hub.delete(selfDid);
    };
  },

  // 1 if the peer is present in this realm, 0 otherwise — so the connect()
  // selector skips inproc instantly when the peer isn't local.
  canReach(peer) {
    return peer && hub.has(peer.did) ? 1 : 0;
  },

  async connect(peer) {
    const onInbound = hub.get(peer && peer.did);
    if (!onInbound) throw new Error(`inproc: ${peer?.did ?? 'peer'} not present in this realm`);
    const [local, remote] = memoryPair();
    onInbound(remote); // hand the far end to the listening peer
    return local;
  },
});
