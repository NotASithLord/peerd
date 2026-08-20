// @ts-check
// Browser half of the transport golden: this must match the Bun assertion so
// a host-specific module/typed-array behavior change cannot drift signed bytes.

import { describe, it, expect } from '../../framework.js';
import { sha256hex } from '/shared/bundle/chunk.js';
import {
  BUNDLE_TRANSPORT_CODEC,
  compressBundleBytes,
  unpackTransportBundle,
} from '/shared/bundle/transport.js';

const text = (/** @type {string} */ value) => new TextEncoder().encode(value);

describe('dwapp deterministic bundle codec', () => {
  it('matches the version-pinned Bun golden in the browser', async () => {
    const compressed = await compressBundleBytes(
      text('peerd dwapp deterministic gzip codec v2\n'.repeat(257)),
    );
    expect(compressed.byteLength).toBe(106);
    expect(await sha256hex(compressed))
      .toBe('cef078d804c524a4f25b5e7c8236b2cf96f06c7e9e215629b32ec8581b0a7d77');
  });

  it('rejects surplus decompressed bytes while pako is producing chunks', async () => {
    const bomb = await compressBundleBytes(text('A'.repeat(1_000_000)));
    const descriptor = {
      version: /** @type {const} */ (2),
      encoding: /** @type {const} */ ('gzip'),
      codec: BUNDLE_TRANSPORT_CODEC,
      compressedSize: bomb.byteLength,
      uncompressedSize: 32,
      compressedHash: await sha256hex(bomb),
      uncompressedHash: '0'.repeat(64),
      files: [],
    };
    let message = '';
    try {
      await unpackTransportBundle({
        manifest: { v: 2, size: bomb.byteLength, bundle: descriptor },
        payload: bomb,
      });
    } catch (error) {
      message = /** @type {{message?:string}} */ (error)?.message ?? String(error);
    }
    expect(message).toContain('bundle decompression failed: bundle output exceeds 32 bytes');
  });
});
