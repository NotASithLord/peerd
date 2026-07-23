import { describe, test, expect } from 'bun:test';
import {
  concat,
  bytesToBase64,
  base64ToBytes,
  uuidv7,
  deepFreeze,
  clamp,
  sha256Hex,
} from '../../extension/shared/util.js';

// Direct unit tests for the dependency-free helpers in shared/util.js. These
// back the crypto layer (concat, base64, sha256), audit-log ordering (uuidv7),
// and the frozen config tables (deepFreeze), so pinning their contracts keeps a
// refactor from silently changing byte layout or immutability guarantees.
// escapeAttr and stripUntrustedFences are covered by their own suites.

describe('concat', () => {
  test('joins two buffers in order into a fresh array', () => {
    const out = concat(new Uint8Array([1, 2]), new Uint8Array([3, 4, 5]));
    expect(out).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  test('empty operands are no-ops', () => {
    expect(concat(new Uint8Array([9]), new Uint8Array([]))).toEqual(new Uint8Array([9]));
    expect(concat(new Uint8Array([]), new Uint8Array([9]))).toEqual(new Uint8Array([9]));
    expect(concat(new Uint8Array([]), new Uint8Array([]))).toEqual(new Uint8Array([]));
  });

  test('does not alias its inputs', () => {
    const a = new Uint8Array([1]);
    const out = concat(a, new Uint8Array([2]));
    out[0] = 99;
    expect(a[0]).toBe(1);
  });
});

describe('bytesToBase64 / base64ToBytes', () => {
  test('known vector: "hi" ↔ "aGk="', () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=');
    expect(base64ToBytes('aGk=')).toEqual(new Uint8Array([104, 105]));
  });

  test('empty buffer ↔ empty string', () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe('');
    expect(base64ToBytes('')).toEqual(new Uint8Array([]));
  });

  test('round-trips every byte value 0..255', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
  });

  test('round-trips a buffer larger than the 32_768 chunk boundary', () => {
    // why: bytesToBase64 chunks fromCharCode.apply to dodge the argument-count
    // limit; a >CHUNK input exercises the multi-pass path, not the single pass.
    const big = new Uint8Array(70_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 256;
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });
});

describe('uuidv7', () => {
  // Inject a fixed clock + random bytes so the layout is fully deterministic.
  const fixedRandom = (n: number) => new Uint8Array(n).fill(0xff);

  test('encodes the 48-bit ms timestamp, version 7 and RFC 9562 variant', () => {
    const id = uuidv7(() => 0x0123456789ab, fixedRandom);
    // ts=0x0123456789ab; random=all 0xff, so byte6→0x7f (version) and
    // byte8→0xbf (variant), the rest stay 0xff.
    expect(id).toBe('01234567-89ab-7fff-bfff-ffffffffffff');
    // version nibble is the first char of the 3rd group…
    expect(id[14]).toBe('7');
    // …and the variant high bits are 10xx (b = 1011).
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  test('canonical 36-char shape with dashes in the 8-4-4-4-12 layout', () => {
    const id = uuidv7(() => 1, fixedRandom);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test('later timestamps sort lexicographically after earlier ones', () => {
    // why: the point of v7 is time-sortable ids so IDB cursors read in order.
    const earlier = uuidv7(() => 1_000, fixedRandom);
    const later = uuidv7(() => 2_000, fixedRandom);
    expect(earlier < later).toBe(true);
  });

  test('the default (crypto) path still produces a valid v7 uuid', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('deepFreeze', () => {
  test('freezes nested objects recursively and returns the same reference', () => {
    const obj = { a: 1, nested: { b: 2, deeper: { c: 3 } } };
    const out = deepFreeze(obj);
    expect(out).toBe(obj);
    expect(Object.isFrozen(obj)).toBe(true);
    expect(Object.isFrozen(obj.nested)).toBe(true);
    expect(Object.isFrozen(obj.nested.deeper)).toBe(true);
  });

  test('a frozen object rejects mutation in strict mode', () => {
    const obj = deepFreeze({ a: 1 });
    expect(() => {
      (obj as { a: number }).a = 2;
    }).toThrow();
  });

  test('leaves typed arrays unfrozen (they cannot be frozen) but returns them', () => {
    // why: deepFreeze skips ArrayBuffer views — a frozen parent protects them.
    const bytes = new Uint8Array([1, 2, 3]);
    expect(deepFreeze(bytes)).toBe(bytes);
    expect(Object.isFrozen(bytes)).toBe(false);
    bytes[0] = 9;
    expect(bytes[0]).toBe(9);
  });

  test('passes primitives and null straight through', () => {
    expect(deepFreeze(null)).toBe(null);
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze('x')).toBe('x');
  });
});

describe('clamp', () => {
  test('returns the value when already inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  test('clamps to the floor and the ceiling', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });

  test('a collapsed range pins to the single value', () => {
    expect(clamp(5, 3, 3)).toBe(3);
  });
});

describe('sha256Hex', () => {
  test('matches the known SHA-256 vector for the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  test('matches the known SHA-256 vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('is 64 lowercase hex chars and content-addresses deterministically', async () => {
    const digest = await sha256Hex('peerd');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(await sha256Hex('peerd'));
    expect(digest).not.toBe(await sha256Hex('peere'));
  });
});
