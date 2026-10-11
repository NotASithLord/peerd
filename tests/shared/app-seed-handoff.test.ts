import { expect, test } from 'bun:test';
import { appSeedHandoff, decodeAppSeedHandoff } from '../../extension/shared/app-seed-handoff.js';
import { packBundle, MAX_NETWORK_BUNDLE_BYTES } from '../../extension/shared/bundle/bundle.js';
import { packTransportBundle } from '../../extension/shared/bundle/transport.js';
import { fromBase64, toBase64 } from '../../extension/shared/bundle/bytes.js';
import { buildManifest } from '../../extension/peerd-distributed/content/manifest.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';

const fixture = async (compressed = false) => {
  const files = { 'index.html': new TextEncoder().encode('<h1>Signed App</h1>') };
  const packed = compressed ? await packTransportBundle({ entry: 'index.html', files }) : null;
  const payload = packed?.payload ?? packBundle({ entry: 'index.html', files });
  const { manifest, hash } = await buildManifest({
    payload, identity: await generateIdentity(), ...(packed ? { bundle: packed.descriptor } : {}),
  });
  const dweb = { hash, publisher: manifest.publisher };
  return { files, payload, manifest, dweb, handoff: appSeedHandoff({ files, dweb }, manifest, payload) };
};

for (const compressed of [false, true]) {
  test(`seed handoff decodes ${compressed ? 'compressed' : 'legacy'} bytes and preserves signed representation`, async () => {
    const f = await fixture(compressed);
    const received = JSON.parse(JSON.stringify(f.handoff));
    expect(received.files).toBeUndefined();
    expect(received.seedBundle.manifest).toEqual(f.manifest);
    expect(fromBase64(received.seedBundle.payload)).toEqual(f.payload);
    expect(await decodeAppSeedHandoff(received.seedBundle, received.dweb)).toMatchObject({
      entryFile: 'index.html', files: f.files,
    });
  });
}

test('seed handoff rejects payload, address, publisher and framing corruption', async () => {
  const f = await fixture();
  const changed = f.payload.slice();
  changed[changed.length - 1] ^= 1;
  await expect(decodeAppSeedHandoff({ ...f.handoff.seedBundle, payload: toBase64(changed) }, f.dweb))
    .rejects.toThrow('dweb-seed-payload-invalid');
  await expect(decodeAppSeedHandoff(f.handoff.seedBundle, { ...f.dweb, hash: '0'.repeat(64) }))
    .rejects.toThrow('dweb-seed-hash-mismatch');
  await expect(decodeAppSeedHandoff(f.handoff.seedBundle, { ...f.dweb, publisher: 'different' }))
    .rejects.toThrow('dweb-seed-bundle-invalid');
  await expect(decodeAppSeedHandoff({ ...f.handoff.seedBundle, payload: '?' }, f.dweb))
    .rejects.toThrow();
});

test('a supported App crosses the Chrome message boundary only once', () => {
  // A real legacy representation already accepted by the network. Keeping both
  // its decoded tree and packed bytes exceeds Chromium's 64 MiB message limit.
  const bytes = new Uint8Array(22_000_000).fill(65);
  const files = { 'index.html': { base64: Buffer.from(bytes).toString('base64') } };
  const payload = packBundle({ entry: 'index.html', files: { 'index.html': bytes } });
  const handoff = appSeedHandoff({ files, entryFile: 'index.html', fileKinds: {} }, {}, payload);
  expect(payload.byteLength).toBeLessThan(MAX_NETWORK_BUNDLE_BYTES);
  expect(Buffer.byteLength(JSON.stringify({ ...handoff, files }))).toBeGreaterThan(64 * 1024 * 1024);
  expect(Buffer.byteLength(JSON.stringify(handoff))).toBeLessThan(64 * 1024 * 1024);
  expect(handoff).not.toHaveProperty('files');
}, 30_000);
