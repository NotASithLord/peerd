import { expect, test } from 'bun:test';
import { createLocalCounters } from '../../extension/peerd-distributed/local-counters.js';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';

test('local counters reject arbitrary names, saturate, and return independent snapshots', () => {
  const counts = createLocalCounters(['frames']);
  counts.add('frames', Number.MAX_SAFE_INTEGER); counts.add('frames');
  counts.add('attacker-topic', 1); counts.add('frames', -1);
  const snapshot = counts.snapshot(); snapshot.frames = 0;
  expect(counts.snapshot()).toEqual({ frames: Number.MAX_SAFE_INTEGER });
});

test('mesh distinguishes fanout destinations, local send completion, failure, and current degree', async () => {
  const mesh = createRoomMesh({ roomId: 'counters', identity: await generateIdentity() });
  const channel = (fail = false) => ({ send: () => { if (fail) throw new Error('send failed'); },
    setHandler: () => {}, onClose: () => () => {}, close: () => {}, isClosed: () => false });
  mesh.addLink(channel() as any, 'healthy');
  mesh.addLink(channel(true) as any, 'failed');
  mesh.addLink(channel() as any, 'excluded');
  try {
    expect(mesh.stats().peerDegree).toBe(3);
    await mesh.broadcast({ ch: 4, typ: 0 }, 'excluded');
    expect(mesh.stats().broadcasts).toEqual({ calls: 1, destinations: 2, maxDestinations: 2 });
    expect(mesh.stats().sends.gossip).toEqual({ attempted: 2, completed: 1, failed: 1 });
    expect(mesh.stats().peerDegree).toBe(2);
    expect(await mesh.send('absent', { ch: 5, typ: 2 })).toBe(false);
    expect(mesh.stats().sends.discoveryItem).toEqual({ attempted: 1, completed: 0, failed: 1 });
    const snapshot = mesh.stats(); snapshot.sends.gossip.completed = 99;
    expect(mesh.stats().sends.gossip.completed).toBe(1);
    expect(mesh.stats().sends.contentRequest.attempted).toBe(0);
  } finally { mesh.close(); }
});
