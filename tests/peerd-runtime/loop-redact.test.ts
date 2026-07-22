import { describe, test, expect } from 'bun:test';
import { redactToolResult } from '../../extension/peerd-runtime/loop/redact.js';

describe('redactToolResult', () => {
  test('returns empty or non-string content unchanged', () => {
    expect(redactToolResult('')).toBe('');
    // Guards non-string at runtime even though the type says string.
    expect(redactToolResult(null as unknown as string)).toBeNull();
  });

  test('passes short content with nothing to strip through untouched', () => {
    const content = 'just a normal tool result';
    expect(redactToolResult(content)).toBe(content);
  });

  test('replaces a data:image url with a byte-size sentinel', () => {
    const content = 'ok data:image/png;base64,AAAABBBBCCCCDDDD done';
    const out = redactToolResult(content);
    expect(out).toMatch(/<image:image\/png;\d+B stripped/);
    expect(out).not.toContain('data:image');
    expect(out).not.toContain('AAAABBBBCCCC');
    expect(out).toContain('ok ');
    expect(out).toContain(' done');
  });

  test('strips every data:image url in the content', () => {
    const content =
      'data:image/jpeg;base64,ZZZZ and data:image/webp;base64,YYYY';
    const out = redactToolResult(content);
    expect(out).not.toContain('base64,');
    expect(out).toContain('<image:image/jpeg;');
    expect(out).toContain('<image:image/webp;');
  });

  test('truncates content over the threshold to head, marker, and tail', () => {
    const content = 'H'.repeat(30) + 'M'.repeat(60) + 'T'.repeat(10);
    const out = redactToolResult(content, { maxChars: 40 });
    expect(out.length).toBeLessThan(content.length);
    expect(out).toContain('60 chars elided');
    expect(out.startsWith('H'.repeat(30))).toBe(true);
    expect(out.endsWith('T'.repeat(10))).toBe(true);
    expect(out).not.toContain('M'.repeat(60));
  });

  test('does not truncate content within the threshold', () => {
    const content = 'x'.repeat(40);
    expect(redactToolResult(content, { maxChars: 40 })).toBe(content);
  });

  test('applies both the image strip and the truncation together', () => {
    const content = 'data:image/png;base64,AAAA' + 'z'.repeat(200);
    const out = redactToolResult(content, { maxChars: 50 });
    expect(out).not.toContain('data:image');
    expect(out).toContain('chars elided');
  });
});
