import { describe, test, expect } from 'bun:test';
import {
  assertBundleWithinLimits, buildManifest, decodeCommittedChunk, MAX_BUNDLE_BYTES, MAX_BUNDLE_CHUNKS,
} from '../../extension/peerd-distributed/content/manifest.js';
import { fetchBundle } from '../../extension/peerd-distributed/content/transfer.js';
import { CHUNK_SIZE } from '../../extension/shared/bundle/chunk.js';
import { toBase64 } from '../../extension/shared/bundle/bytes.js';

// A hostile publisher signs their OWN manifest, so the hash + signature checks
// never bound its declared size or chunk list. assertBundleWithinLimits is the
// pre-fetch ceiling that keeps a bundle from being buffered/reassembled into a
// multi-GB allocation (an OOM DoS of the offscreen document).

const chunk = (size: number, hash = 'a'.repeat(64)) => ({ hash, size });

describe('assertBundleWithinLimits — bundle OOM guard', () => {
  test('accepts a legit manifest (size === sum of chunk sizes, within cap)', () => {
    const chunks = [chunk(262144, 'a'.repeat(64)), chunk(100, 'b'.repeat(64))];
    expect(() => assertBundleWithinLimits({ size: 262244, chunks } as any)).not.toThrow();
  });

  test('rejects a multi-GB bundle (many distinct chunks) before any fetch', () => {
    const big = Array.from({ length: 20000 }, (_, i) => chunk(262144, String(i).padEnd(64, '0')));
    expect(() => assertBundleWithinLimits({ size: 20000 * 262144, chunks: big } as any)).toThrow(/too many|too large|wire ceiling/);
  });

  test('rejects the reassembly amplification: thousands of refs to ONE chunk', () => {
    // fetched once (deduped), but reassembly maps over every entry → ~10GB
    const amp = Array.from({ length: 40000 }, () => chunk(262144, 'a'.repeat(64)));
    expect(() => assertBundleWithinLimits({ size: 40000 * 262144, chunks: amp } as any)).toThrow(/too many|too large|wire ceiling/);
  });

  test('rejects a manifest that under-reports size to dodge a naive size check', () => {
    const chunks = [chunk(262144), chunk(262144)];
    expect(() => assertBundleWithinLimits({ size: 100, chunks } as any)).toThrow(/does not match/);
  });

  test('rejects non-integer / negative chunk sizes', () => {
    expect(() => assertBundleWithinLimits({ size: 0, chunks: [chunk(-1)] } as any)).toThrow(/chunk size invalid/);
    expect(() => assertBundleWithinLimits({ size: 0, chunks: [chunk(1.5)] } as any)).toThrow(/chunk size invalid/);
  });

  test('rejects zero-size, over-size, malformed, and inconsistent duplicate chunks', () => {
    expect(() => assertBundleWithinLimits({ size: 0, chunks: [chunk(0)] } as any)).toThrow(/chunk size invalid/);
    expect(() => assertBundleWithinLimits({ size: CHUNK_SIZE + 1, chunks: [chunk(CHUNK_SIZE + 1)] } as any)).toThrow(/chunk size invalid/);
    expect(() => assertBundleWithinLimits({ size: 1, chunks: [chunk(1, 'not-a-hash')] } as any)).toThrow(/chunk hash invalid/);
    expect(() => assertBundleWithinLimits({
      size: 3,
      chunks: [chunk(1), chunk(2)],
    } as any)).toThrow(/inconsistent sizes/);
  });

  test('bounds chunk count independently of declared bytes', () => {
    const chunks = Array.from({ length: MAX_BUNDLE_CHUNKS + 1 }, (_, i) =>
      chunk(1, i.toString(16).padStart(64, '0')));
    expect(() => assertBundleWithinLimits({ size: chunks.length, chunks } as any)).toThrow(/too many chunks/);
  });

  test('checks encoded length before decoding a committed chunk', () => {
    const exact = toBase64(new Uint8Array([1, 2, 3]));
    expect([...decodeCommittedChunk(exact, 3)]).toEqual([1, 2, 3]);
    expect(() => decodeCommittedChunk(exact.repeat(100_000), 3)).toThrow(/encoded length mismatch/);
  });

  test('rejects a missing chunk list', () => {
    expect(() => assertBundleWithinLimits({ size: 0 } as any)).toThrow(/no chunk list/);
  });

  test('the cap aligns with the loader budget', () => {
    expect(MAX_BUNDLE_BYTES).toBe(50_000_000);
  });
});

describe('both fetch paths enforce the cap before buffering', () => {
  test('rejects a chunk whose decoded length disagrees with the signed manifest', async () => {
    const payload = new TextEncoder().encode('three');
    const built = await buildManifest({ payload, type: 'data' });
    let handler: ((message: any) => void) | null = null;
    const channel = {
      setHandler: (next: ((message: any) => void) | null) => { handler = next; },
      send: (message: any) => queueMicrotask(() => {
        if (message.t === 'MANIFEST_REQ') handler?.({ t: 'MANIFEST', hash: built.hash, manifest: built.manifest });
        if (message.t === 'CHUNK_REQ') handler?.({ t: 'CHUNK', hash: message.hash, bytes: toBase64(Uint8Array.of(1)) });
      }),
    };
    await expect(fetchBundle({ uri: `peerd://${built.hash}`, channel })).rejects.toThrow(/chunk (encoded length|size) mismatch/);
  });

  test('fetchBundle and swarmFetch bound shape before expensive verification and chunk fetch', async () => {
    const files = [
      'extension/peerd-distributed/content/transfer.js',
      'extension/peerd-distributed/content/swarm.js',
    ];
    for (const f of files) {
      const src = await Bun.file(f).text();
      expect(src).toContain('assertBundleWithinLimits(manifest)');
      const verifyAt = src.indexOf('verifyManifest(manifest)');
      const capAt = src.indexOf('assertBundleWithinLimits(manifest)');
      const fetchAt = src.indexOf('uniqueHashes');
      expect(verifyAt).toBeGreaterThan(-1);
      expect(capAt).toBeLessThan(verifyAt); // before canonicalization/signature work
      expect(capAt).toBeLessThan(fetchAt); // before the chunks are pulled
    }
  });
});
