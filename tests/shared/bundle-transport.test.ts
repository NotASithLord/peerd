import { describe, expect, test } from 'bun:test';
import { packBundle } from '../../extension/shared/bundle/bundle.js';
import { sha256hex } from '../../extension/shared/bundle/chunk.js';
import {
  BUNDLE_TRANSPORT_CODEC,
  MAX_BUNDLE_CONTAINER_BYTES,
  assertBundleTransportDescriptor,
  compressBundleBytes,
  packTransportBundle,
  unpackTransportBundle,
} from '../../extension/shared/bundle/transport.js';

const text = (value: string) => new TextEncoder().encode(value);

describe('dwapp bundle v2 transport', () => {
  test('pins one golden gzip payload independently of host stream codecs', async () => {
    const source = text('peerd dwapp deterministic gzip codec v2\n'.repeat(257));
    const compressed = await compressBundleBytes(source);
    expect(compressed.byteLength).toBe(106);
    expect(await sha256hex(compressed))
      .toBe('cef078d804c524a4f25b5e7c8236b2cf96f06c7e9e215629b32ec8581b0a7d77');
  });

  test('is byte-deterministic across repeated builds and input key order', async () => {
    const first = await packTransportBundle({
      entry: 'index.html',
      files: {
        'texture.bin': new Uint8Array([0, 255, 4, 9]),
        'index.html': text('<script src="game.js"></script>'),
        'game.js': text('const state = "readable";\n'.repeat(200)),
      },
      fileKinds: { 'texture.bin': 'binary', 'index.html': 'text', 'game.js': 'text' },
    });
    const second = await packTransportBundle({
      entry: 'index.html',
      files: {
        'game.js': text('const state = "readable";\n'.repeat(200)),
        'index.html': text('<script src="game.js"></script>'),
        'texture.bin': new Uint8Array([0, 255, 4, 9]),
      },
      fileKinds: { 'game.js': 'text', 'index.html': 'text', 'texture.bin': 'binary' },
    });

    expect(first.descriptor).toEqual(second.descriptor);
    expect(Array.from(first.payload)).toEqual(Array.from(second.payload));
    expect(first.descriptor.encoding).toBe('gzip');
    expect(first.descriptor.codec).toBe(BUNDLE_TRANSPORT_CODEC);
    expect(first.descriptor.compressedSize).toBe(first.payload.byteLength);
    expect(first.descriptor.compressedSize).toBeLessThan(first.descriptor.uncompressedSize);
    expect(Array.from(first.payload.slice(0, 10)))
      .toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]);
    expect(first.descriptor.files.map((file) => file.path))
      .toEqual(['game.js', 'index.html', 'texture.bin']);
  });

  test('restores exact source and binary bytes before installation', async () => {
    const built = await packTransportBundle({
      entry: 'index.html',
      files: {
        'index.html': text('<h1>decoded working tree</h1>'),
        'audio/voice.ogg': new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 255]),
      },
      fileKinds: { 'index.html': 'text', 'audio/voice.ogg': 'binary' },
    });
    const manifest = {
      v: 2, size: built.payload.byteLength, bundle: built.descriptor,
    };
    const decoded = await unpackTransportBundle({ manifest, payload: built.payload });
    expect(new TextDecoder().decode(decoded.files['index.html']))
      .toBe('<h1>decoded working tree</h1>');
    expect(Array.from(decoded.files['audio/voice.ogg']))
      .toEqual([0x4f, 0x67, 0x67, 0x53, 0, 255]);
    expect(decoded.fileKinds).toEqual({
      'audio/voice.ogg': 'binary',
      'index.html': 'text',
    });
  });

  test('retains the legacy v1 reader without attempting decompression', async () => {
    const payload = packBundle({
      entry: 'index.html', files: { 'index.html': text('legacy') },
    });
    const decoded = await unpackTransportBundle({
      manifest: { v: 1, size: payload.byteLength }, payload,
    });
    expect(new TextDecoder().decode(decoded.files['index.html'])).toBe('legacy');
  });

  test('fails closed when a v2 manifest omits its transport descriptor', async () => {
    const payload = packBundle({
      entry: 'index.html', files: { 'index.html': text('not actually v2') },
    });
    await expect(unpackTransportBundle({
      manifest: { v: 2, size: payload.byteLength }, payload,
    })).rejects.toThrow('bundle transport descriptor missing');
  });

  test('checks compressed bytes before decompression and decoded bytes after it', async () => {
    const built = await packTransportBundle({
      entry: 'index.html', files: { 'index.html': text('authentic') },
    });
    const manifest = { v: 2, size: built.payload.byteLength, bundle: built.descriptor };
    const tampered = new Uint8Array(built.payload);
    tampered[tampered.length - 1] ^= 1;
    await expect(unpackTransportBundle({ manifest, payload: tampered }))
      .rejects.toThrow('compressed hash mismatch');

    const wrongDecodedHash = {
      ...manifest,
      bundle: { ...built.descriptor, uncompressedHash: '0'.repeat(64) },
    };
    await expect(unpackTransportBundle({ manifest: wrongDecodedHash, payload: built.payload }))
      .rejects.toThrow('uncompressed hash mismatch');
  });

  test('aborts a compression bomb while streaming beyond its signed output size', async () => {
    const bomb = await compressBundleBytes(text('A'.repeat(1_000_000)));
    const descriptor = {
      version: 2 as const,
      encoding: 'gzip' as const,
      codec: BUNDLE_TRANSPORT_CODEC,
      compressedSize: bomb.byteLength,
      uncompressedSize: 32,
      compressedHash: await sha256hex(bomb),
      uncompressedHash: '0'.repeat(64),
      files: [],
    };
    await expect(unpackTransportBundle({
      manifest: { v: 2, size: bomb.byteLength, bundle: descriptor },
      payload: bomb,
    })).rejects.toThrow(/decompression failed.*output exceeds 32 bytes/);
  });

  test('enforces per-file limits independently of the aggregate limit', async () => {
    const built = await packTransportBundle({
      entry: 'index.html', files: { 'index.html': text('123456789') },
    });
    await expect(unpackTransportBundle({
      manifest: { v: 2, size: built.payload.byteLength, bundle: built.descriptor },
      payload: built.payload,
      limits: { maxPackedBytes: MAX_BUNDLE_CONTAINER_BYTES, maxDecodedBytes: 100, maxFileBytes: 8 },
    })).rejects.toThrow('bundle file exceeds 8 decoded bytes');
  });

  test('rejects signed descriptors that lie about decoded shape before fetch', () => {
    const descriptor = {
      version: 2 as const, encoding: 'gzip' as const, codec: BUNDLE_TRANSPORT_CODEC,
      compressedSize: 10, uncompressedSize: 20,
      compressedHash: 'a'.repeat(64), uncompressedHash: 'b'.repeat(64),
      files: [
        { path: 'same.bin', size: 1, hash: 'c'.repeat(64) },
        { path: 'same.bin', size: 1, hash: 'd'.repeat(64) },
      ],
    };
    expect(() => assertBundleTransportDescriptor(descriptor, { compressedSize: 10 }))
      .toThrow('path invalid');

    expect(() => assertBundleTransportDescriptor({
      ...descriptor,
      files: [
        { path: 'z.bin', size: 1, hash: 'c'.repeat(64) },
        { path: 'a.bin', size: 1, hash: 'd'.repeat(64) },
      ],
    }, { compressedSize: 10 })).toThrow('lexical path order');

    expect(() => assertBundleTransportDescriptor({
      ...descriptor,
      codec: 'pako@future:gzip:l6:w15:m8:s0:i262144:mtime0:os255',
      files: [],
    }, { compressedSize: 10 })).toThrow('version, encoding, or codec unsupported');
  });
});
