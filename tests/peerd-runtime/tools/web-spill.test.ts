// The spill-and-page pure core (tools/web/spill.js): head+tail windowing for an
// oversized fetched body, the trusted paging footer, and the offset/limit
// slicer read_web_cache serves. Pure functions — the invariants that keep the
// paging contract honest live here.

import { describe, test, expect } from 'bun:test';
import { windowText, pagingFooter, pageSlice, excerptRelevant, excerptFooter } from '../../../extension/peerd-runtime/tools/web/spill.js';

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

describe('excerptRelevant (BM25 query-relevant excerpting)', () => {
  // A long page: filler paragraphs surrounding one that actually answers the query.
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) => `Section ${i}. General background prose about unrelated topics, navigation, cookies, and boilerplate footer links repeated across the site.`);
  const needle = 'Qatar Airways economy class checked baggage allowance is 30 kg per passenger on most routes.';
  const page = [...filler(20), needle, ...filler(20)].join('\n\n');

  test('no query → returns null so the caller falls back to head/tail windowing', () => {
    expect(excerptRelevant(page, '', 400)).toBeNull();
    expect(excerptRelevant(page, '   ', 400)).toBeNull();
  });

  test('text at or under budget passes through whole (not excerpted)', () => {
    const r = excerptRelevant('a short body about baggage', 'baggage', 1000);
    expect(r).not.toBeNull();
    expect(r!.excerpted).toBe(false);
    expect(r!.excerpt).toBe('a short body about baggage');
  });

  test('surfaces the passage that answers the query and drops the filler', () => {
    const budget = 400;   // far smaller than the full page → must choose
    const r = excerptRelevant(page, 'Qatar economy baggage allowance kg', budget);
    expect(r).not.toBeNull();
    expect(r!.excerpted).toBe(true);
    // the answer is present even though it sat in the MIDDLE (a head+tail window would miss it)
    expect(r!.excerpt).toContain('30 kg');
    // it dropped most passages (chose a few relevant, not all 41)
    expect(r!.passagesShown).toBeLessThan(r!.passagesTotal);
    // and it flagged that passages were elided, so the model knows it isn't the whole page
    expect(r!.excerpt).toMatch(/passage\(s\)/);
    // budget respected
    expect(r!.charsShown).toBeLessThanOrEqual(budget);
  });

  test('kept passages stay in document order', () => {
    // two needles far apart; both should appear, first one before the second
    const p = [needle, ...filler(30), 'Business class baggage allowance is 40 kg.'].join('\n\n');
    const r = excerptRelevant(p, 'baggage allowance kg', 500);
    expect(r).not.toBeNull();
    const i30 = r!.excerpt.indexOf('30 kg');
    const i40 = r!.excerpt.indexOf('40 kg');
    if (i30 !== -1 && i40 !== -1) expect(i30).toBeLessThan(i40);   // document order preserved
  });

  test('query that matches nothing → null (fall back to windowing)', () => {
    expect(excerptRelevant(page, 'xyzzyquux nonexistentterm', 400)).toBeNull();
  });
});

describe('excerptFooter', () => {
  test('names the passages shown, the query, and the read_web_cache call', () => {
    const f = excerptFooter({ key: 'wc-abc-1', total: 90_000, passagesShown: 3, passagesTotal: 55, query: 'baggage allowance' });
    expect(f).toContain('read_web_cache');
    expect(f).toContain('"key": "wc-abc-1"');
    expect(f).toContain('3 passage(s)');
    expect(f).toContain('baggage allowance');
    expect(f).toContain('NOT a contiguous slice');   // the honesty flag: it's relevance-ranked, not a window
  });
});
