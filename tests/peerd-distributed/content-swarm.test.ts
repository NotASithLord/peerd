import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { swarmFetch } from '../../extension/peerd-distributed/content/swarm.js';
import { createContentResponder, createChannelClient, fetchBundle } from '../../extension/peerd-distributed/content/transfer.js';
import { createContentStore } from '../../extension/peerd-distributed/content/store.js';
import { buildManifest } from '../../extension/peerd-distributed/content/manifest.js';
import { packBundle, packTransportBundle, unpackBundle } from '../../extension/peerd-distributed/content/bundle.js';
import { formatPeerdUri } from '../../extension/peerd-distributed/content/uri.js';
import { createRoomMesh } from '../../extension/peerd-distributed/transport/mesh.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { utf8, fromBase64, toBase64 } from '../../extension/shared/bundle/bytes.js';

// A channel whose handler is set by the consumer; we bridge it to the responder
// (stands in for a mesh content channel to one provider).
const providerChannel = (store: any, transform = (message: any) => message) => {
  const respond = createContentResponder({ store });
  let handler: any = null;
  return { send: (req: any) => respond(req, (m: any) => handler?.(transform(m))), setHandler: (h: any) => { handler = h; } };
};

const big = (n: number) => 'x'.repeat(n);

const publishInto = async (store: any, identity: any, files: Record<string, string>) => {
  const bytes: Record<string, Uint8Array> = {};
  for (const [p, t] of Object.entries(files)) bytes[p] = utf8(t);
  const payload = packBundle({ entry: 'index.html', files: bytes });
  const { manifest, hash, chunks } = await buildManifest({ payload, type: 'app', entry: 'index.html', identity });
  store.publish({ manifest, hash, chunks });
  return { uri: formatPeerdUri({ did: identity.did, hash }), hash, chunks };
};

describe('content/swarm — multi-provider fetch', () => {
  test('fetches + verifies a multi-chunk bundle striped across two providers', async () => {
    const pub = await generateIdentity();
    // > 256KB so the bundle spans multiple chunks (real swarm striping).
    const files = { 'index.html': big(300_000), 'app.wasm': big(300_000) };
    const sA = createContentStore(); const sB = createContentStore();
    const { uri } = await publishInto(sA, pub, files);
    await publishInto(sB, pub, files); // both providers hold the full bundle

    const channels: Record<string, any> = { A: providerChannel(sA), B: providerChannel(sB) };
    const { manifest, payload } = await swarmFetch({
      uri, providers: ['A', 'B'], channelFor: (did) => channels[did], timeoutMs: 2000,
    });
    expect(manifest.publisher).toBe(pub.did);
    expect(payload.length).toBe(manifest.size);
  });

  test('per-chunk failover: a provider missing a chunk does not break the fetch', async () => {
    const pub = await generateIdentity();
    const files = { 'index.html': big(300_000), 'app.wasm': big(300_000) };
    const full = createContentStore();
    const { uri, chunks } = await publishInto(full, pub, files);

    // A partial provider that holds the manifest + only the FIRST chunk.
    const partial = createContentStore();
    await publishInto(partial, pub, files);
    // monkeypatch: partial returns null for every chunk except chunks[0]
    const realGetChunk = partial.getChunk;
    const firstHash = (await (async () => {
      const { sha256hex } = await import('../../extension/peerd-distributed/content/chunk.js');
      return sha256hex(chunks[0]);
    })());
    (partial as any).getChunk = (h: string) => (h === firstHash ? realGetChunk(h) : null);

    const channels: Record<string, any> = { full: providerChannel(full), partial: providerChannel(partial) };
    const { payload, manifest } = await swarmFetch({
      uri, providers: ['partial', 'full'], channelFor: (did) => channels[did], timeoutMs: 2000,
    });
    expect(payload.length).toBe(manifest.size); // 'full' covered the chunks 'partial' lacked
  });

  test('throws when no provider is reachable', async () => {
    const pub = await generateIdentity();
    const s = createContentStore();
    const { uri } = await publishInto(s, pub, { 'index.html': 'hi' });
    await expect(swarmFetch({ uri, providers: ['nobody'], channelFor: () => null })).rejects.toThrow();
  });

  test('treats an oversized wire chunk as a provider miss before retention', async () => {
    const pub = await generateIdentity();
    const store = createContentStore();
    const { uri } = await publishInto(store, pub, { 'index.html': 'hello' });
    const channel = providerChannel(store, (message) => {
      if (message.t !== 'CHUNK') return message;
      const bytes = fromBase64(message.bytes);
      const oversized = new Uint8Array(bytes.length + 1);
      oversized.set(bytes);
      return { ...message, bytes: toBase64(oversized) };
    });
    await expect(swarmFetch({
      uri, providers: ['hostile'], channelFor: () => channel, timeoutMs: 2000,
    })).rejects.toThrow(/chunk unavailable on all providers/);
  });
});


describe('content transfer ownership and failover', () => {
  test('invalid manifest from the first provider does not suppress a valid provider', async () => {
    const identity = await generateIdentity();
    const store = createContentStore();
    const { uri } = await publishInto(store, identity, { 'index.html': 'verified' });
    const channels: Record<string, any> = {
      bad: providerChannel(store, (m) => m.t === 'MANIFEST' ? { ...m, manifest: {} } : m),
      good: providerChannel(store),
    };
    expect((await swarmFetch({ uri, providers: ['bad', 'good'], channelFor: (did) => channels[did] })).manifest.publisher).toBe(identity.did);
  });

  test('parallel downloads and stale cleanup preserve each transfer on the same peer', async () => {
    const publisher = await generateIdentity();
    const reader = await generateIdentity();
    const store = createContentStore();
    const first = await publishInto(store, publisher, { 'index.html': 'first' });
    const second = await publishInto(store, publisher, { 'index.html': 'second' });
    const serving = createRoomMesh({ roomId: 'transfers', identity: publisher });
    const reading = createRoomMesh({ roomId: 'transfers', identity: reader });
    const [a, b] = memoryPair();
    serving.addLink(a, reader.did);
    reading.addLink(b, publisher.did);
    serving.serveContent(store);
    try {
      const results = await Promise.all([reading.fetchFrom(publisher.did, first.uri), reading.fetchFrom(publisher.did, second.uri)]);
      expect(results).toHaveLength(2);
      expect(results[0].payload).not.toEqual(results[1].payload);
      const old = reading.contentChannel(publisher.did)!;
      old.setHandler(() => {});
      const [c, d] = memoryPair();
      serving.addLink(c, reader.did);
      reading.addLink(d, publisher.did);
      const next = reading.fetchFrom(publisher.did, first.uri);
      old.setHandler(null);
      expect(() => old.send({ t: 'MANIFEST_REQ', hash: first.hash })).toThrow('closed');
      expect((await next).payload).toEqual(results[0].payload);
    } finally { reading.close(); serving.close(); }
  });

  test('manifest-silent partial providers remain fallback chunk sources', async () => {
    const publisher = await generateIdentity();
    const store = createContentStore();
    const { uri } = await publishInto(store, publisher, { 'index.html': 'healthy' });
    const respond = createContentResponder({ store });
    let silentHandler: any;
    let servedChunks = 0;
    const silent = {
      send: (message: any) => {
        if (message.t === 'MANIFEST_REQ') return;
        servedChunks++;
        respond(message, (response) => silentHandler?.(response));
      },
      setHandler: (handler: any) => { silentHandler = handler; },
    };
    const channels: Record<string, any> = { silent, healthy: providerChannel(store, (message) =>
      message.t === 'CHUNK' ? { t: 'NOCHUNK', hash: message.hash } : message) };
    // The test deadline is shorter than the transfer timeout: serial selection
    // cannot complete, whereas the good manifest starts downloading at once.
    const result = await swarmFetch({ uri, providers: ['silent', 'healthy'], channelFor: (did) => channels[did], timeoutMs: 60_000 });
    expect(result.manifest.publisher).toBe(publisher.did);
    expect(servedChunks).toBeGreaterThan(0);
    expect(silentHandler).toBeNull();
  }, 2000);

  test('manifest selection never exceeds its bounded concurrency', async () => {
    const publisher = await generateIdentity();
    const store = createContentStore();
    const { uri } = await publishInto(store, publisher, { 'index.html': 'bounded' });
    const sends: Array<() => void> = [];
    const channels = Array.from({ length: 8 }, () => {
      let handler: any;
      return {
        send: (message: any) => { sends.push(() => handler?.({ t: 'NOMANIFEST', hash: message.hash })); },
        setHandler: (value: any) => { handler = value; },
      };
    });
    const result = swarmFetch({ uri, providers: channels.map((_, i) => String(i)), channelFor: (did) => channels[Number(did)], timeoutMs: 60_000 }).catch((error: Error) => error);
    expect(sends).toHaveLength(3);
    for (let i = 0; i < channels.length; i++) {
      expect(sends.length - i).toBeLessThanOrEqual(3);
      sends[i]();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(await result).toBeInstanceOf(Error);
  });

  test('closing or replacing a mesh link immediately cancels its pending requests', async () => {
    const identity = await generateIdentity();
    const peer = await generateIdentity();
    const mesh = createRoomMesh({ roomId: 'close-transfer', identity });
    try {
      const [a, b] = memoryPair();
      mesh.addLink(a, peer.did);
      const old = createChannelClient(mesh.contentChannel(peer.did)!, 60_000);
      const manifest = old.manifest('a'.repeat(64)).catch((error: Error) => error);
      const chunk = old.chunk('b'.repeat(64)).catch((error: Error) => error);
      const [c, d] = memoryPair();
      mesh.addLink(c, peer.did);
      expect(await manifest).toMatchObject({ message: 'content client closed' });
      expect(await chunk).toMatchObject({ message: 'content client closed' });
      const fresh = createChannelClient(mesh.contentChannel(peer.did)!, 60_000);
      const pending = fresh.manifest('c'.repeat(64)).catch((error: Error) => error);
      old.close();
      d.send({ t: 'NOMANIFEST', hash: 'c'.repeat(64) });
      expect(await pending).toMatchObject({ t: 'NOMANIFEST' });
      const disconnected = fresh.chunk('d'.repeat(64)).catch((error: Error) => error);
      d.close();
      expect(await disconnected).toMatchObject({ message: 'content client closed' });
      await expect(fresh.manifest('e'.repeat(64))).rejects.toThrow('closed');
      b.close();
    } finally { mesh.close(); }
  }, 2000);

  test('parallel downloads sharing chunk hashes both verify the returned bytes', async () => {
    const publisher = await generateIdentity();
    const reader = await generateIdentity();
    const store = createContentStore();
    const { uri } = await publishInto(store, publisher, { 'index.html': 'same content' });
    const serving = createRoomMesh({ roomId: 'shared-content', identity: publisher });
    const reading = createRoomMesh({ roomId: 'shared-content', identity: reader });
    const [a, b] = memoryPair();
    serving.addLink(a, reader.did);
    reading.addLink(b, publisher.did);
    serving.serveContent(store);
    try {
      const [first, second] = await Promise.all([reading.fetchFrom(publisher.did, uri), reading.fetchFrom(publisher.did, uri)]);
      expect(first.payload).toEqual(second.payload);
      expect(first.manifest.publisher).toBe(publisher.did);
      const readChunk = store.getChunk;
      store.getChunk = (hash) => {
        const chunk = readChunk(hash)?.slice();
        if (chunk?.length) chunk[0] ^= 1;
        return chunk;
      };
      const corrupted = await Promise.allSettled([reading.fetchFrom(publisher.did, uri), reading.fetchFrom(publisher.did, uri)]);
      expect(corrupted.map((result) => result.status)).toEqual(['rejected', 'rejected']);
      for (const result of corrupted) {
        if (result.status === 'rejected') expect(result.reason.message).toContain('chunk hash mismatch');
      }
    } finally { reading.close(); serving.close(); }
  });

  test('closing a client cancels pending requests and refuses new requests', async () => {
    let handler: any;
    let sends = 0;
    const client = createChannelClient({ send: () => { sends++; }, setHandler: (h) => { handler = h; } }, 60_000);
    const pending = client.manifest('hash').catch((error: Error) => error);
    client.close();
    expect(await pending).toMatchObject({ message: 'content client closed' });
    expect(handler).toBeNull();
    await expect(client.chunk('hash')).rejects.toThrow('closed');
    expect(sends).toBe(1);
  });

  test('a failed standalone transfer detaches its handler', async () => {
    const publisher = await generateIdentity();
    const store = createContentStore();
    const { uri } = await publishInto(store, publisher, { 'index.html': 'hello' });
    let handler: any;
    await expect(fetchBundle({ uri, channel: {
      send: () => { throw new Error('link lost'); },
      setHandler: (h) => { handler = h; },
    } })).rejects.toThrow('link lost');
    expect(handler).toBeNull();
  });
});


test('contribution evidence excludes candidates supplying invalid or missing chunks', async () => {
  const identity = await generateIdentity();
  const store = createContentStore();
  const { uri } = await publishInto(store, identity, { 'index.html': 'verified' });
  const channels: Record<string, any> = {
    bad: providerChannel(store, (m) => m.t === 'CHUNK' ? { ...m, bytes: toBase64(utf8('garbage')) } : m),
    missing: providerChannel(createContentStore()),
    good: providerChannel(store),
  };
  const result = await swarmFetch({ uri, providers: ['bad', 'missing', 'good'], channelFor: (did) => channels[did] });
  expect(result.providers).toEqual(['bad', 'missing', 'good']);
  expect(result.verifiedContributors).toEqual(['good']);
});


test('a full compressed-hash failure never exposes contribution evidence', async () => {
  const identity = await generateIdentity();
  const packed = await packTransportBundle({ entry: 'index.html', files: { 'index.html': utf8('hello') } });
  const signed = await buildManifest({ payload: packed.payload, type: 'app', entry: 'index.html', identity,
    bundle: { ...packed.descriptor, compressedHash: '0'.repeat(64) } });
  const store = createContentStore();
  store.publish(signed);
  const channel = providerChannel(store);
  let chunkSeen = false;
  await expect(swarmFetch({ uri: formatPeerdUri({ did: identity.did, hash: signed.hash }),
    providers: ['peer'], channelFor: () => channel,
    onProgress: (progress) => { if (progress.phase === 'chunk') chunkSeen = true; },
  })).rejects.toThrow('compressed bundle hash mismatch');
  expect(chunkSeen).toBe(true); // individually valid chunks still yield no successful result
});

test('verified transport contributions do not assert that app bytes are installable', async () => {
  const identity = await generateIdentity();
  const signed = await buildManifest({ payload: utf8('not an app container'), type: 'app', entry: 'index.html', identity });
  const store = createContentStore();
  store.publish(signed);
  const channel = providerChannel(store);
  const result = await swarmFetch({ uri: formatPeerdUri({ did: identity.did, hash: signed.hash }),
    providers: ['peer'], channelFor: () => channel });
  expect(result.verifiedContributors).toEqual(['peer']);
  expect(() => unpackBundle(result.payload)).toThrow();
});


test('unrelated silent neighbors never receive chunks ahead of a qualified holder', async () => {
  const identity = await generateIdentity();
  const store = createContentStore();
  const { uri } = await publishInto(store, identity, { 'index.html': 'available immediately' });
  let requests = 0; let handler: any;
  const silent = { send: (message: any) => { if (message.t === 'CHUNK_REQ') requests++; }, setHandler: (h: any) => { handler = h; } };
  const channels: Record<string, any> = { silent, healthy: providerChannel(store) };
  const result = await swarmFetch({ uri, providers: ['silent', 'healthy'], channelFor: (did) => channels[did], timeoutMs: 60_000 });
  expect(result.verifiedContributors).toEqual(['healthy']);
  expect(requests).toBe(0);
  expect(handler).toBeNull();
}, 2000);

test('a qualified seeder completes useful work while publisher requests remain pending', async () => {
  const identity = await generateIdentity();
  const store = createContentStore();
  const { uri } = await publishInto(store, identity, {
    'index.html': ['a', 'b', 'c', 'd', 'e', 'f'].map(letter => letter.repeat(262_144)).join(''),
  });
  const respond = createContentResponder({ store });
  const handlers: Record<string, any> = {};
  const pendingPublisher: Array<() => void> = [];
  const publisherBusy = Promise.withResolvers<void>();
  const seederQualified = Promise.withResolvers<void>();
  const seederServed = Promise.withResolvers<void>();
  let releaseManifest: (() => void) | undefined;
  let holdPublisher = true;
  const channels = Object.fromEntries(['publisher', 'silent', 'seeder', 'hold', 'marker'].map(did => [did, {
    setHandler: (handler: any) => { handlers[did] = handler; },
    send: (request: any) => {
      // Publisher qualification advances its probe worker into 'hold'. Only
      // the seeder can advance into 'marker', after completing verification.
      if (did === 'marker') { seederQualified.resolve(); return; }
      if (did === 'silent' || did === 'hold') return;
      if (did === 'seeder' && request.t === 'MANIFEST_REQ') {
        releaseManifest = () => { void respond(request, message => handlers[did]?.(message)); };
        return;
      }
      const serve = () => { void respond(request, message => handlers[did]?.(message)); };
      if (did === 'publisher' && request.t === 'CHUNK_REQ' && holdPublisher) {
        pendingPublisher.push(serve);
        if (pendingPublisher.length === 3) publisherBusy.resolve();
      } else {
        serve();
        if (did === 'seeder' && request.t === 'CHUNK_REQ') seederServed.resolve();
      }
    },
  }]));
  let verifiedChunks = 0;
  const seederVerified = Promise.withResolvers<void>();
  const result = swarmFetch({ uri, providers: Object.keys(channels), channelFor: did => channels[did], timeoutMs: 60_000,
    onProgress: progress => {
      // Exactly one publisher response is released before this checkpoint;
      // a second verified chunk therefore came from the seeder.
      if (progress.phase === 'chunk' && ++verifiedChunks === 2) seederVerified.resolve();
    },
  });
  await publisherBusy.promise;
  expect(releaseManifest).toBeDefined();
  releaseManifest!();
  await seederQualified.promise;
  pendingPublisher.shift()!();
  await seederServed.promise;
  await seederVerified.promise;
  expect(pendingPublisher).toHaveLength(2);
  holdPublisher = false;
  for (const serve of pendingPublisher) serve();
  expect((await result).verifiedContributors.sort()).toEqual(['publisher', 'seeder']);
  expect(Object.values(handlers).every(handler => handler === null)).toBe(true);
}, 2000);

test('a late manifest from a blocked candidate cannot authorize chunk work', async () => {
  const identity = await generateIdentity();
  const store = createContentStore();
  const { uri } = await publishInto(store, identity, { 'index.html': 'safe' });
  let blocked = false; let forbiddenChunks = 0;
  const bad = providerChannel(store, (message) => {
    if (message.t === 'MANIFEST') blocked = true;
    if (message.t === 'CHUNK') forbiddenChunks++;
    return message;
  });
  const channels: Record<string, any> = { bad, healthy: providerChannel(store) };
  const result = await swarmFetch({ uri, providers: ['bad', 'healthy'], channelFor: (did) => channels[did], isAllowed: (did) => did !== 'bad' || !blocked });
  expect(result.verifiedContributors).toEqual(['healthy']);
  expect(forbiddenChunks).toBe(0);
});


test('a publisher-qualified address rejects a different signer before fetching chunks', async () => {
  const identity = await generateIdentity();
  const other = await generateIdentity();
  const store = createContentStore();
  const { hash } = await publishInto(store, identity, { 'index.html': 'wrong identity' });
  let chunks = 0;
  const channel = providerChannel(store, (message) => { if (message.t === 'CHUNK') chunks++; return message; });
  const uri = formatPeerdUri({ did: other.did, hash });
  await expect(swarmFetch({ uri, providers: ['source'], channelFor: () => channel })).rejects.toThrow('no reachable provider');
  expect(chunks).toBe(0);
});


test('overlapping probes and downloads have separate bounded pools and detach on completion', async () => {
  const identity = await generateIdentity();
  const store = createContentStore();
  const { uri } = await publishInto(store, identity, { 'index.html': 'a'.repeat(300_000), 'other': 'b'.repeat(900_000) });
  const respond = createContentResponder({ store });
  let manifests = 0; let chunks = 0; let maxTotal = 0; let maxChunks = 0;
  let holdChunks = true;
  const pending: Array<() => void> = [];
  const handlers: Record<string, any> = {};
  const channels = Object.fromEntries(['source', 'silent1', 'silent2', 'unused'].map((did) => [did, {
    setHandler: (handler: any) => { handlers[did] = handler; },
    send: (request: any) => {
      if (request.t === 'MANIFEST_REQ') {
        manifests++;
        maxTotal = Math.max(maxTotal, manifests + chunks);
        expect(manifests).toBeLessThanOrEqual(3);
        if (did === 'source') respond(request, (message) => { manifests--; handlers[did]?.(message); });
        return;
      }
      chunks++;
      maxChunks = Math.max(maxChunks, chunks);
      maxTotal = Math.max(maxTotal, manifests + chunks);
      expect(chunks).toBeLessThanOrEqual(3);
      const serve = () => {
        respond(request, (message) => handlers[did]?.(message));
        chunks--;
      };
      if (holdChunks) pending.push(serve); else serve();
    },
  }]));
  const result = swarmFetch({ uri, providers: Object.keys(channels), channelFor: (did) => channels[did], timeoutMs: 60_000 });
  while (pending.length < 3) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(maxChunks).toBe(3);
  expect(maxTotal).toBeGreaterThan(3);
  expect(maxTotal).toBeLessThanOrEqual(6);
  holdChunks = false;
  for (const serve of pending) serve();
  await result;
  expect(Object.values(handlers).every((handler) => handler === null)).toBe(true);
});

test('a newly qualified seeder is preferred over silent fallback after a delayed miss', async () => {
  const identity = await generateIdentity();
  const store = createContentStore();
  const { uri } = await publishInto(store, identity, { 'index.html': 'available' });
  const respond = createContentResponder({ store });
  const handlers: Record<string, any> = {};
  let releaseManifest: (() => void) | undefined;
  let releaseMiss: (() => void) | undefined;
  let silentChunks = 0;
  const firstPending = Promise.withResolvers<void>();
  const qualified = Promise.withResolvers<void>();
  const channels = Object.fromEntries(['first', 'silent', 'late', 'hold', 'marker'].map((did) => [did, {
    setHandler: (handler: any) => { handlers[did] = handler; },
    send: (request: any) => {
      if (did === 'marker') { qualified.resolve(); return; }
      if (did === 'hold') return;
      if (did === 'silent') { if (request.t === 'CHUNK_REQ') silentChunks++; return; }
      if (did === 'late' && request.t === 'MANIFEST_REQ') {
        releaseManifest = () => { respond(request, (message) => handlers[did]?.(message)); };
        return;
      }
      if (did === 'first' && request.t === 'CHUNK_REQ') {
        releaseMiss = () => handlers[did]?.({ t: 'NOCHUNK', hash: request.hash });
        firstPending.resolve();
        return;
      }
      return respond(request, (message) => handlers[did]?.(message));
    },
  }]));
  const result = swarmFetch({ uri, providers: Object.keys(channels), channelFor: (did) => channels[did], timeoutMs: 60_000 });
  await firstPending.promise;
  expect(releaseManifest).toBeDefined();
  releaseManifest!();
  // The first probe worker is held at 'hold', and the second at 'silent'.
  // Only the late seeder's completed qualification can dispatch 'marker'.
  await qualified.promise;
  releaseMiss!();
  expect((await result).verifiedContributors).toEqual(['late']);
  expect(silentChunks).toBe(0);
}, 2000);
