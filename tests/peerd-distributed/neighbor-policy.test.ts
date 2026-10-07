import { expect, test } from 'bun:test';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { memoryPair, createBufferedChannel } from '../../extension/peerd-distributed/transport/channel.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { NEIGHBOR_GRACE_MS, NEIGHBOR_ROTATION_MS, TRANSFER_PROTECTION_MS } from '../../extension/peerd-distributed/transport/neighbor-policy.js';

const fixture = async (sparse = true) => {
  let now = 1;
  const audit: Array<{ type: string; detail: any }> = [];
  const mesh = createRoomMesh({ roomId: 'test', identity: await generateIdentity(), sparse, now: () => now,
    audit: (type, detail) => audit.push({ type, detail }) });
  const channels: ReturnType<typeof memoryPair>[number][] = [];
  const add = (did: string, locallySelected = false, info = {}) => {
    const [a, b] = memoryPair(); channels.push(a, b);
    return mesh.addLink(a, did, info, { locallySelected });
  };
  return { mesh, add, audit, advance: (ms: number) => { now += ms; }, close: () => { mesh.close(); for (const c of channels) c.close(); } };
};

test('established exploration slots are locally owned and survive spoofed info or quiet inbound saturation', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 14; n++) expect(f.add(`in${n}`, false, { locallySelected: true, direction: 'outbound' })).toBe(true);
    expect(f.add('in-over')).toBe(false);
    expect(f.add('out1', true)).toBe(true); expect(f.add('out2', true)).toBe(true);
    expect(f.mesh.peers()).toHaveLength(16);
    expect(f.add('newcomer')).toBe(false); // newcomer grace, not immediate churn
    f.advance(NEIGHBOR_GRACE_MS);
    expect(f.add('newcomer')).toBe(true);
    expect(f.mesh.peers()).toHaveLength(16);
    expect(f.mesh.hasLink('out1')).toBe(true); expect(f.mesh.hasLink('out2')).toBe(true);
    expect(f.add('another')).toBe(false); // replacement cannot amplify an arrival flood
    expect(f.audit.some(a => a.type.includes('cooldown') || a.type.includes('penal'))).toBe(false);
    f.advance(NEIGHBOR_ROTATION_MS);
    expect(f.add('another')).toBe(true);
    expect(f.audit.filter(a => a.type === 'peer_link_closed' && a.detail.why === 'neighbor-rotation')).toHaveLength(2);
  } finally { f.close(); }
});

test('active downloads receive bounded protection that repeated requests cannot renew forever', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 14; n++) { f.add(`in${n}`); f.mesh.contentChannel(`in${n}`)!.setHandler(() => {}); }
    f.add('out1', true); f.add('out2', true);
    f.advance(NEIGHBOR_GRACE_MS);
    expect(f.add('waiting')).toBe(false);
    for (let n = 0; n < 14; n++) { f.add(`in${n}`); f.mesh.contentChannel(`in${n}`)!.setHandler(() => {}); }
    f.advance(TRANSFER_PROTECTION_MS - 1); expect(f.add('waiting2')).toBe(false);
    f.advance(1); expect(f.add('waiting3')).toBe(true);
    expect(f.mesh.peers()).toHaveLength(16);
  } finally { f.close(); }
});

test('legacy/private meshes retain complete budget and never pressure-rotate a quiet peer', async () => {
  const f = await fixture(false);
  try {
    for (let n = 0; n < 16; n++) expect(f.add(`legacy${n}`)).toBe(true);
    f.advance(NEIGHBOR_GRACE_MS + NEIGHBOR_ROTATION_MS);
    expect(f.add('extra', true)).toBe(false);
    expect(f.mesh.peers()).toHaveLength(16);
    expect(f.audit.some(a => a.type === 'peer_link_closed')).toBe(false);
  } finally { f.close(); }
});

test('same-DID replacement cannot renew grace or erase local exploration ownership', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 14; n++) f.add(`in${n}`);
    f.add('out1', true); f.add('out2', true);
    f.advance(NEIGHBOR_GRACE_MS);
    expect(f.add('out1', false, { locallySelected: false })).toBe(true);
    expect(f.mesh.locallySelectedCount()).toBe(2);
    for (let n = 0; n < 14; n++) expect(f.add(`in${n}`)).toBe(true);
    expect(f.add('newcomer')).toBe(true); // replacements did not restart grace
    expect(f.mesh.hasLink('out1')).toBe(true); expect(f.mesh.hasLink('out2')).toBe(true);
  } finally { f.close(); }
});


test('an active content response is protected until its owned send settles', async () => {
  let now = 1; const entered = Promise.withResolvers<void>(); const released = Promise.withResolvers<void>();
  const mesh = createRoomMesh({ roomId: 'serve', identity: await generateIdentity(), budget: 3, sparse: true, now: () => now });
  const channel = createBufferedChannel({ send: async () => { entered.resolve(); await released.promise; } });
  const peers = [memoryPair(), memoryPair(), memoryPair()];
  try {
    mesh.addLink(channel, 'serving');
    mesh.addLink(peers[0]![0], 'local1', {}, { locallySelected: true });
    mesh.addLink(peers[1]![0], 'local2', {}, { locallySelected: true });
    mesh.serveContent({ getManifest: () => null, getChunk: () => null });
    channel.deliver({ t: 'CHUNK_REQ', hash: 'a'.repeat(64) }); await entered.promise;
    now += NEIGHBOR_GRACE_MS;
    expect(mesh.addLink(peers[2]![0], 'newcomer')).toBe(false);
    released.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    const replacement = memoryPair(); peers.push(replacement);
    expect(mesh.addLink(replacement[0], 'newcomer')).toBe(true);
  } finally { released.resolve(); mesh.close(); for (const pair of peers) for (const peer of pair) peer.close(); }
});
