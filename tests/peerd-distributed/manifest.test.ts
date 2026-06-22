import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import {
  buildManifest,
  verifyManifest,
  manifestHash,
} from '../../extension/peerd-distributed/content/manifest.js';
import { utf8 } from '../../extension/shared/bundle/bytes.js';

const payload = utf8('the quick brown fox '.repeat(5000)); // spans chunks

describe('signed manifests', () => {
  test('builds, verifies, and the address commits to the manifest', async () => {
    const id = await generateIdentity();
    const { manifest, hash } = await buildManifest({ payload, entry: 'index.html', identity: id, now: () => 1_700_000_000_000 });
    expect(manifest.publisher).toBe(id.did);
    expect(await manifestHash(manifest)).toBe(hash);
    expect((await verifyManifest(manifest)).ok).toBe(true);
  });

  test('pure content-addressed (no publisher) verifies trivially', async () => {
    const { manifest } = await buildManifest({ payload, now: () => 1 });
    expect(manifest.publisher).toBeUndefined();
    expect((await verifyManifest(manifest)).ok).toBe(true);
  });

  test('detects tampering with the chunk list', async () => {
    const id = await generateIdentity();
    const { manifest } = await buildManifest({ payload, identity: id, now: () => 1 });
    manifest.chunks[0].hash = 'f'.repeat(64); // forge a chunk hash
    expect((await verifyManifest(manifest)).ok).toBe(false);
  });

  test('detects tampering with a signed field (size)', async () => {
    const id = await generateIdentity();
    const { manifest } = await buildManifest({ payload, identity: id, now: () => 1 });
    manifest.size = manifest.size + 1;
    expect((await verifyManifest(manifest)).ok).toBe(false);
  });

  // The additive optional `meta` object (DESIGN-10) is canonicalized +
  // hashed like every other field: present → travels and changes the
  // address; tampered → breaks the signature; absent → key omitted.
  test('meta is hashed and signed like every other field', async () => {
    const id = await generateIdentity();
    const meta = { kind: 'app', name: 'calc', tags: ['tool'] };
    const { manifest, hash } = await buildManifest({ payload, meta, identity: id, now: () => 1 });
    expect(manifest.meta).toEqual(meta);
    expect((await verifyManifest(manifest)).ok).toBe(true);

    const { hash: hashNoMeta, manifest: bare } = await buildManifest({ payload, identity: id, now: () => 1 });
    expect('meta' in bare).toBe(false);
    expect(hashNoMeta).not.toBe(hash);

    manifest.meta = { ...meta, name: 'evil' };
    expect((await verifyManifest(manifest)).ok).toBe(false);
  });
});
