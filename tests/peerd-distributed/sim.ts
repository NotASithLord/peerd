// tests/peerd-distributed/sim.ts — the N-node network simulator.
//
// Spins up real peerd node actors (createPeerNode) and runs their REAL logic —
// mesh, gossip, presence, direct, DHT — over controllable in-memory pipes
// instead of WebRTC. Because the node never sees the difference (it only talks
// to its mesh, which only talks to Channels), this exercises the actual
// distributed-system behaviour: floods crossing hops, DHT lookups converging,
// presence churn, partition + heal. The sim also plays RENDEZVOUS: a DHT lookup
// that needs a peer it doesn't link to triggers `dial`, which the sim satisfies
// by connecting them on demand — exactly what the bootstrap node does live.
//
// Deterministic by construction: synchronous in-memory delivery, no wall clock,
// no random drops unless you ask. `bun test` runs it; it's also importable by a
// standalone runner to watch 27 nodes do things and dump their state.

import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { createBufferedChannel } from '../../extension/peerd-distributed/transport/channel.js';
import { createPeerNode } from '../../extension/peerd-distributed/peer-node.js';

export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// A controllable bidirectional link: like memoryPair, but it can be severed
// (partition) or made lossy. Delivery is synchronous (deterministic).
const simLink = () => {
  let severed = false;
  let dropRate = 0;
  let a: any, b: any;
  const pass = (to: any, m: any) => { if (severed) return; if (dropRate && hash(m) < dropRate) return; to.deliver(m); };
  a = createBufferedChannel({ send: (m: any) => pass(b, m), close: () => b.signalClose() });
  b = createBufferedChannel({ send: (m: any) => pass(a, m), close: () => a.signalClose() });
  return { a, b, sever() { severed = true; }, heal() { severed = false; }, setDrop(r: number) { dropRate = r; }, get severed() { return severed; } };
};
// a stable [0,1) from a message, so "drop" is deterministic per-message
const hash = (m: any) => { const s = JSON.stringify(m) || ''; let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return (h % 1000) / 1000; };

export interface SimNode { label: string; identity: any; mesh: any; node: any; }

export const createSimNetwork = ({ now = Date.now } = {}) => {
  const byDid = new Map<string, SimNode>();
  const links = new Map<string, ReturnType<typeof simLink>>();
  const events: string[] = [];
  const log = (...parts: any[]) => { events.push(parts.join(' ')); };
  const key = (x: string, y: string) => [x, y].sort().join('|');
  const labelOf = (did: string) => byDid.get(did)?.label ?? did.slice(-6);

  const ensureConnected = async (fromDid: string, toDid: string) => {
    if (fromDid === toDid) return false;
    const k = key(fromDid, toDid);
    if (links.has(k)) return !links.get(k)!.severed;
    const A = byDid.get(fromDid); const B = byDid.get(toDid);
    if (!A || !B) return false;
    const link = simLink();
    await Promise.all([
      createSession({ channel: link.a, identity: A.identity }),
      createSession({ channel: link.b, identity: B.identity }),
    ]);
    A.mesh.addLink(link.a, toDid);
    B.mesh.addLink(link.b, fromDid);
    await A.node.dht.learn(toDid);    // the link exists → reachable
    await B.node.dht.learn(fromDid);
    links.set(k, link);
    log('link', labelOf(fromDid), '<->', labelOf(toDid));
    return true;
  };

  const api = {
    async spawn(label: string): Promise<SimNode> {
      const identity = await generateIdentity();
      const mesh = createRoomMesh({ roomId: 'sim', identity, now });
      const entry: SimNode = { label, identity, mesh, node: null };
      const dial = async (contact: any) => ensureConnected(identity.did, contact.did); // sim = rendezvous
      entry.node = await createPeerNode({ identity, mesh, meta: () => ({ name: label }), dial, now });
      byDid.set(identity.did, entry);
      log('spawn', label);
      return entry;
    },
    async spawnMany(labels: string[]) { const out: SimNode[] = []; for (const l of labels) out.push(await api.spawn(l)); return out; },

    connect: (a: SimNode, b: SimNode) => ensureConnected(a.identity.did, b.identity.did),
    async connectAll(list: SimNode[]) {
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) await api.connect(list[i], list[j]);
    },
    // a connected-but-sparse ring+chord so floods must cross hops
    async connectRing(list: SimNode[], chord = 2) {
      for (let i = 0; i < list.length; i++) {
        await api.connect(list[i], list[(i + 1) % list.length]);
        if (chord) await api.connect(list[i], list[(i + chord) % list.length]);
      }
    },

    // Sever every link that crosses the A/B boundary (a network split).
    partition(groupA: SimNode[], groupB: SimNode[]) {
      const inA = new Set(groupA.map((n) => n.identity.did));
      const inB = new Set(groupB.map((n) => n.identity.did));
      let cut = 0;
      for (const [k, link] of links) {
        const [x, y] = k.split('|');
        if ((inA.has(x) && inB.has(y)) || (inA.has(y) && inB.has(x))) { link.sever(); cut++; }
      }
      log('partition', `${groupA.length}|${groupB.length} — cut ${cut} links`);
    },
    heal() { for (const l of links.values()) l.heal(); log('heal'); },
    kill(n: SimNode) {
      n.node.close();
      for (const [k, link] of links) if (k.includes(n.identity.did)) { link.sever(); }
      log('kill', n.label);
    },

    // observation
    log,
    events: () => events,
    dumpLog: () => events.join('\n'),
    nodes: () => [...byDid.values()],
    snapshot: () => [...byDid.values()].map((n) => ({
      label: n.label,
      peers: n.mesh.peers().length,
      dhtContacts: n.node.dht.routingTable.size(),
    })),
  };
  return api;
};
