import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { swarmFetch } from '../../extension/peerd-distributed/content/swarm.js';
import { createContentResponder } from '../../extension/peerd-distributed/content/transfer.js';
import { createContentStore } from '../../extension/peerd-distributed/content/store.js';
import { buildManifest } from '../../extension/peerd-distributed/content/manifest.js';
import { packBundle } from '../../extension/peerd-distributed/content/bundle.js';
import { formatPeerdUri } from '../../extension/peerd-distributed/content/uri.js';
import { utf8 } from '../../extension/shared/bundle/bytes.js';

// A channel whose handler is set by the consumer; we bridge it to the responder
// (stands in for a mesh content channel to one provider).
const providerChannel = (store: any) => {
  const respond = createContentResponder({ store });
  let handler: any = null;
  return { send: (req: any) => respond(req, (m: any) => handler?.(m)), setHandler: (h: any) => { handler = h; } };
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
});
