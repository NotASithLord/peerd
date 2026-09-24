import { describe, expect, test } from 'bun:test';
import {
  canonicalCloneDigest,
  canonicalStructuredClone,
  sameCanonicalStructuredClone,
} from '../../extension/shared/canonical-clone-digest.js';
import { structuredClonePayloadBytes } from '../../extension/shared/structured-clone-size.js';

describe('canonical structured-clone digest', () => {
  test('object key order does not change an authority target digest', async () => {
    const left = { z: 1, nested: { b: true, a: 'x' } };
    const right = { nested: { a: 'x', b: true }, z: 1 };
    expect(await canonicalCloneDigest(left)).toBe(await canonicalCloneDigest(right));
    expect(sameCanonicalStructuredClone(left, right)).toBe(true);
  });

  test('exact equality distinguishes values that JSON serialization aliases', () => {
    expect(sameCanonicalStructuredClone({}, { omitted: undefined })).toBe(false);
    expect(sameCanonicalStructuredClone({ value: Number.NaN }, { value: null })).toBe(false);
    expect(sameCanonicalStructuredClone({ value: Infinity }, { value: null })).toBe(false);
    expect(sameCanonicalStructuredClone(new Uint8Array([1]), new Uint8Array([2]))).toBe(false);
    expect(sameCanonicalStructuredClone(new ArrayBuffer(0), new ArrayBuffer(1))).toBe(false);
  });

  test('exact equality fails closed outside its byte and clone-shape bounds', () => {
    expect(sameCanonicalStructuredClone('abcd', 'abcd', { maxBytes: 1 })).toBe(false);
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(sameCanonicalStructuredClone(cyclic, cyclic)).toBe(false);
  });

  test('typed views retain their exact type, window, and bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(canonicalStructuredClone(bytes)).not.toBe(
      canonicalStructuredClone(new Uint16Array(bytes.buffer)),
    );
    expect(canonicalStructuredClone(bytes.subarray(1))).not.toBe(
      canonicalStructuredClone(bytes),
    );
    const leftBacking = new Uint8Array([9, 2, 3, 8]);
    const rightBacking = new Uint8Array([7, 2, 3, 6]);
    expect(canonicalStructuredClone(leftBacking.subarray(1, 3))).not.toBe(
      canonicalStructuredClone(rightBacking.subarray(1, 3)),
    );
    expect(canonicalStructuredClone(new Uint8Array(leftBacking.buffer, 1, 2))).not.toBe(
      canonicalStructuredClone(new Uint8Array(leftBacking.buffer, 2, 2)),
    );
  });

  test('near-cap typed bytes complete without per-byte array expansion', async () => {
    const byteLength = 8 * 1024 * 1024;
    const bytes = new Uint8Array(byteLength);
    for (let offset = 0; offset < byteLength; offset += 4096) bytes[offset] = offset & 0xff;
    const digest = await canonicalCloneDigest({ bytes }, { maxBytes: byteLength + 1024 });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a tiny view is charged for its full structured-clone backing buffer', () => {
    const backing = new ArrayBuffer(8 * 1024 * 1024);
    expect(structuredClonePayloadBytes(new Uint8Array(backing, 0, 1)))
      .toBe(backing.byteLength);
    expect(structuredClonePayloadBytes(new DataView(backing, 1, 1)))
      .toBe(backing.byteLength);
  });

  test('cycles fail closed before lifecycle admission', () => {
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(() => canonicalStructuredClone(cyclic)).toThrow('authority-arguments-invalid');
  });

  test('shared-reference topology cannot alias a duplicated authority payload', () => {
    const shared = { value: 1 };
    expect(() => canonicalStructuredClone({ a: shared, b: shared }))
      .toThrow('authority-arguments-invalid');
    expect(() => canonicalStructuredClone({ a: { value: 1 }, b: { value: 1 } }))
      .not.toThrow();
  });

  test('oversized sparse arrays fail before inspecting an element descriptor', () => {
    let invoked = false;
    const sparse: any[] = [];
    sparse.length = 250_001;
    Object.defineProperty(sparse, '0', {
      enumerable: true,
      get: () => { invoked = true; return 'must-not-run'; },
    });
    expect(structuredClonePayloadBytes(sparse, { maxNodes: 250_000 })).toBe(Infinity);
    expect(() => canonicalStructuredClone(sparse, { maxBytes: 20 * 1024 * 1024 }))
      .toThrow('authority-arguments-invalid');
    expect(invoked).toBe(false);
  });

  test('many-key objects reject by key count without invoking accessors', () => {
    let invoked = false;
    const value: Record<string, unknown> = {};
    for (let index = 0; index < 10_001; index += 1) value[`k${index}`] = index;
    Object.defineProperty(value, 'trap', {
      enumerable: true,
      get: () => { invoked = true; return 'must-not-run'; },
    });
    expect(structuredClonePayloadBytes(value, { maxNodes: 10_000 })).toBe(Infinity);
    expect(invoked).toBe(false);
  });
});
