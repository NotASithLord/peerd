// @ts-check
// peerd-distributed/peer-node.js — a peer node: all the layers over ONE mesh.
// (Named for a peer "node" in the network — NOT Node.js. This is a vanilla
//  browser ES module like the rest of peerd-distributed; it runs in the
//  offscreen document in production and under `bun` only for tests.)
//
// THE pure-actor brain. A node's only link to the world is its mesh, and the
// mesh's only link is a set of Channels (transport/channel.js). The transport
// underneath is interchangeable: WebRTC data channels in the browser,
// `memoryPair` in a test, the simulator's controllable pipes in an N-node sim.
// Because the node never imports a transport — it composes gossip + presence +
// sync + direct + content + DHT over whatever mesh it's handed — the EXACT SAME
// node logic runs in production and in a 27-node in-process simulation. That is
// the property that makes a distributed system testable: separate the actor
// (deterministic message-in / message-out) from the network (the hard part).
//
// Deliberately TIMER-FREE by default: `start()` is explicit, so a simulator can
// drive every node deterministically (announce, publish, look up — step by
// step) with no wall-clock races. Production calls start() for the presence
// beacon + the mesh liveness sweep.

import { createGossip } from './gossip/topic.js';
import { createPresence } from './gossip/presence.js';
import { createTopicSync, createMemoryTopicStore } from './gossip/sync.js';
import { createDirect } from './messaging/direct.js';
import { createContentStore } from './content/store.js';
import { createDhtStore } from './dht/store.js';
import { createProviderStore } from './dht/provider-store.js';
import { attachDht } from './dht/transport.js';
import { nodeIdOf } from './dht/distance.js';

/**
 * @param {{
 *   identity: import('./transport/mesh.js').Identity,
 *   mesh: any,                       // a createRoomMesh — its links come from any transport
 *   meta?: () => any,                // presence metadata (e.g. { name })
 *   dial?: ((contact: any) => Promise<boolean>) | null, // DHT per-hop dialer (prod/sim)
 *   audit?: import('./transport/mesh.js').AuditFn,
 *   now?: () => number,
 * }} opts
 */
export const createPeerNode = async ({ identity, mesh, meta = () => ({}), dial = null, audit = null, now = Date.now }) => {
  const selfId = await nodeIdOf(identity.did);
  const gossip = createGossip({ mesh, now, audit });
  const presence = createPresence({ gossip, selfDid: identity.did, meta });
  const sync = createTopicSync({ mesh, gossip, store: createMemoryTopicStore(), audit });
  const direct = createDirect({ mesh });
  const content = createContentStore();
  mesh.serveContent(content);
  const { node: dht, detach: detachDht } = attachDht({ mesh, identity, selfId, store: createDhtStore({ now }), providers: createProviderStore({ now }), dial, now });

  // A dropped mesh LINK means that peer is gone — forget its presence at once so
  // a disconnected peer leaves the room view immediately, instead of lingering
  // for the full gossip-expiry window. (If it's actually still reachable
  // multi-hop, its next beacon re-adds it.) Event-driven, so the timer-free
  // simulator stays deterministic.
  const offGone = mesh.onPeerGone?.((/** @type {{ did: string }} */ { did }) => presence.forget(did)) ?? (() => {});

  // Seed the DHT routing table from the live mesh: every authenticated link is a
  // reachable contact (the reachable-only rule holds), so a new link learns into
  // the table as it forms (onPeer), and any that already exist learn now. This is
  // what makes lookups start from real neighbours instead of an empty table —
  // the simulator does the same by hand in ensureConnected().
  for (const p of mesh.peers()) await dht.learn(p.did); // deterministic at init (usually empty — links form later)
  const offSeed = mesh.onPeer?.((/** @type {{ did: string }} */ { did }) => dht.learn(did)) ?? (() => {}); // new links seed as they form (close() runs offSeed BEFORE detachDht, so no learn races teardown)

  let started = false;
  return Object.freeze({
    did: identity.did,
    selfId,
    mesh,
    gossip,
    presence,
    sync,
    direct,
    content,
    dht,

    // Bring the node "online": presence beacon + the mesh liveness sweep. A
    // simulator that wants determinism simply never calls this and drives the
    // node by hand.
    start() {
      if (started) return;
      started = true;
      mesh.start?.();
      presence.start();
    },
    close() {
      offGone();
      offSeed();
      detachDht();
      sync.close();
      presence.close();
      direct.close();
      gossip.close();
      mesh.close();
    },
  });
};
