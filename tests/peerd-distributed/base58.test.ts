import { describe, test, expect } from 'bun:test';
import { base58encode, base58decode } from '../../extension/peerd-distributed/codec/base58.js';

// Independent reference encoder (BigInt) to cross-check the byte-by-byte
// long-division implementation. If both agree across random inputs, the
// implementation is right.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const refEncode = (bytes: Uint8Array) => {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n = n / 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + s;
};

describe('base58btc', () => {
  test('matches a BigInt reference encoder on random inputs', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256);
    for (let trial = 0; trial < 200; trial++) {
      const len = (seed % 40) + 1;
      const bytes = Uint8Array.from({ length: len }, () => rnd());
      expect(base58encode(bytes)).toBe(refEncode(bytes));
    }
  });

  test('roundtrips, including leading zero bytes', () => {
    const cases = [
      Uint8Array.from([0]),
      Uint8Array.from([0, 0, 0, 5, 9]),
      Uint8Array.from([255, 254, 1, 0]),
      crypto.getRandomValues(new Uint8Array(34)),
    ];
    for (const c of cases) {
      expect([...base58decode(base58encode(c))]).toEqual([...c]);
    }
  });

  test('leading zero bytes become leading "1"s', () => {
    expect(base58encode(Uint8Array.from([0, 0, 1]))).toBe('11' + base58encode(Uint8Array.from([1])));
  });

  test('rejects invalid characters', () => {
    expect(() => base58decode('0OIl')).toThrow();
  });
});
