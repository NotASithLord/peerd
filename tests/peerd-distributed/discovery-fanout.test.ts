import { expect, test } from 'bun:test';
import { createDiscovery, DISCOVERY, DISCOVERY_BOUNDED_PROFILE, DISCOVERY_PUSH_FANOUT } from '../../extension/peerd-distributed/apps/discovery.js';
import { createLibrary } from '../../extension/peerd-distributed/apps/library.js';
import { buildMeta, metaDwappId } from '../../extension/peerd-distributed/apps/meta.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';

// The carrier abstraction is already authenticated by mesh. Deliver queued
// frames explicitly, while retaining real publisher signatures and verification.
const network = () => {
  let time = 0;
  type Frame = { from: string, to: string, env: any };
  const frames: Frame[] = [];
  const sent: Frame[] = [];
  const nodes = new Map<string, any>();
  const add = (did: string, profile: string | null = DISCOVERY_BOUNDED_PROFILE) => {
    const peers = new Set<string>();
    const blocked = new Set<string>();
    let receive: any;
    let gone: any;
    let holdSign: ((type: number) => Promise<void>) | undefined;
    let silent = false;
    const library = createLibrary({ now: () => time, isBlocked: publisher => blocked.has(publisher) });
    const mesh = {
      peers: () => [...peers].map(did => ({ did })),
      onEnvelope: (callback: any) => { receive = callback; return () => {}; },
      onPeer: () => () => {},
      onPeerGone: (callback: any) => { gone = callback; return () => {}; },
      sign: async (ch: number, typ: number, body: any) => {
        await holdSign?.(typ);
        // Unknown profiles emulate a future/unsupported peer, not local opt-in.
        if (typ === DISCOVERY.SUB && profile === 'future-profile') body = { ...body, dissemination: profile };
        return { ch, typ, body, from: did };
      },
      send: (to: string, env: any) => {
        if (!peers.has(to)) return false;
        sent.push({ from: did, to, env });
        if (!silent) frames.push({ from: did, to, env });
        return true;
      },
    };
    const discovery = createDiscovery({ mesh, identity: { did }, library, now: () => time,
      isBlocked: publisher => blocked.has(publisher), disseminationProfile: profile === DISCOVERY_BOUNDED_PROFILE ? profile : null });
    const node = { did, peers, blocked, library, discovery,
      receive: (frame: Frame) => receive({ env: frame.env, via: frame.from }),
      gone: (did: string) => gone?.({ did }),
      holdSign: (hook?: (type: number) => Promise<void>) => { holdSign = hook; },
      silent: () => { silent = true; } };
    nodes.set(did, node);
    return node;
  };
  const link = (a: any, b: any) => { a.peers.add(b.did); b.peers.add(a.did); };
  const unlink = (a: any, b: any) => {
    a.peers.delete(b.did); b.peers.delete(a.did); a.gone(b.did); b.gone(a.did);
  };
  const pump = async () => {
    let deliveries = 0;
    while (frames.length) {
      if (++deliveries > 10_000) throw new Error('discovery fixture failed to quiesce');
      const frame = frames.shift()!;
      const recipient = nodes.get(frame.to);
      if (recipient?.peers.has(frame.from)) await recipient.receive(frame);
    }
  };
  const reconcile = async () => {
    time += 60_001;
    // Await request signing/admission, then drain the complete metadata wave.
    await Promise.all([...nodes.values()].flatMap(node => [...node.peers].map(did => node.discovery.subscribeTo(did))));
    await pump();
  };
  return { add, link, unlink, pump, reconcile, sent,
    close: () => { for (const node of nodes.values()) node.discovery.close(); },
    assertMetadataOnly: () => expect(sent.every(frame => frame.env.ch === DISCOVERY.CH)).toBe(true) };
};
const card = (identity: any, slug: string, seq = 1) => buildMeta({ slug, name: slug, seq,
  head: { version_id: `v${seq}`, content_addr: 'peerd://p/h', size: 10 } }, identity);
const itemTargets = (net: ReturnType<typeof network>, from: string, start: number) =>
  net.sent.slice(start).filter(frame => frame.from === from && frame.env.typ === DISCOVERY.ITEM).map(frame => frame.to);

test('capable push is bounded and rotates while legacy and unknown peers retain full feeds', async () => {
  const identity = await generateIdentity();
  const net = network(); const source = net.add(identity.did);
  const capable = Array.from({ length: DISCOVERY_PUSH_FANOUT + 3 }, (_, i) => net.add(`capable-${i}`));
  const legacy = net.add('legacy', null); const unknown = net.add('unknown', 'future-profile');
  for (const peer of [...capable, legacy, unknown]) net.link(source, peer);
  try {
    await net.reconcile();
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const start = net.sent.length;
      await source.discovery.announce(await card(identity, `rotation-${i}`)); await net.pump();
      const targets = itemTargets(net, source.did, start);
      expect(targets).toHaveLength(DISCOVERY_PUSH_FANOUT + 2);
      expect(targets).toContain(legacy.did); expect(targets).toContain(unknown.did);
      targets.filter(did => did.startsWith('capable-')).forEach(did => seen.add(did));
    }
    expect(seen.size).toBe(capable.length);
    const replies = net.sent.filter(frame => frame.from === source.did && frame.env.typ === DISCOVERY.SNAPSHOT);
    expect(replies.filter(frame => frame.to.startsWith('capable-')).every(frame =>
      frame.env.body.page.dissemination === DISCOVERY_BOUNDED_PROFILE)).toBe(true);
    expect(replies.filter(frame => ['legacy', 'unknown'].includes(frame.to)).every(frame =>
      frame.env.body.page.dissemination === undefined)).toBe(true);
    net.assertMetadataOnly();
  } finally { net.close(); }
});

test('default-disabled sender preserves full push even when subscribers support the profile', async () => {
  const identity = await generateIdentity(); const net = network();
  const source = net.add(identity.did, null);
  const peers = Array.from({ length: DISCOVERY_PUSH_FANOUT + 2 }, (_, i) => net.add(`peer-${i}`));
  peers.forEach(peer => net.link(source, peer));
  try {
    await net.reconcile(); const start = net.sent.length;
    await source.discovery.announce(await card(identity, 'legacy-default')); await net.pump();
    expect(itemTargets(net, source.did, start)).toHaveLength(peers.length);
    expect(peers.every(peer => peer.library.size() === 1)).toBe(true);
  } finally { net.close(); }
});

test('an omitted bridge and partition rejoin converge through paged repair without payload requests', async () => {
  const identity = await generateIdentity(); const net = network(); const source = net.add(identity.did);
  const leaves = Array.from({ length: DISCOVERY_PUSH_FANOUT + 2 }, (_, i) => net.add(`leaf-${i}`));
  leaves.forEach(peer => net.link(source, peer));
  const tail = net.add('tail');
  try {
    await net.reconcile(); const start = net.sent.length;
    const published = await card(identity, 'bridge'); const id = await metaDwappId(published);
    await source.discovery.announce(published); await net.pump();
    const omitted = leaves.find(peer => !itemTargets(net, source.did, start).includes(peer.did))!;
    expect(omitted).toBeDefined(); expect(omitted.library.get(id)).toBeNull();
    net.link(omitted, tail);
    for (let i = 0; i < 3; i++) await net.reconcile();
    expect(tail.library.get(id)?.seq).toBe(1);
    net.unlink(source, omitted);
    await source.discovery.announce(await card(identity, 'bridge', 2)); await net.pump();
    expect(tail.library.get(id)?.seq).toBe(1);
    net.link(source, omitted);
    for (let i = 0; i < 3; i++) await net.reconcile();
    expect(tail.library.get(id)?.seq).toBe(2);
    expect(leaves.every(peer => peer.library.get(id)?.seq === 2)).toBe(true);
    net.assertMetadataOnly();
  } finally { net.close(); }
});

test('cycles quiesce and a silent neighbor cannot block independent catalog repair', async () => {
  const identity = await generateIdentity(); const net = network(); const source = net.add(identity.did);
  const peers = Array.from({ length: DISCOVERY_PUSH_FANOUT + 3 }, (_, i) => net.add(`cycle-${i}`));
  peers.forEach(peer => net.link(source, peer));
  peers.forEach((peer, i) => net.link(peer, peers[(i + 1) % peers.length]));
  const silent = net.add('silent'); net.link(source, silent); silent.silent();
  try {
    await net.reconcile(); const published = await card(identity, 'cycle'); const id = await metaDwappId(published);
    await source.discovery.announce(published); await net.pump();
    for (let i = 0; i < 3; i++) await net.reconcile();
    expect(peers.every(peer => peer.library.get(id)?.seq === 1)).toBe(true);
    expect(source.discovery.stats().fresh).toBe(0);
    expect(net.sent.length).toBeLessThan(1000);
    net.assertMetadataOnly();
  } finally { net.close(); }
});

for (const change of ['unsubscribe', 'block', 'disable', 'reconnect', 'profile-change'] as const) {
  test(`asynchronous ITEM signing respects ${change} without stale subscription delivery`, async () => {
    const identity = await generateIdentity(); const net = network();
    const source = net.add(identity.did); const receiver = net.add('receiver'); net.link(source, receiver);
    try {
      await net.reconcile();
      const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      source.holdSign(async type => { if (type === DISCOVERY.ITEM) { entered.resolve(); await release.promise; } });
      const start = net.sent.length;
      const announcing = source.discovery.announce(await card(identity, 'fenced'));
      await entered.promise;
      if (change === 'unsubscribe') { await receiver.discovery.unsubscribeFrom(source.did); await net.pump(); }
      if (change === 'block') source.blocked.add(receiver.did);
      if (change === 'disable') { receiver.discovery.setEnabled(false); await Promise.resolve(); await Promise.resolve(); await net.pump(); }
      if (change === 'reconnect') {
        net.unlink(source, receiver); net.link(source, receiver);
        await receiver.discovery.subscribeTo(source.did); await net.pump();
      }
      if (change === 'profile-change') {
        await source.receive({ from: receiver.did, to: source.did, env: {
          ch: DISCOVERY.CH, typ: DISCOVERY.SUB, from: receiver.did,
          body: { catalog: 1, id: 'legacy-mode', after: '', limit: 1 },
        } });
        await net.pump();
      }
      release.resolve(); await announcing; await net.pump();
      expect(itemTargets(net, source.did, start)).toEqual([]);
      net.assertMetadataOnly();
    } finally { net.close(); }
  });
}


test('a profile claim without a valid paged subscription never permits bounded omission', async () => {
  const identity = await generateIdentity(); const net = network(); const source = net.add(identity.did);
  const peers = Array.from({ length: DISCOVERY_PUSH_FANOUT + 2 }, (_, i) => net.add(`invalid-${i}`));
  peers.forEach(peer => net.link(source, peer));
  try {
    await net.reconcile();
    for (const [index, peer] of peers.entries()) {
      await source.receive({ from: peer.did, to: source.did, env: {
        ch: DISCOVERY.CH, typ: DISCOVERY.SUB, from: peer.did,
        body: { catalog: 1, id: `invalid-${index}`, after: 'not-a-cursor', limit: 1,
          dissemination: DISCOVERY_BOUNDED_PROFILE },
      } });
    }
    await net.pump(); const start = net.sent.length;
    await source.discovery.announce(await card(identity, 'invalid-negotiation')); await net.pump();
    expect(itemTargets(net, source.did, start)).toHaveLength(peers.length);
  } finally { net.close(); }
});


test('reused request IDs cannot resurrect a stale profile acknowledgment after unsubscribe', async () => {
  const identity = await generateIdentity(); const net = network();
  const source = net.add(identity.did); const receiver = net.add('receiver'); net.link(source, receiver);
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  try {
    await net.reconcile();
    let held = false;
    source.holdSign(async type => {
      if (type === DISCOVERY.SNAPSHOT && !held) { held = true; entered.resolve(); await release.promise; }
    });
    const message = (typ: number, body: any) => ({ from: receiver.did, to: source.did,
      env: { ch: DISCOVERY.CH, typ, from: receiver.did, body } });
    const request = { catalog: 1, id: 'reused', after: '', limit: 1 };
    const start = net.sent.length;
    const stale = source.receive(message(DISCOVERY.SUB, { ...request, dissemination: DISCOVERY_BOUNDED_PROFILE }));
    await entered.promise;
    await source.receive(message(DISCOVERY.UNSUB, {}));
    await source.receive(message(DISCOVERY.SUB, request));
    release.resolve(); await stale; await net.pump();
    const replies = net.sent.slice(start).filter(frame => frame.from === source.did
      && frame.to === receiver.did && frame.env.typ === DISCOVERY.SNAPSHOT);
    expect(replies).toHaveLength(1);
    expect(replies[0].env.body.page).toEqual({ id: 'reused', after: '', next: null });
    net.assertMetadataOnly();
  } finally { release.resolve(); net.close(); }
});
