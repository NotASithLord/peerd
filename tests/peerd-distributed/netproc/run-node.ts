// tests/peerd-distributed/netproc/run-node.ts — ONE peerd node in its own
// process. Connects to the relay, forms authenticated mesh links to every other
// node (real HELLO over relay-backed Channels), then self-tests ALL the
// functionality and prints PASS/FAIL. Run 5 of these (one per subagent) against
// one relay and they form a real 5-node network.
//   bun .../run-node.ts <relayUrl> <label> <quorum>
//
// The relay-backed Channel is the whole trick: a node never knows it isn't
// WebRTC — it's the same Channel interface the mesh always uses.

import { generateIdentity } from '../../../extension/peerd-distributed/identity/keypair.js';
import { decodeDidKey } from '../../../extension/peerd-distributed/identity/did.js';
import { createRoomMesh } from '../../../extension/peerd-distributed/transport/mesh.js';
import { createSession } from '../../../extension/peerd-distributed/transport/session.js';
import { createBufferedChannel } from '../../../extension/peerd-distributed/transport/channel.js';
import { createPeerNode } from '../../../extension/peerd-distributed/peer-node.js';
import { signItem, mutableKey } from '../../../extension/peerd-distributed/dht/records.js';
import { toHex } from '../../../extension/shared/bundle/bytes.js';

const URL = process.argv[2] ?? 'ws://localhost:8810';
const LABEL = process.argv[3] ?? 'node';
const QUORUM = Number(process.argv[4] ?? 3);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: any[]) => console.log(`[${LABEL}]`, ...a);
const waitFor = async (cond: () => boolean, ms: number) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) return false; await sleep(100); }
  return true;
};

const main = async () => {
  const identity = await generateIdentity();
  const myDid = identity.did;
  const mesh = createRoomMesh({ roomId: 'netproc', identity });
  const links = new Map<string, any>();   // peerDid -> relay-backed Channel
  const linking = new Set<string>();
  let roster: any[] = [];

  const ws = new WebSocket(URL);
  const linkTo = (peerDid: string) => {
    let ch = links.get(peerDid);
    if (!ch) {
      ch = createBufferedChannel({ send: (obj: any) => ws.send(JSON.stringify({ t: 'msg', to: peerDid, payload: obj })), close: () => {} });
      links.set(peerDid, ch);
    }
    return ch;
  };
  const ensureLink = async (peerDid: string) => {
    if (peerDid === myDid || mesh.hasLink(peerDid) || linking.has(peerDid)) return;
    linking.add(peerDid);
    const ch = linkTo(peerDid);
    try { await createSession({ channel: ch, identity }); mesh.addLink(ch, peerDid); await node.dht.learn(peerDid); }
    catch (e: any) { /* a crossed/duplicate link can lose the race — fine */ }
    finally { linking.delete(peerDid); }
  };

  const dial = async (contact: any) => { await ensureLink(contact.did); return mesh.hasLink(contact.did); };
  const node = await createPeerNode({ identity, mesh, meta: () => ({ name: LABEL }), dial });

  ws.onmessage = (e: any) => {
    let m: any; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'roster') { roster = m.peers; for (const p of m.peers) ensureLink(p.did); }
    else if (m.t === 'msg') { linkTo(m.from).deliver(m.payload); ensureLink(m.from); }
  };
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = (e: any) => rej(new Error('ws error')); });
  ws.send(JSON.stringify({ t: 'hello', did: myDid, label: LABEL }));
  log('connected; my did …' + myDid.slice(-8));

  const linked = await waitFor(() => mesh.peers().length >= QUORUM - 1, 20000);
  if (!linked) { log(`✗ could not reach quorum (${mesh.peers().length + 1}/${QUORUM}) — exiting`); ws.close(); process.exit(1); }
  log(`meshed with ${mesh.peers().length} peers`);

  const others = () => roster.filter((p) => p.did !== myDid);
  const results: Record<string, boolean> = {};

  // Register ALL receive handlers FIRST, then settle, THEN send — direct (ch=3)
  // is fire-and-forget (no buffer/retry), so the handler must be up before any
  // peer sends or the message is dropped. (Gossip/DHT buffer, so they're immune;
  // this ordering is what the 5-node run taught us.)
  const heardGossip = new Set<string>();
  const heardDirect = new Set<string>();
  node.gossip.subscribe('test', (m: any) => { if (m.from !== myDid) heardGossip.add(m.from); });
  node.direct.onMessage((m: any) => heardDirect.add(m.from));
  await sleep(1500); // every node has its handlers up before anyone sends

  node.presence.announce();
  await node.gossip.publish('test', { from: LABEL });
  for (const p of others()) node.direct.send(p.did, { from: LABEL }).catch(() => {});
  await node.dht.put(await signItem({ value: { label: LABEL }, seq: 1 }, identity));

  await sleep(3000); // let the network settle (cross-process timing)

  results.presence = node.presence.list().length >= QUORUM - 1;
  results.gossip = heardGossip.size >= QUORUM - 1;
  results.direct = heardDirect.size >= QUORUM - 1;

  let dhtHits = 0;
  for (const p of others()) {
    const got = await node.dht.get(await mutableKey(decodeDidKey(p.did)));
    if (got?.value?.label) dhtHits += 1;
  }
  results.dht = dhtHits >= QUORUM - 1;

  const pass = Object.values(results).every(Boolean);
  log('RESULTS', JSON.stringify({ peers: mesh.peers().length, dhtHits, ...results }));
  log(pass ? '✅ ALL PASS' : '❌ SOME FAIL');

  await sleep(2500); // linger so peers can finish their gets/receives before we drop
  ws.close();
  process.exit(pass ? 0 : 2);
};

main().catch((e) => { log('FATAL', e?.message ?? e); process.exit(1); });
