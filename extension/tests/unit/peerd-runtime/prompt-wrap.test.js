// @ts-check
// Untrusted-content wrap tests.
//
// The wrap is a defense-in-depth primitive — it doesn't replace the
// other gates, but it gives the model a clear DATA/INSTRUCTION boundary.
// These tests pin the wire format so the system prompt's expectations
// stay aligned with what tools actually emit.

import { describe, it, expect } from '../../framework.js';
import { wrapUntrusted } from '/peerd-runtime/index.js';

describe('wrapUntrusted', () => {
  it('produces the canonical tag with origin + tool + ISO timestamp', () => {
    const wrapped = wrapUntrusted({
      origin: 'https://example.com',
      tool: 'read_page',
      body: 'hello world',
      retrievedAt: '2026-06-05T12:00:00.000Z',
    });
    expect(wrapped).toBe(
      '<untrusted_web_content origin="https://example.com" tool="read_page" retrieved_at="2026-06-05T12:00:00.000Z">\n' +
      'hello world\n' +
      '</untrusted_web_content>'
    );
  });

  it('escapes quotes and angle brackets in attribute values', () => {
    const wrapped = wrapUntrusted({
      origin: 'https://attacker.example.com/"><script>',
      tool: 'read_page',
      body: 'irrelevant',
      retrievedAt: '2026-06-05T12:00:00.000Z',
    });
    // The injection attempt is neutralized in the origin attribute.
    expect(wrapped.includes('<script>')).toBe(false);
    expect(wrapped.includes('&quot;')).toBe(true);
    expect(wrapped.includes('&lt;script&gt;')).toBe(true);
  });

  it('defaults retrievedAt to now() when not provided', () => {
    const wrapped = wrapUntrusted({
      origin: 'https://example.com', tool: 'read_page', body: 'x',
    });
    // ISO-ish — has T and Z
    expect(/retrieved_at="\d{4}-\d{2}-\d{2}T[\d:.]+Z"/.test(wrapped)).toBe(true);
  });
});
