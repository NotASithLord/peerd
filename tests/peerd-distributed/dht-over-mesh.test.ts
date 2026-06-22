import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { attachDht } from '../../extension/peerd-distributed/dht/transport.js';
import { createDhtStore } from '../../extension/peerd-distributed/dht/store.js';
import { nodeIdOf } from '../../extension/peerd-distributed/dht/distance.js';
import { signItem } from '../../extension/peerd-distributed/dht/records.js';
import { fromHex } from '../../extension/shared/bundle/bytes.js';

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// A fully-linked clique of DHT nodes — real identities, real HELLOs, real
// signed ch=1 envelopes over memoryPair; the DHT rides the authenticated mesh.
const dhtClique = async (n: number) => {
  const peers: any[] = [];
  for (let i = 0; i < n; i++) {
    const identity = await generateIdentity();
    const mesh = createRoomMesh({ roomId: 'room', identity });
    const selfId = await nodeIdOf(identity.did);
    const { node, detach } = attachDht({ mesh, identity, selfId, store: createDhtStore() });
    peers.push({ identity, mesh, node, selfId, detach });
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const [ci, cj] = memoryPair();
      await Promise.all([
        createSession({ channel: ci, identity: peers[i].identity }),
        createSession({ channel: cj, identity: peers[j].identity }),
      ]);
      peers[i].mesh.addLink(ci, peers[j].identity.did);
      peers[j].mesh.addLink(cj, peers[i].identity.did);
    }
  }
  // seed each DHT routing table with its (reachable) mesh neighbours
  for (const a of peers) for (const b of peers) if (a !== b) await a.node.learn(b.identity.did);
  return peers;
};

const close = (peers: any[]) => { for (const p of peers) { p.detach(); p.mesh.close(); } };

describe('DHT over the real mesh (ch=1 RPCs)', () => {
  test('a put on one node is retrievable from another, via signed ch=1 envelopes', async () => {
    const peers = await dhtClique(5);
    const item = await signItem(
      { value: { dwapp: 'commons', name: 'commons', addr: 'peerd://pub/hash' }, seq: 1 },
      peers[0].identity,
    );
    const { key, stored } = await peers[0].node.put(item);
    expect(stored).toBeGreaterThan(0); // STORE round-tripped to remote nodes over ch=1
    await tick();

    const got = await peers[3].node.get(fromHex(key)); // FIND_VALUE over ch=1
    expect(got?.value?.dwapp).toBe('commons');
    close(peers);
  });

  test('a downgrade replay over the wire is refused by the holder', async () => {
    const peers = await dhtClique(4);
    const v2 = await signItem({ value: { n: 2 }, seq: 2 }, peers[0].identity);
    const { key } = await peers[0].node.put(v2);
    const v1 = await signItem({ value: { n: 1 }, seq: 1 }, peers[0].identity); // stale
    await peers[1].node.put(v1); // tries to STORE the old seq everywhere
    await tick();
    const got = await peers[2].node.get(fromHex(key));
    expect(got?.value).toEqual({ n: 2 }); // the no-downgrade rule held across the wire
    close(peers);
  });
});
