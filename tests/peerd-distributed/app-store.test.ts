import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { createBaseNetwork } from '../../extension/peerd-distributed/base-network.js';
import { packBundle, unpackBundle } from '../../extension/peerd-distributed/content/bundle.js';
import { buildManifest } from '../../extension/peerd-distributed/content/manifest.js';
import { installAppBundle } from '../../extension/peerd-distributed/apps/loader.js';

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

// Two base networks over a linked memoryPair mesh — the same shape as the live
// offscreen lobby, minus WebRTC. Proves the app-store content path rides the
// always-on base mesh (the room's primitives, on ch=2, over the lobby).
const linkedPair = async () => {
  const ia = await generateIdentity();
  const ib = await generateIdentity();
  const ma = createRoomMesh({ roomId: 'base', identity: ia });
  const mb = createRoomMesh({ roomId: 'base', identity: ib });
  const a = await createBaseNetwork({ identity: ia, mesh: ma });
  const b = await createBaseNetwork({ identity: ib, mesh: mb });
  const [ca, cb] = memoryPair();
  await Promise.all([
    createSession({ channel: ca, identity: ia }),
    createSession({ channel: cb, identity: ib }),
  ]);
  ma.addLink(ca, ib.did);
  mb.addLink(cb, ia.did);
  return { a, b, ia, ib };
};

describe('the dweb app store (base-network content + discovery)', () => {
  test('publish on one node, fetch + verify the signed bundle on a linked peer', async () => {
    const { a, b, ia } = await linkedPair();
    const { uri, hash } = await a.publishApp({
      name: 'hello', entry: 'index.html', files: { 'index.html': '<h1>hi from the dweb</h1>' },
    });
    expect(uri).toContain(hash); // peerd://<did>/<hash>

    const { manifest, payload } = await b.fetchApp(uri); // ch=2 over the base mesh
    expect(manifest.publisher).toBe(ia.did);             // signed by the publisher
    const { entry, files } = unpackBundle(payload);
    expect(entry).toBe('index.html');
    expect(new TextDecoder().decode(files['index.html'])).toBe('<h1>hi from the dweb</h1>');
    a.close(); b.close();
  });

  test('signed release lineage survives publish, discovery metadata, fetch, and install', async () => {
    const { a, b } = await linkedPair();
    const release = {
      previousVersionId: 'a'.repeat(64),
      gitCommitOid: 'b'.repeat(40),
      changelog: 'add browser Git\nkeep binary assets intact',
    };
    const { uri, hash } = await a.publishApp({
      name: 'versioned', entry: 'index.html', files: { 'index.html': '<h1>v2</h1>' }, release,
    });
    const announced = await a.publishMeta({
      slug: 'versioned', name: 'versioned',
      head: {
        version_id: hash, content_addr: uri, size: 11,
        previous_version_id: release.previousVersionId,
        git_commit_oid: release.gitCommitOid,
        changelog: release.changelog,
      },
    });
    expect(announced.card.value.head).toMatchObject({
      previous_version_id: release.previousVersionId,
      git_commit_oid: release.gitCommitOid,
      changelog: release.changelog,
    });

    const { manifest, payload } = await b.fetchApp(uri);
    expect(manifest.meta?.release).toEqual(release);
    let installed: any = null;
    await installAppBundle({
      uri, manifest, payload,
      install: async (app) => { installed = app; return { id: 'local' }; },
    });
    expect(installed.dweb).toMatchObject({
      previous_version_id: release.previousVersionId,
      source_git_oid: release.gitCommitOid,
      changelog: release.changelog,
    });
    a.close(); b.close();
  });

  test('binary files remain byte-identical through publish, fetch, and install', async () => {
    const { a, b } = await linkedPair();
    const binary = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xff, 0xc0]);
    const { uri } = await a.publishApp({
      name: 'binary', entry: 'index.html',
      files: { 'index.html': '<h1>x</h1>', 'engine.wasm': binary },
    });
    const { manifest, payload } = await b.fetchApp(uri);
    let installed: any = null;
    await installAppBundle({
      uri, manifest, payload,
      install: async (app) => { installed = app; return { id: 'local' }; },
    });
    expect(Array.from(installed.files['engine.wasm'])).toEqual(Array.from(binary));
    a.close(); b.close();
  });

  test('explicit prototype-looking binary path survives peer install', async () => {
    const { a, b } = await linkedPair();
    const binary = new TextEncoder().encode('ASCII protocol bytes');
    const files: Record<string, string | Uint8Array> = Object.fromEntries([
      ['index.html', '<h1>x</h1>'],
      ['__proto__', binary],
    ]);
    const fileKinds: Record<string, 'text' | 'binary'> = Object.fromEntries([
      ['index.html', 'text'],
      ['__proto__', 'binary'],
    ]);
    const { uri } = await a.publishApp({
      name: 'typed', entry: 'index.html',
      files,
      fileKinds,
    });
    const { manifest, payload } = await b.fetchApp(uri);
    let installed: any = null;
    await installAppBundle({
      uri, manifest, payload,
      install: async (app) => { installed = app; return { id: 'local' }; },
    });
    expect(Object.hasOwn(installed.files, '__proto__')).toBe(true);
    expect(Array.from(installed.files['__proto__'])).toEqual(Array.from(binary));
    expect(installed.fileKinds['__proto__']).toBe('binary');
    a.close(); b.close();
  });

  test('share → a subscribed peer gets the card, and the bundle fetches over the mesh', async () => {
    const { a, b } = await linkedPair();
    a.start(); b.start();          // start() runs discovery.subscribeAll() (reconcile linked peers)
    await tick(60);                // SUBSCRIBE → SNAPSHOT settles

    const { uri, hash } = await a.publishApp({ name: 'notes', entry: 'index.html', files: { 'index.html': 'x' } });
    const { dwapp_id } = await a.publishMeta({
      slug: 'notes', name: 'notes', head: { version_id: hash, content_addr: uri, size: 1 },
    });
    await tick(60);

    // B discovered the card over the sovereign subscription plane (it asked on connect).
    expect(b.heardDwapps().some((r: any) => r.dwapp_id === dwapp_id)).toBe(true);
    const row = b.heardDwapps().find((r: any) => r.dwapp_id === dwapp_id);
    expect(row?.head.content_addr).toBe(uri);

    // And the actual bytes pull on demand over the base mesh (Plane 2 fetch path).
    const { manifest } = await b.fetchApp(uri);
    expect(manifest.type).toBe('app');
    a.close(); b.close();
  });

  test('a late joiner resolves a card it never had streamed, via the DHT (by publisher+slug)', async () => {
    const { a, b, ia, ib } = await linkedPair();
    a.start(); b.start();
    await tick(60);
    const { uri, hash } = await a.publishApp({ name: 'late', entry: 'index.html', files: { 'index.html': 'x' } });
    const { dwapp_id } = await a.publishMeta({ slug: 'late', name: 'late', head: { version_id: hash, content_addr: uri, size: 1 } });
    await tick(60);

    // C links only B (which holds A's DHT card), and disables discovery so it gets
    // NO subscription stream — it must resolve the card cold from the DHT.
    const ic = await generateIdentity();
    const mc = createRoomMesh({ roomId: 'base', identity: ic });
    const c = await createBaseNetwork({ identity: ic, mesh: mc });
    c.discovery.setEnabled(false);
    const [cc, cb2] = memoryPair();
    await Promise.all([
      createSession({ channel: cc, identity: ic }),
      createSession({ channel: cb2, identity: ib }),
    ]);
    mc.addLink(cc, ib.did);
    (b as any).node.mesh.addLink(cb2, ic.did);
    c.node.start();
    await tick(40);

    expect(c.heardDwapps().some((r: any) => r.dwapp_id === dwapp_id)).toBe(false); // no stream
    const found = await c.findDwapp(dwapp_id, ia.did, 'late');                      // DHT by (publisher, slug)
    expect(found?.value?.head?.content_addr).toBe(uri);

    a.close(); b.close(); c.close();
  });

  test('reshare = a version UPDATE: same dwapp_id, higher seq, new version_id (no duplicate card)', async () => {
    const { a, b } = await linkedPair();
    a.start(); b.start();
    await tick(60);

    // v1: publish bytes + announce the card under a stable slug.
    const v1 = await a.publishApp({ name: 'editor', entry: 'index.html', files: { 'index.html': 'v1' } });
    const m1 = await a.publishMeta({ slug: 'editor', name: 'editor', seq: 1, head: { version_id: v1.hash, content_addr: v1.uri, size: 2 } });
    await tick(60);
    expect(b.heardDwapps().filter((r: any) => r.dwapp_id === m1.dwapp_id).length).toBe(1);

    // v2: tweak the files (a NEW bundle hash), reshare under the SAME slug + higher seq.
    const v2 = await a.publishApp({ name: 'editor', entry: 'index.html', files: { 'index.html': 'v2 tweaked' } });
    expect(v2.hash).not.toBe(v1.hash);                         // different bytes → different version id
    const m2 = await a.publishMeta({ slug: 'editor', name: 'editor', seq: 2, head: { version_id: v2.hash, content_addr: v2.uri, size: 10 } });
    expect(m2.dwapp_id).toBe(m1.dwapp_id);                     // SAME app identity
    await tick(60);

    // B holds exactly ONE card for the app, now pointing at v2 (the amendment won).
    const rows = b.heardDwapps().filter((r: any) => r.dwapp_id === m1.dwapp_id);
    expect(rows.length).toBe(1);
    expect(rows[0].head.version_id).toBe(v2.hash);
    expect(rows[0].seq).toBe(2);

    // The offscreen share transaction invokes this only after v2 metadata wins.
    // A later delete now has one served version to revoke, not an invisible trail.
    expect(a.node.content.getManifest(v1.hash)).not.toBeNull();
    expect(a.unserveContent(v1.hash)).toBe(true);
    expect(a.node.content.getManifest(v1.hash)).toBeNull();
    expect(a.node.content.getManifest(v2.hash)).not.toBeNull();

    // A stale (lower-seq) re-announce of v1 can't roll it back (no-downgrade).
    await a.publishMeta({ slug: 'editor', name: 'editor', seq: 1, head: { version_id: v1.hash, content_addr: v1.uri, size: 2 } }).catch(() => {});
    await tick(40);
    expect(b.heardDwapps().find((r: any) => r.dwapp_id === m1.dwapp_id)?.head.version_id).toBe(v2.hash);

    a.close(); b.close();
  });

  test('publisher RESTART: re-seeding (stored seq) restores discovery + bytes after the in-memory Library is wiped', async () => {
    // The discovery Library + content store are in-memory, so an MV3 recycle wipes
    // the publisher's OWN apps off the network. This proves the fix: re-publishing
    // the bytes + re-announcing the card with the STORED seq makes a fresh peer
    // discover AND fetch the app again — without a spurious version bump.
    const ia = await generateIdentity();

    // A1 — the original publisher session. Shares v1 at seq 7.
    const ma1 = createRoomMesh({ roomId: 'base', identity: ia });
    const a1 = await createBaseNetwork({ identity: ia, mesh: ma1 });
    a1.start();
    const v1 = await a1.publishApp({ name: 'editor', entry: 'index.html', files: { 'index.html': 'v1' } });
    const m1 = await a1.publishMeta({ slug: 'editor', name: 'editor', seq: 7, head: { version_id: v1.hash, content_addr: v1.uri, size: 2 } });
    a1.close();                                    // the recycle: A's in-memory state is gone

    // A2 — same identity, a FRESH node (empty Library + content store), linked to a
    // brand-new peer C that never heard the original announce.
    const ma2 = createRoomMesh({ roomId: 'base', identity: ia });
    const a2 = await createBaseNetwork({ identity: ia, mesh: ma2 });
    const ic = await generateIdentity();
    const mc = createRoomMesh({ roomId: 'base', identity: ic });
    const c = await createBaseNetwork({ identity: ic, mesh: mc });
    const [cc, ca2] = memoryPair();
    await Promise.all([
      createSession({ channel: cc, identity: ic }),
      createSession({ channel: ca2, identity: ia }),
    ]);
    mc.addLink(cc, ia.did);
    ma2.addLink(ca2, ic.did);
    a2.start(); c.start();
    await tick(60);

    // The BUG, demonstrated: A2's Library is empty, so C's snapshot carries nothing.
    expect(c.heardDwapps().some((r: any) => r.dwapp_id === m1.dwapp_id)).toBe(false);

    // Give C the old card to model an already-warm peer whose no-downgrade
    // cache has the original sequence and version.
    await (c as any).discovery.ingest(m1.card);
    const publish = (a2 as any).node.content.publish;
    let publishCalls = 0;
    (a2 as any).node.content.publish = (bundle: any) => { publishCalls += 1; return publish(bundle); };

    // Reuse the stored manifest timestamp and expected hash. Identical bytes
    // recreate the exact signed version, so the stored sequence stays honest.
    const v1b = await a2.publishApp({
      name: 'editor', entry: 'index.html', files: { 'index.html': 'v1' },
      created: v1.created, expectedHash: v1.hash,
    });
    expect(v1b.hash).toBe(v1.hash);
    const m1b = await a2.publishMeta({ slug: 'editor', name: 'editor', seq: 7, head: { version_id: v1b.hash, content_addr: v1b.uri, size: 2 } });
    expect(m1b.dwapp_id).toBe(m1.dwapp_id);        // same stable app identity (no fork)
    await tick(60);

    await expect(a2.publishApp({
      name: 'editor', entry: 'index.html', files: { 'index.html': 'changed' },
      created: v1.created, expectedHash: v1.hash,
    })).rejects.toThrow('bytes changed');
    expect(publishCalls).toBe(1);                  // mismatch failed before serving bytes

    // C now discovers it again AND can pull the bytes A2 serves again.
    const row: any = c.heardDwapps().find((r: any) => r.dwapp_id === m1.dwapp_id);
    expect(row).toBeTruthy();
    expect(row.seq).toBe(7);                       // re-seed kept the seq — NOT bumped
    expect((await c.fetchApp(row.head.content_addr)).manifest.type).toBe('app');

    a2.close(); c.close();
  });

  test('packed-size rejection happens before content publication', async () => {
    const identity = await generateIdentity();
    const mesh = createRoomMesh({ roomId: 'base', identity });
    const network = await createBaseNetwork({ identity, mesh, maxBundleBytes: 32 });
    const publish = (network as any).node.content.publish;
    let publishCalls = 0;
    (network as any).node.content.publish = (bundle: any) => { publishCalls += 1; return publish(bundle); };
    await expect(network.publishApp({
      name: 'oversize', entry: 'index.html', files: { 'index.html': 'x' },
    })).rejects.toThrow('bundle too large');
    expect(publishCalls).toBe(0);
    network.close();
  });

  test('un-share: deleting stops serving the bytes AND drops the card (re-infection-proof)', async () => {
    const { a, b } = await linkedPair();
    a.start(); b.start();
    await tick(60);

    const { uri, hash } = await a.publishApp({ name: 'ping', entry: 'index.html', files: { 'index.html': 'pong' } });
    const { dwapp_id, card } = await a.publishMeta({
      slug: 'ping', name: 'ping', head: { version_id: hash, content_addr: uri, size: 4 },
    });
    await tick(60);

    // Sanity: B discovered it and the bytes pull.
    expect(b.heardDwapps().some((r: any) => r.dwapp_id === dwapp_id)).toBe(true);
    expect((await b.fetchApp(uri)).manifest.type).toBe('app');

    // A deletes/un-shares it.
    const res = await a.unshareApp({ slug: 'ping' });
    expect(res.unserved).toBe(1);             // one release un-announced from the content store
    expect(res.dwapp_id).toBe(dwapp_id);
    expect(a.heardDwapps().some((r: any) => r.dwapp_id === dwapp_id)).toBe(false); // gone from our own Discover

    // The bytes no longer serve from A (the only provider) — a fetch fails fast.
    await expect(b.fetchApp(uri, { timeoutMs: 300 })).rejects.toThrow();

    // Re-infection guard: a peer re-sending the cached card can't resurrect it.
    expect(await (a as any).discovery.ingest(card)).toBe(false);
    expect(a.heardDwapps().some((r: any) => r.dwapp_id === dwapp_id)).toBe(false);

    // …but re-sharing the SAME app lifts the tombstone (it comes back).
    const re = await a.publishMeta({ slug: 'ping', name: 'ping', seq: Date.now() + 1, head: { version_id: hash, content_addr: uri, size: 4 } });
    expect(a.heardDwapps().some((r: any) => r.dwapp_id === re.dwapp_id)).toBe(true);

    a.close(); b.close();
  });

  test('install persists the version identity (dwapp_id/slug/seq/version_id) for update tracking', async () => {
    const { a, b, ia } = await linkedPair();
    a.start(); b.start();
    const { uri, hash } = await a.publishApp({ name: 'tracked', entry: 'index.html', files: { 'index.html': 'x' } });
    const { manifest, payload } = await b.fetchApp(uri);

    let captured: any = null;
    await installAppBundle({
      uri, manifest, payload, name: 'tracked',
      dwappId: 'dwapp-abc', slug: 'tracked', seq: 7,
      install: async (app) => { captured = app; return { id: 'app-local-1' }; },
    });
    expect(captured.dweb).toMatchObject({
      uri, publisher: ia.did, hash, version_id: hash, dwapp_id: 'dwapp-abc', slug: 'tracked', seq: 7,
    });
    a.close(); b.close();
  });

  test('install binds executable bytes to the publisher named by the card and URI', async () => {
    const { a, b, ib } = await linkedPair();
    const { uri } = await a.publishApp({ name: 'bound', entry: 'index.html', files: { 'index.html': 'x' } });
    const { manifest, payload } = await b.fetchApp(uri);
    await expect(installAppBundle({
      uri, manifest, payload, expectedPublisher: ib.did,
      install: async () => ({ id: 'must-not-install' }),
    })).rejects.toThrow('manifest publisher does not match the discovery card');
    a.close(); b.close();
  });

  test('never installs unsigned executable content, even when its hash is valid', async () => {
    const payload = packBundle({ entry: 'index.html', files: { 'index.html': new TextEncoder().encode('x') } });
    const { manifest, hash } = await buildManifest({ payload, type: 'app', entry: 'index.html' });
    await expect(installAppBundle({
      uri: `peerd://${hash}`, manifest, payload,
      install: async () => ({ id: 'must-not-install' }),
    })).rejects.toThrow('require an authored URI and signed publisher');
  });

  test('install makes you a seeder: a third peer fetches from the installer after the author leaves', async () => {
    const { a, b, ib } = await linkedPair();
    a.start(); b.start();
    const { uri } = await a.publishApp({ name: 'durable', entry: 'index.html', files: { 'index.html': 'durable bytes' } });

    // B installs: fetch over the mesh, then re-seed so B becomes a provider.
    const fetched = await b.fetchApp(uri);
    await b.seedApp(fetched);
    a.close();                       // the AUTHOR leaves the network entirely

    // C joins, links ONLY B (not the gone author), and still gets the bytes.
    const ic = await generateIdentity();
    const mc = createRoomMesh({ roomId: 'base', identity: ic });
    const c = await createBaseNetwork({ identity: ic, mesh: mc });
    const [cc, cb2] = memoryPair();
    await Promise.all([
      createSession({ channel: cc, identity: ic }),
      createSession({ channel: cb2, identity: ib }),
    ]);
    mc.addLink(cc, ib.did);
    (b as any).node.mesh.addLink(cb2, ic.did);
    c.node.start();
    await tick(40);

    const { manifest, payload } = await c.fetchApp(uri); // served by B, the installer-seeder
    expect(manifest.publisher).toBe((a as any).did);     // still the original author's signed bundle
    expect(new TextDecoder().decode(unpackBundle(payload).files['index.html'])).toBe('durable bytes');
    b.close(); c.close();
  });
});
