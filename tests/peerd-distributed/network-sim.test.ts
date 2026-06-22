import { describe, test, expect } from 'bun:test';
import { createSimNetwork, tick } from './sim';
import { signItem } from '../../extension/peerd-distributed/dht/records.js';
import { fromHex } from '../../extension/shared/bundle/bytes.js';

const labels = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);

describe('network simulation — real node actors at scale', () => {
  test('gossip floods to every node across a sparse ring+chord (16 nodes)', async () => {
    const net = createSimNetwork();
    const nodes = await net.spawnMany(labels(16, 'n'));
    await net.connectRing(nodes, 4); // sparse: each node links ~4 others, not all 15

    const got: Record<string, any[]> = {};
    for (const n of nodes) { got[n.label] = []; n.node.gossip.subscribe('feed', (m: any) => got[n.label].push(m.data)); }

    await nodes[0].node.gossip.publish('feed', { msg: 'hi everyone' });
    await tick(80);

    // every other node heard it exactly once — the flood crossed multiple hops
    for (const n of nodes.slice(1)) {
      expect(got[n.label]).toHaveLength(1);
      expect(got[n.label][0]).toEqual({ msg: 'hi everyone' });
    }
    net.log(`gossip reached all ${nodes.length} nodes`);
  });

  test('a DHT put is findable by a far node (dial-on-demand convergence, 12 nodes)', async () => {
    const net = createSimNetwork();
    const nodes = await net.spawnMany(labels(12, 'd'));
    await net.connectRing(nodes, 3);

    const item = await signItem({ value: { dwapp: 'commons', addr: 'peerd://x/y' }, seq: 1 }, nodes[0].identity);
    const { key, stored } = await nodes[0].node.dht.put(item);
    expect(stored).toBeGreaterThan(0); // landed on remote holders
    await tick(60);

    // a node on the far side resolves it — its lookup DIALS toward the key
    const got = await nodes[8].node.dht.get(fromHex(key));
    expect(got?.value?.dwapp).toBe('commons');
    net.log('DHT record resolved across the ring');
  });

  test('partition isolates gossip; healing reconverges (8 nodes split 4|4)', async () => {
    const net = createSimNetwork();
    const nodes = await net.spawnMany(labels(8, 'p'));
    await net.connectAll(nodes);
    const got: Record<string, any[]> = {};
    for (const n of nodes) { got[n.label] = []; n.node.gossip.subscribe('feed', (m: any) => got[n.label].push(m.data)); }

    const A = nodes.slice(0, 4); const B = nodes.slice(4);
    net.partition(A, B);
    await A[0].node.gossip.publish('feed', { while: 'split' });
    await tick(60);
    // A heard it, B did not (the split held)
    for (const n of A.slice(1)) expect(got[n.label]).toContainEqual({ while: 'split' });
    for (const n of B) expect(got[n.label]).not.toContainEqual({ while: 'split' });

    net.heal();
    await A[0].node.gossip.publish('feed', { after: 'heal' });
    await tick(60);
    // now everyone (both sides) hears the post-heal message
    for (const n of nodes.slice(1)) expect(got[n.label]).toContainEqual({ after: 'heal' });
    net.log('reconverged after heal');
  });

  test('observable: the event log narrates what happened', async () => {
    const net = createSimNetwork();
    const nodes = await net.spawnMany(labels(5, 's'));
    await net.connectRing(nodes, 2);
    await nodes[0].node.gossip.publish('feed', { x: 1 });
    await tick(40);
    const snap = net.snapshot();
    expect(snap).toHaveLength(5);
    expect(snap.every((s) => s.peers > 0)).toBe(true); // everyone has live links
    // (uncomment to watch a run: console.log(net.dumpLog()))
  });
});
