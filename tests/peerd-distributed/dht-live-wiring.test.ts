import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { createDhtNode } from '../../extension/peerd-distributed/dht/node.js';
import { createDhtStore } from '../../extension/peerd-distributed/dht/store.js';
import { nodeIdOf } from '../../extension/peerd-distributed/dht/distance.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { createPeerNode } from '../../extension/peerd-distributed/peer-node.js';
import { toHex } from '../../extension/shared/bundle/bytes.js';

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// The two pieces that make the (already-tested) Kademlia core go LIVE in the
// base network: the routing table seeds itself from real mesh links, and the
// lookup records who can relay us to each discovered contact (the dialer's hint).

// mock rpc: route a query straight to the target node's handle() — stands in for
// ensure-connection + a ch=1 round-trip.
const makeNetwork = async (n: number) => {
  const network = new Map<string, any>();
  const nodes: any[] = [];
  for (let i = 0; i < n; i++) {
    const identity = await generateIdentity();
    const selfId = await nodeIdOf(identity.did);
    const rpc = async (contact: any, msg: any) => {
      const target = network.get(contact.did);
      if (!target) throw new Error('unreachable');
      return target.node.handle(identity.did, msg);
    };
    const node = createDhtNode({ identity, selfId, store: createDhtStore(), rpc });
    const entry = { identity, node, selfId };
    network.set(identity.did, entry);
    nodes.push(entry);
  }
  return nodes;
};

describe('DHT live wiring (seeding + the dialer broker hint)', () => {
  test('createPeerNode seeds the routing table from mesh links (onPeer → learn)', async () => {
    const ia = await generateIdentity();
    const ib = await generateIdentity();
    const ma = createRoomMesh({ roomId: 'r', identity: ia });
    const mb = createRoomMesh({ roomId: 'r', identity: ib });
    const na = await createPeerNode({ identity: ia, mesh: ma });
    const nb = await createPeerNode({ identity: ib, mesh: mb });
    expect(na.dht.routingTable.size()).toBe(0); // empty before any link — NO manual learn

    const [ca, cb] = memoryPair();
    await Promise.all([
      createSession({ channel: ca, identity: ia }),
      createSession({ channel: cb, identity: ib }),
    ]);
    ma.addLink(ca, ib.did); // fires na's mesh onPeer → na.dht.learn(ib.did)
    mb.addLink(cb, ia.did);
    await tick();

    expect(na.dht.routingTable.has(ib.did)).toBe(true); // seeded automatically from the link
    expect(nb.dht.routingTable.has(ia.did)).toBe(true);
    na.close(); nb.close();
  });

  test('a lookup tags each discovered contact with its broker (the relay hint)', async () => {
    const [A, B, C] = await makeNetwork(3);
    await A.node.learn(B.identity.did); // A knows B
    await B.node.learn(C.identity.did); // B knows C — A does NOT, yet

    await A.node.lookup(C.selfId); // A discovers C THROUGH B's FIND_NODE answer

    const cInA = A.node.routingTable.all().find((x: any) => x.did === C.identity.did);
    expect(cInA).toBeDefined();
    // "to reach C, relay through B" — B answered us, so B is directly linked.
    expect(cInA.hints?.broker).toBe(B.identity.did);
  });

  test('the broker hint is LOCAL — never put on the wire to other nodes', async () => {
    const [A, B, C] = await makeNetwork(3);
    await A.node.learn(B.identity.did);
    await B.node.learn(C.identity.did);
    await A.node.lookup(C.selfId); // A now holds C with hints.broker = B

    // When A serves a FIND_NODE that returns C, the response must NOT leak B as
    // C's broker (reachability is local — B can't necessarily relay everyone).
    const resp = await A.node.handle(B.identity.did, { t: 'FIND_NODE', target: toHex(C.selfId) });
    const wiredC = resp.nodes.find((n: any) => n.did === C.identity.did);
    expect(wiredC).toBeDefined();
    expect(wiredC.hints?.broker).toBeUndefined();
  });
});
