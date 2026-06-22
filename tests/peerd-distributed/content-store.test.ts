import { describe, test, expect } from 'bun:test';
import { createContentStore } from '../../extension/peerd-distributed/content/store.js';

// A minimal two-chunk manifest + bytes, the buildManifest shape the store ingests.
const fixture = (tag: string) => {
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  const manifest = { type: 'app', chunks: [{ hash: `${tag}-c0` }, { hash: `${tag}-c1` }] };
  return { manifest, hash: `${tag}-h`, chunks };
};

describe('content store — the announce-set liability firewall', () => {
  test('unannounce stops serving the manifest and every chunk', () => {
    const store = createContentStore();
    const { manifest, hash, chunks } = fixture('a');
    store.publish({ manifest, hash, chunks });

    expect(store.isAnnounced(hash)).toBe(true);
    expect(store.getManifest(hash)).toBe(manifest);
    expect(store.getChunk('a-c0')).toBe(chunks[0]);

    expect(store.unannounce(hash)).toBe(true);
    expect(store.isAnnounced(hash)).toBe(false);
    expect(store.getManifest(hash)).toBeNull();   // firewall now refuses it
    expect(store.getChunk('a-c0')).toBeNull();
    expect(store.getChunk('a-c1')).toBeNull();
  });

  test('unannounce is idempotent + safe on an unknown hash', () => {
    const store = createContentStore();
    expect(store.unannounce('never-published')).toBe(false);
    const { manifest, hash, chunks } = fixture('b');
    store.publish({ manifest, hash, chunks });
    expect(store.unannounce(hash)).toBe(true);
    expect(store.unannounce(hash)).toBe(false);   // already gone
  });

  test('a chunk shared by two announced bundles stays serveable until BOTH unannounce', () => {
    const store = createContentStore();
    const shared = new Uint8Array([9]);
    // Two manifests that both reference the same chunk hash 'shared-c'.
    store.publish({ manifest: { type: 'app', chunks: [{ hash: 'shared-c' }] }, hash: 'h1', chunks: [shared] });
    store.publish({ manifest: { type: 'app', chunks: [{ hash: 'shared-c' }] }, hash: 'h2', chunks: [shared] });

    store.unannounce('h1');
    expect(store.getChunk('shared-c')).toBe(shared); // h2 still announces it (refcount > 0)
    store.unannounce('h2');
    expect(store.getChunk('shared-c')).toBeNull();   // last announcer gone
  });
});
