// The spill-and-page pure core (tools/web/spill.js): head+tail windowing for an
// oversized fetched body, the trusted paging footer, and the offset/limit
// slicer read_web_cache serves. Pure functions — the invariants that keep the
// paging contract honest live here.

import { describe, test, expect } from 'bun:test';
import { windowText, pagingFooter, pageSlice } from '../../../extension/peerd-runtime/tools/web/spill.js';

describe('windowText', () => {
  test('text at or under the budget passes through whole', () => {
    const r = windowText('short body', 100);
    expect(r.windowed).toBe(false);
    expect(r.window).toBe('short body');
    expect(r.total).toBe(10);
  });

  test('oversized text becomes head(75%) + elision marker + tail(25%)', () => {
    const text = 'H'.repeat(500) + 'M'.repeat(500) + 'T'.repeat(500);
    const r = windowText(text, 400);
    expect(r.windowed).toBe(true);
    expect(r.headChars).toBe(300);
    expect(r.tailChars).toBe(100);
    expect(r.window.startsWith('H'.repeat(300))).toBe(true);
    expect(r.window.endsWith('T'.repeat(100))).toBe(true);
    // The marker names HOW MUCH was elided — the model must see content is missing.
    expect(r.window).toContain(`${1500 - 400} characters elided`);
    expect(r.total).toBe(1500);
  });
});

describe('pagingFooter', () => {
  test('names the exact read_web_cache call with the caller-computed values only', () => {
    const f = pagingFooter({ key: 'wc-abc-1', total: 90_000, headChars: 12_000, tailChars: 4_000 });
    expect(f).toContain('read_web_cache');
    expect(f).toContain('"key": "wc-abc-1"');
    expect(f).toContain('90000 chars');
    // The continuation offset the model should use = where the head stopped.
    expect(f).toContain('offset 12000');
  });
});

describe('pageSlice', () => {
  const text = 'abcdefghij';   // 10 chars

  test('slices offset/limit and reports what remains', () => {
    const r = pageSlice(text, 2, 3);
    expect(r.slice).toBe('cde');
    expect(r).toMatchObject({ offset: 2, end: 5, total: 10, remaining: 5 });
  });

  test('clamps out-of-range offsets and limits instead of throwing', () => {
    expect(pageSlice(text, -5, 3).slice).toBe('abc');        // negative offset → 0
    expect(pageSlice(text, 8, 100).slice).toBe('ij');        // limit past the end → to end
    expect(pageSlice(text, 99, 3)).toMatchObject({ slice: '', remaining: 0 });  // offset past end
    expect(pageSlice(text, 0, 0).slice).toBe('a');           // degenerate limit → at least 1 char
  });
});
