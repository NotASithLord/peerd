import { test, expect } from 'bun:test';
import { immutableAppRoot } from '../../extension/shared/address/immutable-app-root.js';
import { formatDwappUri } from '../../extension/shared/address/dwapp-uri.js';
import { fetchImmutableApp, immutableAppSummary } from '../../extension/peerd-distributed/apps/immutable-address.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { buildManifest } from '../../extension/peerd-distributed/content/manifest.js';
import { packBundle } from '../../extension/peerd-distributed/content/bundle.js';

const fixture = async () => {
  const identity = await generateIdentity();
  const payload = packBundle({ entry: 'index.html', files: { 'index.html': new TextEncoder().encode('<h1>App</h1>') } });
  const { manifest, hash } = await buildManifest({ payload, type: 'app', meta: { name: 'Signed title' }, identity });
  return { manifest, payload, hash, identity,
    address: formatDwappUri({ did: identity.did, hash }) };
};

test('manual addresses reject unsupported forms before calling the transport', async () => {
  const f = await fixture(); let fetched = 0;
  for (const address of [formatDwappUri({ hash: f.hash }), `${f.address}/index.html`, `${f.address}?run=1`, `${f.address}#open`, 'https://example.com']) {
    await expect(fetchImmutableApp({ address, fetchApp: async () => { fetched++; return f; } })).rejects.toThrow();
  }
  expect(fetched).toBe(0);
  expect(immutableAppRoot(f.address)).toEqual({ address: f.address, publisher: f.identity.did,
    hash: f.hash, uri: `peerd://${f.identity.did}/${f.hash}` });
});

test('inspection validates bytes and exposes signed summary without execution or discovery lineage', async () => {
  const f = await fixture(); const fetched: string[] = [];
  const verified = await fetchImmutableApp({ address: f.address, fetchApp: async uri => { fetched.push(uri); return f; } });
  expect(fetched).toEqual([`peerd://${f.identity.did}/${f.hash}`]);
  expect(immutableAppSummary(verified)).toMatchObject({ name: 'Signed title', type: 'app', hash: f.hash,
    publisher: f.identity.did, entryFile: 'index.html', fileCount: 1, decodedBytes: 12, containsWasm: false });
  expect(verified.app.dweb.dwapp_id).toBeUndefined();
  expect(verified.app.dweb.seq).toBeUndefined();
  expect(Object.keys(immutableAppSummary(verified))).not.toContain('files');
  const badPayload = f.payload.slice(); badPayload[0] ^= 1;
  await expect(fetchImmutableApp({ address: f.address, fetchApp: async () => ({ ...f, payload: badPayload }) })).rejects.toThrow();
  const other = await generateIdentity();
  await expect(fetchImmutableApp({ address: formatDwappUri({ did: other.did, hash: f.hash }), fetchApp: async () => f })).rejects.toThrow('publisher');
});

test('a signed unnamed App with WASM bytes remains inspectable without a fabricated title', async () => {
  const identity = await generateIdentity();
  const wasm = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const payload = packBundle({ entry: 'index.html', files: {
    'index.html': new TextEncoder().encode('<h1>WASM</h1>'), 'app.wasm': wasm,
  } });
  const { manifest, hash } = await buildManifest({ payload, type: 'app', identity });
  const verified = await fetchImmutableApp({ address: formatDwappUri({ did: identity.did, hash }),
    fetchApp: async () => ({ manifest, payload }) });
  expect(immutableAppSummary(verified)).toMatchObject({ name: null, containsWasm: true, fileCount: 2 });
  expect(verified.app.files['app.wasm']).toEqual(wasm);
});
