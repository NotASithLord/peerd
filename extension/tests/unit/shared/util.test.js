// @ts-check
// util.js tests — small helpers, small tests.

import { describe, it, expect } from '../../framework.js';
import {
  concat, escapeAttr, uuidv7, deepFreeze,
  bytesToBase64, base64ToBytes,
} from '/shared/util.js';

describe('util', () => {
  describe('concat', () => {
    it('joins two Uint8Arrays', () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([4, 5]);
      expect(concat(a, b)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });
    it('handles empty inputs', () => {
      expect(concat(new Uint8Array(), new Uint8Array([1]))).toEqual(new Uint8Array([1]));
      expect(concat(new Uint8Array([1]), new Uint8Array())).toEqual(new Uint8Array([1]));
    });
  });

  describe('escapeAttr', () => {
    it('escapes the standard XML entities', () => {
      expect(escapeAttr('<&>"\'')).toBe('&lt;&amp;&gt;&quot;&#39;');
    });
    it('escapes backticks (model code-block boundary)', () => {
      expect(escapeAttr('hello `world`')).toBe('hello &#96;world&#96;');
    });
    it('coerces non-strings safely', () => {
      // escapeAttr is typed (s: string) but coerces via String(s) at
      // runtime; cast the deliberately non-string inputs to exercise that.
      expect(escapeAttr(/** @type {string} */ (/** @type {unknown} */ (42)))).toBe('42');
      expect(escapeAttr(/** @type {string} */ (/** @type {unknown} */ (null)))).toBe('null');
    });
  });

  describe('uuidv7', () => {
    it('produces a v7 UUID in canonical form', () => {
      const id = uuidv7();
      // 8-4-4-4-12 hex, version nibble = 7, variant nibble in {8,9,a,b}
      expect(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)).toBe(true);
    });

    it('embeds the timestamp at the front (sortable)', () => {
      const a = uuidv7(() => 1000);
      const b = uuidv7(() => 2000);
      // Lexicographic order matches chronological order because the
      // first 48 bits are the ms timestamp.
      expect(a < b).toBe(true);
    });

    it('uses injected random bytes deterministically (for tests)', () => {
      const stream = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const id = uuidv7(() => 0, () => stream);
      // Timestamp = 0 → first 12 hex chars are 0.
      // bytes[6..15] = [1,2,3,4,5,6,7,8,9,10] before mask.
      // bytes[6] = (1 & 0x0f) | 0x70 = 0x71  (v7 version bits)
      // bytes[8] = (3 & 0x3f) | 0x80 = 0x83  (RFC 9562 variant bits)
      // Hex stream: 00 00 00 00 00 00 71 02 83 04 05 06 07 08 09 0a
      // Hard-coded expected layout documents the algorithm. If the
      // implementation changes, this fails loudly so we update consciously.
      expect(id).toBe('00000000-0000-7102-8304-05060708090a');
    });
  });

  describe('base64 roundtrip', () => {
    it('encodes and decodes back to the same bytes', () => {
      const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
      const round = base64ToBytes(bytesToBase64(bytes));
      expect(round).toEqual(bytes);
    });
    it('handles empty input', () => {
      expect(bytesToBase64(new Uint8Array())).toBe('');
      expect(base64ToBytes('')).toEqual(new Uint8Array());
    });
    it('round-trips a typical PBKDF2 salt (16 bytes)', () => {
      const salt = new Uint8Array(16);
      for (let i = 0; i < 16; i++) salt[i] = (i * 17 + 3) & 0xff;
      const round = base64ToBytes(bytesToBase64(salt));
      expect(round).toEqual(salt);
    });
  });

  describe('deepFreeze', () => {
    it('freezes nested objects', () => {
      const o = deepFreeze({ a: { b: { c: 1 } } });
      expect(Object.isFrozen(o)).toBe(true);
      expect(Object.isFrozen(o.a)).toBe(true);
      expect(Object.isFrozen(o.a.b)).toBe(true);
    });
    it('returns primitives unchanged', () => {
      expect(deepFreeze(42)).toBe(42);
      expect(deepFreeze('s')).toBe('s');
      expect(deepFreeze(null)).toBe(null);
    });
  });
});
