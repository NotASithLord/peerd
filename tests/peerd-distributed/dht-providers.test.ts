import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { createDhtNode } from '../../extension/peerd-distributed/dht/node.js';
import { createDhtStore } from '../../extension/peerd-distributed/dht/store.js';
import { createProviderStore } from '../../extension/peerd-distributed/dht/provider-store.js';
import { nodeIdOf } from '../../extension/peerd-distributed/dht/distance.js';
import { signProvider } from '../../extension/peerd-distributed/dht/records.js';

const KEY = 'ab'.repeat(32); // a 64-hex content key

const makeNetwork = async (n: number, now = () => Date.now()) => {
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
    const node = createDhtNode({ identity, selfId, store: createDhtStore({ now }), providers: createProviderStore({ now }), rpc, now });
    const entry = { identity, node, selfId };
    network.set(identity.did, entry);
    nodes.push(entry);
  }
  return { nodes };
};
const seedFull = async (nodes: any[]) => { for (const a of nodes) for (const b of nodes) if (a !== b) await a.node.learn(b.identity.did); };
const seedStar = async (nodes: any[]) => { for (const b of nodes.slice(1)) { await nodes[0].node.learn(b.identity.did); await b.node.learn(nodes[0].identity.did); } };
const provide = async (n: any, key = KEY) => n.node.announceProvider(key, await signProvider({ key, ts: Date.now() }, n.identity));

describe('dht/provider-store', () => {
  test('verifies the self-signature, lists live providers, refuses a forgery', async () => {
    const a = await generateIdentity();
    const store = createProviderStore();
    expect((await store.add(await signProvider({ key: KEY, ts: 1 }, a))).ok).toBe(true);
    expect(store.list(KEY)).toEqual([a.did]);
    const forged = { ...(await signProvider({ key: KEY, ts: 2 }, a)), provider: 'did:key:zSomeoneElse' };
    expect((await store.add(forged)).ok).toBe(false);
  });

  test('entries expire after the TTL', async () => {
    let t = 1000;
    const a = await generateIdentity();
    const store = createProviderStore({ now: () => t, ttl: 100 });
    await store.add(await signProvider({ key: KEY, ts: t }, a));
    expect(store.list(KEY)).toHaveLength(1);
    t += 200;
    expect(store.list(KEY)).toHaveLength(0);
  });
});

describe('dht node — provider sets', () => {
  test('announceProvider then findProviders resolves across a full mesh', async () => {
    const { nodes } = await makeNetwork(8);
    await seedFull(nodes);
    const { stored } = await provide(nodes[0]);
    expect(stored).toBeGreaterThan(0); // ADD_PROVIDER landed on remote k-closest nodes
    expect(await nodes[5].node.findProviders(KEY)).toContain(nodes[0].identity.did);
  });

  test('multiple providers under one key all surface', async () => {
    const { nodes } = await makeNetwork(8);
    await seedFull(nodes);
    await provide(nodes[0]); await provide(nodes[1]); await provide(nodes[2]);
    const found = await nodes[6].node.findProviders(KEY);
    for (const i of [0, 1, 2]) expect(found).toContain(nodes[i].identity.did);
  });

  test('multi-hop: a provider announced through one bootstrap is findable by another', async () => {
    const { nodes } = await makeNetwork(12);
    await seedStar(nodes);          // node5, node9 each know ONLY node0
    await provide(nodes[5]);
    expect(await nodes[9].node.findProviders(KEY)).toContain(nodes[5].identity.did);
  });
});
