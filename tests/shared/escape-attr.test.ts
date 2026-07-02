// escapeAttr (shared/util.js) escapes the five XML predefined entities plus the
// backtick so untrusted web-page text is safe to embed in an HTML attribute —
// it's part of how wrapUntrusted (§4.3) neutralizes prompt-injection in tool
// results. It was only exercised indirectly (#125); these pin its contract
// directly so a dropped or reordered replace() can't silently weaken the fence.

import { describe, test, expect } from 'bun:test';
import { escapeAttr } from '../../extension/shared/util.js';

describe('escapeAttr — each special character', () => {
  test('ampersand', () => expect(escapeAttr('&')).toBe('&amp;'));
  test('less-than', () => expect(escapeAttr('<')).toBe('&lt;'));
  test('greater-than', () => expect(escapeAttr('>')).toBe('&gt;'));
  test('double quote', () => expect(escapeAttr('"')).toBe('&quot;'));
  test('single quote', () => expect(escapeAttr("'")).toBe('&#39;'));
  test('backtick', () => expect(escapeAttr('`')).toBe('&#96;'));
});

describe('escapeAttr — combinations and edges', () => {
  test('all six at once, in order', () => {
    expect(escapeAttr('&<>"\'`')).toBe('&amp;&lt;&gt;&quot;&#39;&#96;');
  });

  test('a realistic mixed string', () => {
    expect(escapeAttr('5 < 3 & "yes"')).toBe('5 &lt; 3 &amp; &quot;yes&quot;');
  });

  // why: escaping is intentionally NOT idempotent — `&` is replaced first, so a
  // pre-escaped entity gets its `&` re-escaped. Re-running escapeAttr must keep
  // adding a layer, never silently collapse one (that would be a bypass).
  test('an already-escaped entity is escaped again', () => {
    expect(escapeAttr('&amp;')).toBe('&amp;amp;');
  });

  test('empty string stays empty', () => {
    expect(escapeAttr('')).toBe('');
  });
});

describe('escapeAttr — non-string input is coerced via String()', () => {
  // @ts-expect-error — escapeAttr's signature is (s: string); these assert the
  // defensive String() coercion for callers that pass a non-string anyway.
  test('a number', () => expect(escapeAttr(42)).toBe('42'));
  // @ts-expect-error — defensive against non-string input (see above)
  test('undefined', () => expect(escapeAttr(undefined)).toBe('undefined'));
  // @ts-expect-error — defensive against non-string input (see above)
  test('null', () => expect(escapeAttr(null)).toBe('null'));
});

describe('escapeAttr — realistic injection payloads', () => {
  test('a closing script tag cannot break out', () => {
    expect(escapeAttr('</script>')).toBe('&lt;/script&gt;');
  });

  test('a markdown code fence (backticks) is neutralized', () => {
    expect(escapeAttr('```')).toBe('&#96;&#96;&#96;');
  });

  test('an attribute-breakout attempt is neutralized', () => {
    // The exact threat escapeAttr defends against: text trying to close the
    // attribute and inject its own. Both the quote and the angle brackets go.
    expect(escapeAttr('"><img src=x onerror=alert(1)>')).toBe(
      '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;',
    );
  });
});
