import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { createDirect } from '../../extension/peerd-distributed/messaging/direct.js';

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// A fully-linked clique of N peers — real identities, real HELLOs, real
// signed envelopes; only the bytes ride memoryPair instead of WebRTC.
const clique = async (n: number) => {
  const peers: any[] = [];
  for (let i = 0; i < n; i++) {
    const identity = await generateIdentity();
    const mesh = createRoomMesh({ roomId: 'room', identity });
    const direct = createDirect({ mesh });
    peers.push({ identity, mesh, direct });
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
  return peers;
};

const close = (peers: any[]) => { for (const p of peers) { p.direct.close(); p.mesh.close(); } };

describe('direct messages (ch=3)', () => {
  test('a direct send reaches ONLY the recipient — never a third clique member', async () => {
    const peers = await clique(3); // 0,1,2 all directly linked
    const got: Record<number, any[]> = { 0: [], 1: [], 2: [] };
    for (const i of [0, 1, 2]) peers[i].direct.onMessage((m: any) => got[i].push(m));

    const r = await peers[0].direct.send(peers[1].identity.did, { text: 'just for you' });
    await tick();

    // recipient got it once, authenticated to the sender; nobody else did —
    // proving ch=3 is directed (no broadcast) and un-relayed (peer 2 is
    // linked to both 0 and 1 yet sees nothing).
    expect(got[1]).toHaveLength(1);
    expect(got[1][0].from).toBe(peers[0].identity.did);
    expect(got[1][0].data).toEqual({ text: 'just for you' });
    expect(got[1][0].id).toBe(r.id);
    expect(got[0]).toHaveLength(0); // sender does not echo to itself
    expect(got[2]).toHaveLength(0); // the third peer never sees a direct msg
    close(peers);
  });

  test('send rejects when there is no direct link to the recipient', async () => {
    const peers = await clique(1);
    const stranger = await generateIdentity();
    await expect(peers[0].direct.send(stranger.did, { text: 'hi' })).rejects.toThrow(/no direct link/);
    close(peers);
  });

  test('both directions work over the same link', async () => {
    const peers = await clique(2);
    const got: Record<number, any[]> = { 0: [], 1: [] };
    for (const i of [0, 1]) peers[i].direct.onMessage((m: any) => got[i].push(m));

    await peers[0].direct.send(peers[1].identity.did, { text: 'ping' });
    await peers[1].direct.send(peers[0].identity.did, { text: 'pong' });
    await tick();

    expect(got[1].map((m) => m.data.text)).toEqual(['ping']);
    expect(got[0].map((m) => m.data.text)).toEqual(['pong']);
    close(peers);
  });
});
