// Two tiny pure byte helpers used across the extension lacked direct unit
// coverage (#124): concat (shared/util.js) assembles iv || ciphertext blobs in
// the crypto layer; bytesEqual (shared/bundle/bytes.js) compares signed-bundle
// chunks. Both are security-adjacent, so the off-by-one edges (length, byte
// order, the differing-byte position) are exactly what a regression would slip
// through.

import { describe, test, expect } from 'bun:test';
import { concat } from '../../extension/shared/util.js';
import { bytesEqual } from '../../extension/shared/bundle/bytes.js';

describe('concat — joins two Uint8Arrays', () => {
  test('two non-empty arrays: length, order, and contents', () => {
    const out = concat(Uint8Array.of(1, 2), Uint8Array.of(3, 4, 5));
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(5);
    // why: order matters — a is laid down first, then b after it.
    expect([...out]).toEqual([1, 2, 3, 4, 5]);
  });

  test('empty + full keeps the second array intact', () => {
    const out = concat(new Uint8Array(0), Uint8Array.of(9, 8, 7));
    expect([...out]).toEqual([9, 8, 7]);
  });

  test('full + empty keeps the first array intact', () => {
    const out = concat(Uint8Array.of(9, 8, 7), new Uint8Array(0));
    expect([...out]).toEqual([9, 8, 7]);
  });

  test('empty + empty yields an empty buffer', () => {
    const out = concat(new Uint8Array(0), new Uint8Array(0));
    expect(out.length).toBe(0);
  });

  test('returns a fresh buffer, not a view onto an input', () => {
    // why: callers mutate the result (crypto blob assembly); a shared view
    // would corrupt the source array.
    const a = Uint8Array.of(1, 2);
    const out = concat(a, new Uint8Array(0));
    out[0] = 99;
    expect(a[0]).toBe(1);
  });
});

describe('bytesEqual — compares two Uint8Arrays', () => {
  test('equal arrays are equal', () => {
    expect(bytesEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
  });

  test('different lengths are never equal', () => {
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3))).toBe(false);
  });

  test('same length, one differing byte — first / middle / last', () => {
    expect(bytesEqual(Uint8Array.of(9, 2, 3), Uint8Array.of(1, 2, 3))).toBe(false);
    expect(bytesEqual(Uint8Array.of(1, 9, 3), Uint8Array.of(1, 2, 3))).toBe(false);
    expect(bytesEqual(Uint8Array.of(1, 2, 9), Uint8Array.of(1, 2, 3))).toBe(false);
  });

  test('both empty are equal', () => {
    expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  test('single element: matching and differing', () => {
    expect(bytesEqual(Uint8Array.of(7), Uint8Array.of(7))).toBe(true);
    expect(bytesEqual(Uint8Array.of(7), Uint8Array.of(8))).toBe(false);
  });
});
