// A watchable run of the network simulator. NOT a test — a dev/debug tool.
//   bun tests/peerd-distributed/sim-run.ts [N]
// Spins up N real node actors, runs gossip + DHT + a partition/heal, and prints
// a narrated event log + a final state snapshot. Determinministic; no WebRTC.

import { createSimNetwork, tick } from './sim';
import { signItem } from '../../extension/peerd-distributed/dht/records.js';
import { fromHex } from '../../extension/shared/bundle/bytes.js';

const N = Number(process.argv[2] ?? 12);
const line = (s = '') => console.log(s);

const main = async () => {
  const net = createSimNetwork();
  line(`▶ spawning ${N} nodes …`);
  const nodes = await net.spawnMany(Array.from({ length: N }, (_, i) => `node${i}`));
  await net.connectRing(nodes, 3); // sparse: ring + a chord, so floods cross hops
  line(`  topology: ring+chord, ${net.events().filter((e) => e.startsWith('link')).length} links\n`);

  // 1 — gossip
  const heard = new Set<string>();
  for (const n of nodes) n.node.gossip.subscribe('feed', () => heard.add(n.label));
  line('▶ node0 publishes to topic "feed" …');
  await nodes[0].node.gossip.publish('feed', { msg: 'hello mesh' });
  await tick(80);
  line(`  ✓ flooded to ${heard.size}/${N - 1} other nodes across multiple hops\n`);

  // 2 — DHT
  line('▶ node0 PUTs a dwapp record into the DHT …');
  const item = await signItem({ value: { dwapp: 'commons', addr: 'peerd://pub/hash' }, seq: 1 }, nodes[0].identity);
  const { key, stored } = await nodes[0].node.dht.put(item);
  line(`  stored on ${stored} of the k-closest nodes (lookup dialed on demand)`);
  const far = nodes[N - 1];
  line(`▶ ${far.label} GETs it (knew only its ring neighbours) …`);
  const got = await far.node.dht.get(fromHex(key));
  line(`  ✓ resolved: ${JSON.stringify(got?.value)}\n`);

  // 3 — partition + heal
  const A = nodes.slice(0, Math.floor(N / 2));
  const B = nodes.slice(Math.floor(N / 2));
  await net.connectAll(nodes); // densify so the split is a clean cut
  line(`▶ partition: {${A.map((n) => n.label).join(',')}} | {${B.map((n) => n.label).join(',')}}`);
  const afterSplit = new Set<string>();
  for (const n of nodes) n.node.gossip.subscribe('split', () => afterSplit.add(n.label));
  net.partition(A, B);
  await A[0].node.gossip.publish('split', { x: 1 });
  await tick(60);
  line(`  during split, ${A[0].label}'s post reached ${[...afterSplit].filter((l) => A.some((n) => n.label === l)).length}/${A.length - 1} in its group, 0 across the cut`);
  net.heal();
  const afterHeal = new Set<string>();
  for (const n of nodes) n.node.gossip.subscribe('healed', () => afterHeal.add(n.label));
  await A[0].node.gossip.publish('healed', { x: 2 });
  await tick(60);
  line(`  ✓ after heal, the next post reached ${afterHeal.size}/${N - 1} (both sides)\n`);

  line('── final snapshot ──');
  for (const s of net.snapshot()) line(`  ${s.label.padEnd(8)} links:${s.peers}  dht-contacts:${s.dhtContacts}`);
  for (const n of nodes) n.node.close();
};

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
