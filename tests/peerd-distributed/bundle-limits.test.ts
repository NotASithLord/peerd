import { describe, test, expect } from 'bun:test';
import { assertBundleWithinLimits, MAX_BUNDLE_BYTES } from '../../extension/peerd-distributed/content/manifest.js';

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
    expect(() => assertBundleWithinLimits({ size: 20000 * 262144, chunks: big } as any)).toThrow(/too large/);
  });

  test('rejects the reassembly amplification: thousands of refs to ONE chunk', () => {
    // fetched once (deduped), but reassembly maps over every entry → ~10GB
    const amp = Array.from({ length: 40000 }, () => chunk(262144, 'a'.repeat(64)));
    expect(() => assertBundleWithinLimits({ size: 40000 * 262144, chunks: amp } as any)).toThrow(/too large/);
  });

  test('rejects a manifest that under-reports size to dodge a naive size check', () => {
    const chunks = [chunk(262144), chunk(262144)];
    expect(() => assertBundleWithinLimits({ size: 100, chunks } as any)).toThrow(/does not match/);
  });

  test('rejects non-integer / negative chunk sizes', () => {
    expect(() => assertBundleWithinLimits({ size: 0, chunks: [chunk(-1)] } as any)).toThrow(/chunk size invalid/);
    expect(() => assertBundleWithinLimits({ size: 0, chunks: [chunk(1.5)] } as any)).toThrow(/chunk size invalid/);
  });

  test('rejects a missing chunk list', () => {
    expect(() => assertBundleWithinLimits({ size: 0 } as any)).toThrow(/no chunk list/);
  });

  test('the cap aligns with the loader budget', () => {
    expect(MAX_BUNDLE_BYTES).toBe(50_000_000);
  });
});

describe('both fetch paths enforce the cap before buffering', () => {
  test('fetchBundle and swarmFetch call the guard after verification, before the chunk fetch', async () => {
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
      expect(capAt).toBeGreaterThan(verifyAt); // after the signature check
      expect(capAt).toBeLessThan(fetchAt); // before the chunks are pulled
    }
  });
});
