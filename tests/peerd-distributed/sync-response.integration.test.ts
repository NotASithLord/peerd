import { expect, test } from 'bun:test';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { createGossip } from '../../extension/peerd-distributed/gossip/topic.js';
import { createMemoryTopicStore, createTopicSync } from '../../extension/peerd-distributed/gossip/sync.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { TOPIC_SYNC_WINDOW } from '../../extension/peerd-distributed/transport/capabilities.js';
import { WINDOW } from '../../extension/peerd-distributed/gossip/sync-window.js';
import { verifyEnvelope } from '../../extension/peerd-distributed/transport/envelope.js';

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
};

test('one honest response preserves all selected history across negotiated-size pages', async () => {
  const [publisher, receiver] = await Promise.all([generateIdentity(), generateIdentity()]);
  const a = createRoomMesh({ roomId: 'room', identity: publisher });
  const b = createRoomMesh({ roomId: 'room', identity: receiver });
  const ga = createGossip({ mesh: a });
  const gb = createGossip({ mesh: b });
  const sa = createMemoryTopicStore();
  const sb = createMemoryTopicStore();
  const release = gate();
  const audits: string[] = [];
  let delivered = 0;
  gb.subscribe('feed', () => { delivered++; });
  const syncA = createTopicSync({ mesh: a, gossip: ga, store: sa });
  const syncB = createTopicSync({ mesh: b, gossip: gb, store: sb,
    verify: async (env) => { await release.promise; return verifyEnvelope(env); },
    audit: (type) => audits.push(type),
  });
  for (let i = 0; i < 256; i++) sa.put('feed', await a.sign(4, 0, { topic: 'feed', data: `${i}:${'x'.repeat(32_400)}` }));
  syncA.retain('feed'); syncB.retain('feed');
  const [ca, cb] = memoryPair();
  ca.maxFrameBytes = () => 65_536;
  let sentEntries = 0;
  let pages = 0;
  const send = ca.send.bind(ca);
  ca.send = async (frame, options) => {
    if (frame.ch === 4 && frame.typ === WINDOW.PAGE) {
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(65_536);
      pages++;
      sentEntries += frame.body.envs.length;
    }
    await send(frame, options);
  };
  try {
    const [sessionA, sessionB] = await Promise.all([
      createSession({ channel: ca, identity: publisher, caps: [TOPIC_SYNC_WINDOW] }),
      createSession({ channel: cb, identity: receiver, caps: [TOPIC_SYNC_WINDOW] }),
    ]);
    a.addLink(ca, receiver.did, { caps: sessionA.remoteCaps });
    b.addLink(cb, publisher.did, { caps: sessionB.remoteCaps });
    await waitFor(() => pages === 1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(pages).toBe(1);
    expect(sentEntries).toBe(1);
    release.resolve();
    await waitFor(() => delivered === 256);
    expect(sentEntries).toBe(256);
    expect(pages).toBe(256);
    expect(sb.list('feed')).toHaveLength(256);
    expect(audits).not.toContain('sync_work_overloaded');
  } finally {
    release.resolve(); syncA.close(); syncB.close(); ga.close(); gb.close(); a.close(); b.close();
  }
});

test('bidirectional paging progresses while the next page races ACK send settlement', async () => {
  const identities = await Promise.all([generateIdentity(), generateIdentity()]);
  const meshes = identities.map(identity => createRoomMesh({ roomId: 'room', identity }));
  const gossip = meshes.map(mesh => createGossip({ mesh }));
  const stores = meshes.map(() => createMemoryTopicStore());
  const audits: string[] = [];
  const sync = meshes.map((mesh, i) => createTopicSync({ mesh, gossip: gossip[i], store: stores[i], audit: (type) => audits.push(type) }));
  const channels = memoryPair();
  channels.forEach(channel => { channel.maxFrameBytes = () => 65_536; });
  const ackEntered = gate();
  const ackRelease = gate();
  const send = channels[1].send.bind(channels[1]);
  channels[1].send = async (frame, options) => {
    await send(frame, options);
    if (frame.typ === WINDOW.ACK && frame.body.seq === 0) { ackEntered.resolve(); await ackRelease.promise; }
  };
  try {
    for (const i of [0, 1]) {
      for (let n = 0; n < 8; n++) stores[i].put('feed', await meshes[i].sign(4, 0, { topic: 'feed', data: `${i}:${n}:${'x'.repeat(32_400)}` }));
      sync[i].retain('feed');
    }
    const sessions = await Promise.all(channels.map((channel, i) => createSession({ channel, identity: identities[i], caps: [TOPIC_SYNC_WINDOW] })));
    meshes.forEach((mesh, i) => mesh.addLink(channels[i], identities[1 - i].did, { caps: sessions[i].remoteCaps }));
    await ackEntered.promise;
    // The opposite direction must finish despite one ACK send promise being
    // held locally. No exchange waits for processing while occupying all slots.
    await waitFor(() => stores[0].list('feed').length === 16);
    expect(stores[0].list('feed')).toHaveLength(16);
    ackRelease.resolve();
    await waitFor(() => stores[1].list('feed').length === 16);
    expect(stores[1].list('feed')).toHaveLength(16);
    expect(audits).not.toContain('sync_work_overloaded');
    expect(audits).not.toContain('sync_window_stopped');
  } finally {
    ackRelease.resolve(); sync.forEach(s => s.close()); gossip.forEach(g => g.close()); meshes.forEach(m => m.close());
  }
});
