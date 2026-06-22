import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { createDhtNode } from '../../extension/peerd-distributed/dht/node.js';
import { createDhtStore } from '../../extension/peerd-distributed/dht/store.js';
import { nodeIdOf } from '../../extension/peerd-distributed/dht/distance.js';
import { signItem } from '../../extension/peerd-distributed/dht/records.js';
import { fromHex } from '../../extension/shared/bundle/bytes.js';

// A memory DHT "network": the injected rpc routes a query to the target node's
// handle(), standing in for ensure-connection + a ch=1 round-trip over WebRTC.
const makeNetwork = async (n: number) => {
  const network = new Map<string, any>();
  const nodes: any[] = [];
  for (let i = 0; i < n; i++) {
    const identity = await generateIdentity();
    const selfId = await nodeIdOf(identity.did);
    const store = createDhtStore();
    const rpc = async (contact: any, msg: any) => {
      const target = network.get(contact.did);
      if (!target) throw new Error('unreachable');
      return target.node.handle(identity.did, msg);
    };
    const node = createDhtNode({ identity, selfId, store, rpc });
    const entry = { identity, node, selfId };
    network.set(identity.did, entry);
    nodes.push(entry);
  }
  return { nodes };
};

const seedFull = async (nodes: any[]) => {
  for (const a of nodes) for (const b of nodes) if (a !== b) await a.node.learn(b.identity.did);
};
// star: everyone knows node0; node0 knows everyone (a single bootstrap peer)
const seedStar = async (nodes: any[]) => {
  for (const b of nodes.slice(1)) { await nodes[0].node.learn(b.identity.did); await b.node.learn(nodes[0].identity.did); }
};

describe('dht node — RPCs + iterative lookup', () => {
  test('PING/PONG and FIND_NODE serve from the routing table', async () => {
    const { nodes } = await makeNetwork(4);
    await seedFull(nodes);
    expect(await nodes[0].node.handle(nodes[1].identity.did, { t: 'PING' })).toEqual({ t: 'PONG' });
    const r = await nodes[0].node.handle(nodes[1].identity.did, { t: 'FIND_NODE', target: '00'.repeat(32) });
    expect(r.t).toBe('NODES');
    expect(r.nodes.length).toBeGreaterThan(0);
  });

  test('put stores at the k-closest; any peer can get it (full mesh of knowledge)', async () => {
    const { nodes } = await makeNetwork(10);
    await seedFull(nodes);
    const item = await signItem({ value: { dwapp: 'commons', addr: 'peerd://x/y' }, seq: 1 }, nodes[0].identity);
    const { key, stored } = await nodes[0].node.put(item);
    expect(stored).toBeGreaterThan(0); // landed on real remote nodes, not just locally

    const got = await nodes[7].node.get(fromHex(key));
    expect(got?.value).toEqual({ dwapp: 'commons', addr: 'peerd://x/y' });
  });

  test('multi-hop: discovery converges through a single bootstrap peer', async () => {
    const { nodes } = await makeNetwork(12);
    await seedStar(nodes); // node3 and node9 each know ONLY node0
    const item = await signItem({ value: { v: 42 }, seq: 1 }, nodes[3].identity);
    const { key } = await nodes[3].node.put(item); // node3 must hop via node0 to find the k-closest

    const got = await nodes[9].node.get(fromHex(key)); // node9 also only knows node0
    expect(got?.value).toEqual({ v: 42 });
  });

  test('reachable-only: an unreachable contact is dropped from the table on lookup', async () => {
    const { nodes } = await makeNetwork(2);
    const ghost = await generateIdentity(); // a valid did, but never added to the network
    await nodes[0].node.learn(ghost.did, { stale: true });
    await nodes[0].node.learn(nodes[1].identity.did);
    expect(nodes[0].node.routingTable.has(ghost.did)).toBe(true);
    await nodes[0].node.lookup(nodes[1].selfId); // queries the ghost, rpc throws → removed
    expect(nodes[0].node.routingTable.has(ghost.did)).toBe(false);
  });
});
