// @ts-check
// Redactor — strip data:image/* + truncate long tool results.

import { describe, it, expect } from '../../framework.js';
import { redactToolResult } from '/peerd-runtime/loop/redact.js';

describe('redactToolResult', () => {
  describe('data:image stripping', () => {
    it('replaces a data:image/png base64 URL with a metadata sentinel', () => {
      const bytes = 'AAAA'.repeat(2000);            // 8000 base64 chars
      const input = `{"dataUrl":"data:image/png;base64,${bytes}"}`;
      const out = redactToolResult(input);
      expect(out.includes(bytes)).toBe(false);
      expect(out.includes('image/png')).toBe(true);
      expect(out.includes('stripped')).toBe(true);
    });

    it('reports approximate byte size in the sentinel', () => {
      const bytes = 'AAAA'.repeat(2000);            // 8000 b64 → ~6000 bytes
      const input = `data:image/jpeg;base64,${bytes}`;
      const out = redactToolResult(input);
      // 8000-ish base64 chars → ~6000 raw bytes
      expect(/\d+B stripped/.test(out)).toBe(true);
    });

    it('handles multiple data: URLs in a single content', () => {
      const b1 = 'AAAA'.repeat(100);
      const b2 = 'BBBB'.repeat(100);
      const input = `first: data:image/png;base64,${b1} and second: data:image/jpeg;base64,${b2}`;
      const out = redactToolResult(input);
      expect(out.includes(b1)).toBe(false);
      expect(out.includes(b2)).toBe(false);
      expect((out.match(/stripped/g) || []).length).toBe(2);
    });

    it('leaves content without data: URLs untouched (under the cap)', () => {
      const input = '{"ok":true,"text":"hello world"}';
      expect(redactToolResult(input)).toBe(input);
    });

    it('preserves the rest of a JSON envelope around a stripped dataUrl', () => {
      const bytes = 'AAAA'.repeat(100);
      const input = `{"format":"png","dataUrl":"data:image/png;base64,${bytes}","origin":"https://example.com"}`;
      const out = redactToolResult(input);
      expect(out.includes('"format":"png"')).toBe(true);
      expect(out.includes('"origin":"https://example.com"')).toBe(true);
    });
  });

  describe('truncation', () => {
    it('truncates content over the default 8000-char threshold', () => {
      const input = 'x'.repeat(20_000);
      const out = redactToolResult(input);
      expect(out.length < 9000).toBe(true);          // head + tail + sentinel < 9k
      expect(out.includes('elided')).toBe(true);
    });

    it('preserves head and tail in truncated output', () => {
      // Head 75%, tail 25%. The first char and the last char should
      // both survive truncation.
      const input = `HEAD${'x'.repeat(20_000)}TAIL`;
      const out = redactToolResult(input);
      expect(out.startsWith('HEAD')).toBe(true);
      expect(out.endsWith('TAIL')).toBe(true);
    });

    it('does not truncate content at or under the threshold', () => {
      const input = 'x'.repeat(8000);
      expect(redactToolResult(input).length).toBe(8000);
    });

    it('respects an injected maxChars override', () => {
      const input = 'x'.repeat(500);
      const out = redactToolResult(input, { maxChars: 100 });
      expect(out.length < 200).toBe(true);
      expect(out.includes('elided')).toBe(true);
    });

    it('combines image stripping and truncation when both apply', () => {
      // Image up front so its sentinel lands in the surviving head —
      // stripping runs first, and a sentinel that falls in the elided
      // middle is (correctly) dropped along with it.
      const bytes = 'AAAA'.repeat(2000);
      const filler = 'x'.repeat(20_000);
      const input = `data:image/png;base64,${bytes} ${filler}`;
      const out = redactToolResult(input);
      expect(out.includes(bytes)).toBe(false);
      expect(out.includes('stripped')).toBe(true);
      expect(out.includes('elided')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('returns non-string input unchanged', () => {
      // why: redactToolResult is typed `(content: string)` but tolerates
      // non-string input at runtime (returns it unchanged). These casts
      // exercise that defensive branch without weakening the prod type.
      expect(redactToolResult(/** @type {string} */ (/** @type {unknown} */ (null)))).toBe(null);
      expect(redactToolResult(/** @type {string} */ (/** @type {unknown} */ (undefined)))).toBe(undefined);
      expect(redactToolResult(/** @type {string} */ (/** @type {unknown} */ (42)))).toBe(42);
    });

    it('returns empty string unchanged', () => {
      expect(redactToolResult('')).toBe('');
    });
  });
});
