// The spill-and-page pure core (tools/web/spill.js): head+tail windowing for an
// oversized fetched body, the trusted paging footer, and the offset/limit
// slicer read_result serves. Pure functions — the invariants that keep the
// paging contract honest live here.

import { describe, test, expect } from 'bun:test';
import { windowText, pagingFooter, pageSlice, pageStatusLine, SPILL_PAGE_CHARS, PAGED_MAX_CHARS, clampPageLimit, buildPagedResult, excerptRelevant, excerptFooter } from '../../../extension/peerd-runtime/tools/web/spill.js';

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
  test('names the exact read_result call with the caller-computed values only', () => {
    const f = pagingFooter({ key: 'wc-abc-1', total: 90_000, headChars: 12_000, tailChars: 4_000 });
    expect(f).toContain('read_result');
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

describe('pageStatusLine (the shared offset/limit paging footer)', () => {
  test('mid-text: names how much remains and the exact next call', () => {
    const page = pageSlice('z'.repeat(100), 0, 40);   // offset 0, end 40, remaining 60
    const line = pageStatusLine({ page, nextArgs: '{ "key": "k1", "offset": 40 }' });
    expect(line).toContain('chars 0–40 of 100');
    expect(line).toContain('60 remain');
    expect(line).toContain('next: { "key": "k1", "offset": 40 }.');
  });

  test('final slice: end-of-text instead of a next-call hint', () => {
    const page = pageSlice('z'.repeat(100), 90, 50);   // remaining 0
    const line = pageStatusLine({ page, nextArgs: '{ "path": "f", "offset": 100 }' });
    expect(line).toContain('end of stored text');
    expect(line).not.toContain('next:');
  });

  test('the shared slice size is one constant (page in == page out)', () => {
    expect(SPILL_PAGE_CHARS).toBe(16_000);
  });
});

describe('clampPageLimit (the ONE shared limit clamp)', () => {
  test('absent / non-positive → the cap; larger → capped; in-range → verbatim', () => {
    expect(clampPageLimit(undefined)).toBe(SPILL_PAGE_CHARS);
    expect(clampPageLimit(0)).toBe(SPILL_PAGE_CHARS);
    expect(clampPageLimit(-5)).toBe(SPILL_PAGE_CHARS);
    expect(clampPageLimit(999_999)).toBe(SPILL_PAGE_CHARS);
    expect(clampPageLimit(500)).toBe(500);
  });
});

describe('buildPagedResult (fits the FRAMED slice under the paged ceiling)', () => {
  test('a plain slice frames straight through, flagged paged', () => {
    const r = buildPagedResult({ text: 'a'.repeat(1000), offset: 0, limit: SPILL_PAGE_CHARS, frame: (p) => p.slice });
    expect(r).toMatchObject({ ok: true, paged: true });
    expect(r.content).toBe('a'.repeat(1000));
    expect(PAGED_MAX_CHARS).toBeGreaterThan(SPILL_PAGE_CHARS);
  });

  test('shrinks the slice when framing inflates it past PAGED_MAX_CHARS', () => {
    // A framer that doubles every char: a full 16k slice would frame to 32k —
    // buildPagedResult must shrink until the framed content fits the ceiling.
    const inflate = (p: { slice: string }) => p.slice.replace(/./g, 'xx');
    const r = buildPagedResult({ text: 'a'.repeat(40_000), offset: 0, limit: SPILL_PAGE_CHARS, frame: inflate });
    expect(r.content.length).toBeLessThanOrEqual(PAGED_MAX_CHARS);
    expect(r.content.length).toBeGreaterThan(0);
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
  test('names the passages shown, the query, and the read_result call', () => {
    const f = excerptFooter({ key: 'wc-abc-1', total: 90_000, passagesShown: 3, passagesTotal: 55, query: 'baggage allowance' });
    expect(f).toContain('read_result');
    expect(f).toContain('"key": "wc-abc-1"');
    expect(f).toContain('3 passage(s)');
    expect(f).toContain('baggage allowance');
    expect(f).toContain('NOT a contiguous slice');   // the honesty flag: it's relevance-ranked, not a window
  });
});
