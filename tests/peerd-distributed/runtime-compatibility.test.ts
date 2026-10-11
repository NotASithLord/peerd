import { expect, test } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { buildManifest } from '../../extension/peerd-distributed/content/manifest.js';
import { packBundle } from '../../extension/peerd-distributed/content/bundle.js';
import { createContentStore } from '../../extension/peerd-distributed/content/store.js';
import { createContentResponder } from '../../extension/peerd-distributed/content/transfer.js';
import { swarmFetch } from '../../extension/peerd-distributed/content/swarm.js';
import { prepareAppBundle } from '../../extension/peerd-distributed/apps/loader.js';
import { buildMeta, verifyMeta } from '../../extension/peerd-distributed/apps/meta.js';
import { assertAppRuntime } from '../../extension/shared/app-runtime.js';

const core = { schema: 1, target: 'browser-app', requires: ['wasm-core'] };
const fixture = async (runtime: unknown, embedded: unknown = runtime) => {
  const identity = await generateIdentity();
  const files = { 'index.html': new TextEncoder().encode('<h1>WASM</h1>'),
    'peerd.json': new TextEncoder().encode(JSON.stringify({ schema: 1, kind: 'app', entry: 'index.html', agent: { kind: 'bound-app' }, capabilities: [], ...(embedded === undefined ? {} : { runtime: embedded }) })) };
  const payload = packBundle({ entry: 'index.html', files });
  const built = await buildManifest({ payload, type: 'app', entry: 'index.html', identity, ...(runtime === undefined ? {} : { meta: { runtime } }) });
  return { ...built, identity, payload, uri: `peerd://${identity.did}/${built.hash}` };
};

test('unsupported signed requirements reject before content chunks and detach probes', async () => {
  const built = await fixture({ ...core, target: 'wasi' });
  const store = createContentStore(); store.publish(built);
  const respond = createContentResponder({ store });
  let handler: any; let chunkRequests = 0;
  const channel = { setHandler: (h: any) => { handler = h; }, send: (request: any) => {
    if (request.t === 'CHUNK_REQ') chunkRequests++;
    return respond(request, (message) => handler?.(message));
  } };
  await expect(swarmFetch({ uri: built.uri, providers: ['source'], channelFor: () => channel,
    acceptManifest: manifest => { assertAppRuntime(manifest.meta?.runtime, ['wasm-core']); },
  })).rejects.toThrow('Unsupported App runtime target');
  expect(chunkRequests).toBe(0); expect(handler).toBeNull();
});

test('the loader binds runtime claims to decoded package bytes and allows legacy', async () => {
  const supported = await fixture(core);
  expect((await prepareAppBundle(supported)).entryFile).toBe('index.html');
  const legacy = await fixture(undefined);
  expect((await prepareAppBundle(legacy)).entryFile).toBe('index.html');
  await expect(prepareAppBundle(await fixture(core, { ...core, requires: [] }))).rejects.toThrow('signed version');
  await expect(prepareAppBundle(await fixture(undefined, core))).rejects.toThrow('signed version');
});

test('runtime requirements participate in signed card identity', async () => {
  const built = await fixture(core);
  const card = await buildMeta({ slug: 'wasm', name: 'WASM', seq: 1,
    head: { version_id: built.hash, content_addr: built.uri, size: built.payload.length, runtime: core } }, built.identity);
  expect(await verifyMeta(card)).toBe(true);
  const changed = structuredClone(card);
  changed.value.head.runtime = { ...core, requires: [] };
  expect(await verifyMeta(changed)).toBe(false);
});
