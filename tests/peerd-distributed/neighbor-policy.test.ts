import { expect, test } from 'bun:test';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { memoryPair, createBufferedChannel } from '../../extension/peerd-distributed/transport/channel.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { NEIGHBOR_GRACE_MS, NEIGHBOR_ROTATION_MS, TRANSFER_PROTECTION_MS } from '../../extension/peerd-distributed/transport/neighbor-policy.js';

const fixture = async (sparse = true, budget = 16) => {
  let now = 1;
  const audit: Array<{ type: string; detail: any }> = [];
  const mesh = createRoomMesh({ roomId: 'test', identity: await generateIdentity(), sparse, budget, now: () => now,
    audit: (type, detail) => audit.push({ type, detail }) });
  const channels: ReturnType<typeof memoryPair>[number][] = [];
  const remoteChannels = new Map<string, ReturnType<typeof memoryPair>[number]>();
  const add = (did: string, locallySelected = false, info = {}) => {
    const [a, b] = memoryPair(); channels.push(a, b);
    const admitted = mesh.addLink(a, did, info, { locallySelected });
    if (admitted) remoteChannels.set(did, b);
    return admitted;
  };
  return { mesh, add, audit, remoteClose: (did: string) => remoteChannels.get(did)?.close(), advance: (ms: number) => { now += ms; }, close: () => { mesh.close(); for (const c of channels) c.close(); } };
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

test('a rendezvous outage freezes destructive sparse rotation but keeps free-slot admission', async () => {
  const f = await fixture(true, 3);
  try {
    f.add('stable-a', true); f.add('stable-b', true);
    f.mesh.setSparseRotation(false);
    expect(f.add('free-slot')).toBe(true);
    f.advance(NEIGHBOR_GRACE_MS + NEIGHBOR_ROTATION_MS);
    expect(f.add('replacement', true)).toBe(false);
    expect(f.mesh.peers().map(peer => peer.did).sort()).toEqual(['free-slot', 'stable-a', 'stable-b']);
    expect(f.audit.some(entry => entry.detail?.why === 'neighbor-rotation')).toBe(false);
    f.mesh.setSparseRotation(true);
    expect(f.add('replacement', true)).toBe(true);
    expect(f.audit.some(entry => entry.detail?.why === 'neighbor-rotation')).toBe(true);
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


test.each(['remove', 'native close'])('short reconnect through %s preserves age without a quiet-peer penalty', async route => {
  const f = await fixture(true, 3);
  try {
    f.add('quiet'); f.add('local-a', true); f.add('local-b', true);
    f.advance(NEIGHBOR_GRACE_MS);
    if (route === 'remove') f.mesh.removeLink('quiet'); else f.remoteClose('quiet');
    expect(f.mesh.hasLink('quiet')).toBe(false);
    expect(f.add('quiet')).toBe(true);
    expect(f.add('newcomer')).toBe(true);
    expect(f.mesh.hasLink('quiet')).toBe(false);
    expect(f.audit.some(entry => entry.type.includes('cooldown'))).toBe(false);
    expect(f.audit.some(entry => entry.type === 'peer_link_closed' && entry.detail.why === 'neighbor-rotation')).toBe(true);
  } finally { f.close(); }
});

test('repeated complete reconnects cannot replenish an already-owned busy protection window', async () => {
  const f = await fixture(true, 3);
  try {
    f.add('busy'); f.add('local-a', true); f.add('local-b', true);
    f.mesh.contentChannel('busy')!.setHandler(() => {});
    f.advance(NEIGHBOR_GRACE_MS);
    expect(f.add('waiting')).toBe(false);
    for (let n = 0; n < 3; n++) {
      f.remoteClose('busy'); f.advance(10);
      expect(f.add('busy')).toBe(true);
      f.mesh.contentChannel('busy')!.setHandler(() => {});
    }
    f.advance(TRANSFER_PROTECTION_MS - 31);
    expect(f.add('waiting')).toBe(false);
    f.advance(1);
    expect(f.add('waiting')).toBe(true);
    expect(f.mesh.hasLink('busy')).toBe(false);
    expect(f.audit.some(entry => entry.type.includes('cooldown'))).toBe(false);
  } finally { f.close(); }
});

test('retired timing never restores locally selected ownership to an unsolicited reconnect', async () => {
  const f = await fixture(true, 3);
  try {
    f.add('peer', true);
    expect(f.mesh.locallySelectedCount()).toBe(1);
    f.mesh.removeLink('peer');
    expect(f.add('peer', false, { locallySelected: true })).toBe(true);
    expect(f.mesh.locallySelectedCount()).toBe(0);
  } finally { f.close(); }
});

test('expired reconnect custody gives a genuinely returning peer fresh grace', async () => {
  const f = await fixture(true, 3);
  try {
    f.add('returning'); f.add('local-a', true); f.add('local-b', true);
    f.advance(NEIGHBOR_GRACE_MS); f.mesh.removeLink('returning');
    f.advance(NEIGHBOR_GRACE_MS + TRANSFER_PROTECTION_MS);
    expect(f.add('returning')).toBe(true);
    expect(f.add('newcomer')).toBe(false);
    f.advance(NEIGHBOR_GRACE_MS);
    expect(f.add('newcomer')).toBe(true);
  } finally { f.close(); }
});

test('bounded retirement history evicts its oldest entry instead of retaining every authenticated DID', async () => {
  const f = await fixture(true, 3);
  try {
    f.add('old'); f.add('local-a', true); f.add('local-b', true);
    f.advance(NEIGHBOR_GRACE_MS); f.mesh.removeLink('old');
    // More retirements than the two default neighbor cohorts fit in history.
    for (let n = 0; n < 32; n++) { expect(f.add(`churn-${n}`)).toBe(true); f.mesh.removeLink(`churn-${n}`); }
    expect(f.add('old')).toBe(true);
    expect(f.add('newcomer')).toBe(false); // oldest history was evicted: neutral fresh grace
    expect(f.mesh.peers()).toHaveLength(3);
    expect(f.audit.some(entry => entry.type.includes('cooldown'))).toBe(false);
  } finally { f.close(); }
});

test('stale native-close callbacks cannot overwrite timing custody or retire a replacement generation', async () => {
  const f = await fixture(true, 3);
  let staleClose: (() => void) | undefined;
  const old = { send() {}, setHandler() {}, close() {}, onClose(cb: () => void) { staleClose = cb; return () => {}; } };
  try {
    expect(f.mesh.addLink(old, 'peer')).toBe(true);
    f.add('local-a', true); f.add('local-b', true);
    f.advance(NEIGHBOR_GRACE_MS);
    f.mesh.removeLink('peer'); expect(f.add('peer')).toBe(true);
    staleClose!();
    expect(f.mesh.hasLink('peer')).toBe(true);
    expect(f.add('newcomer')).toBe(true);
    expect(f.mesh.hasLink('peer')).toBe(false);
  } finally { f.close(); }
});

test('retirement timing never crosses a mesh lifetime', async () => {
  const old = await fixture(true, 3);
  old.add('peer'); old.advance(NEIGHBOR_GRACE_MS); old.mesh.removeLink('peer'); old.close();
  const fresh = await fixture(true, 3);
  try {
    fresh.advance(NEIGHBOR_GRACE_MS);
    fresh.add('peer'); fresh.add('local-a', true); fresh.add('local-b', true);
    expect(fresh.add('newcomer')).toBe(false);
  } finally { fresh.close(); }
});
