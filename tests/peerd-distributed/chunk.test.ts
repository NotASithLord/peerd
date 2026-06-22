import { describe, test, expect } from 'bun:test';
import { chunkBytes, sha256hex, CHUNK_SIZE } from '../../extension/peerd-distributed/content/chunk.js';
import { concat } from '../../extension/shared/bundle/bytes.js';

describe('chunking + SHA-256', () => {
  test('splits into <=CHUNK_SIZE pieces that reassemble', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(CHUNK_SIZE * 2 + 123));
    const pieces = chunkBytes(bytes);
    expect(pieces.length).toBe(3);
    expect(pieces[0].length).toBe(CHUNK_SIZE);
    expect(pieces[2].length).toBe(123);
    expect([...concat(...pieces)]).toEqual([...bytes]);
  });

  test('empty payload yields no chunks', () => {
    expect(chunkBytes(new Uint8Array(0)).length).toBe(0);
  });

  test('sha256hex matches the known empty-input digest', () => {
    return sha256hex(new Uint8Array(0)).then((hex) => {
      expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });
  });
});
