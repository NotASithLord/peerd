import { describe, test, expect } from 'bun:test';
import { aggregate, compare, includesCI, usedAny, wastedTurns } from '../../extension/eval/score.js';

const R = (id: string, pass: boolean, extra: any = {}) => ({ id, pass, steps: 3, tokens: 1000, durationMs: 5000, ...extra });

describe('aggregate', () => {
  test('headline passRate + counts', () => {
    const card = aggregate([R('a', true), R('b', true), R('c', false, { detail: 'nope', error: 'x' })]);
    expect(card.total).toBe(3);
    expect(card.passed).toBe(2);
    expect(card.failed).toBe(1);
    expect(card.passRate).toBe(66.7);
    expect(card.failures).toEqual([{ id: 'c', detail: 'nope', error: 'x' }]);
  });

  test('averages metrics, ignoring missing', () => {
    const card = aggregate([R('a', true, { steps: 2, tokens: 100, durationMs: 1000 }), R('b', true, { steps: 4, tokens: 300, durationMs: 3000 })]);
    expect(card.avgSteps).toBe(3);
    expect(card.avgTokens).toBe(200);
    expect(card.avgDurationMs).toBe(2000);
  });

  test('splits the token buckets + reports fresh and $/task', () => {
    // The whole point of the split: separate cheap cache-reads from full-price
    // fresh (input+output) tokens, and surface the actual USD cost.
    const card = aggregate([
      R('a', true, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 30_000, cacheWriteTokens: 500, costUsd: 0.004 }),
      R('b', true, { inputTokens: 2000, outputTokens: 400, cacheReadTokens: 50_000, cacheWriteTokens: 1500, costUsd: 0.006 }),
    ]);
    expect(card.avgInputTokens).toBe(1500);
    expect(card.avgOutputTokens).toBe(300);
    expect(card.avgCacheReadTokens).toBe(40_000);
    expect(card.avgCacheWriteTokens).toBe(1000);
    expect(card.avgFreshTokens).toBe(1800);   // input + output — the real-cost / context-pressure proxy
    expect(card.avgCostUsd).toBe(0.005);       // sub-cent precision (5dp), not rounded to $0.00
  });

  test('tracks web actor spend separately from main', () => {
    const card = aggregate([
      R('a', true, { inputTokens: 50, outputTokens: 10, runnerTokens: 40_000 }),  // most work offloaded to the web actor
      R('b', true, { inputTokens: 60, outputTokens: 20, runnerTokens: 20_000 }),
    ]);
    expect(card.avgRunnerTokens).toBe(30_000);   // the relocated page-mechanics spend
    expect(card.avgFreshTokens).toBe(70);        // main context stays tiny (the win)
  });

  test('empty suite is 0%, not NaN', () => {
    const card = aggregate([]);
    expect(card.passRate).toBe(0);
    expect(card.total).toBe(0);
    expect(card.avgFreshTokens).toBe(0);
    expect(card.avgCostUsd).toBe(0);
  });
});

describe('compare', () => {
  test('flags regressions (was passing, now failing) and credits fixes', () => {
    const before = aggregate([R('a', true), R('b', false, { detail: 'x' }), R('c', true)]);
    const after = aggregate([R('a', false, { detail: 'broke' }), R('b', true), R('c', true)]);
    const d = compare(before, after);
    expect(d.regressions).toEqual(['a']); // newly failing — the thing to block on
    expect(d.fixes).toEqual(['b']);       // newly passing — credit for the change
  });

  test('clean run vs clean baseline → no regressions, no fixes', () => {
    const card = aggregate([R('a', true), R('b', true)]);
    const d = compare(card, card);
    expect(d.regressions).toEqual([]);
    expect(d.fixes).toEqual([]);
    expect(d.passRateDelta).toBe(0);
    expect(d.freshTokensDelta).toBe(0);
  });

  test('numeric deltas are after − before (negative cost = the win)', () => {
    const before = aggregate([R('a', true, { inputTokens: 2000, outputTokens: 400, costUsd: 0.010, steps: 6 })]);
    const after = aggregate([R('a', true, { inputTokens: 1000, outputTokens: 200, costUsd: 0.004, steps: 4 })]);
    const d = compare(before, after);
    expect(d.freshTokensDelta).toBe(-1200); // 1200 vs 2400 fresh → leaner
    expect(d.costUsdDelta).toBe(-0.006);    // cheaper → negative
    expect(d.stepsDelta).toBe(-2);
    expect(d.passRateDelta).toBe(0);
  });

  test('safe on null/empty cards', () => {
    const d = compare(null as any, aggregate([]));
    expect(d.regressions).toEqual([]);
    expect(d.fixes).toEqual([]);
    expect(d.passRateDelta).toBe(0);
  });
});

describe('aggregate — tool-error metrics', () => {
  test('averages errors + calls, suite-wide error RATE is sum/sum', () => {
    const card = aggregate([
      R('a', true, { toolCalls: 2, toolErrors: 0, toolErrorsByName: {} }),
      R('b', false, { toolCalls: 8, toolErrors: 4, toolErrorsByName: { click: 3, read_file: 1 }, detail: 'x' }),
    ]);
    expect(card.avgToolCalls).toBe(5);        // (2+8)/2
    expect(card.avgToolErrors).toBe(2);       // (0+4)/2
    // 4 errors / 10 calls = 0.4 — the 8-call task weighs proportionally, not
    // a 50/50 mean of per-row rates (which would be 0.25).
    expect(card.toolErrorRate).toBe(0.4);
    expect(card.toolErrorsByName).toEqual({ click: 3, read_file: 1 });
  });

  test('rolls toolErrorsByName across rows; ignores rows missing the field', () => {
    const card = aggregate([
      R('a', false, { toolCalls: 3, toolErrors: 2, toolErrorsByName: { click: 2 }, detail: 'x' }),
      R('b', false, { toolCalls: 3, toolErrors: 1, toolErrorsByName: { click: 1 }, detail: 'y' }),
      R('c', true), // early-return-shaped row: no tool fields — must not throw
    ]);
    expect(card.toolErrorsByName).toEqual({ click: 3 });
  });

  test('averages wasted turns', () => {
    const card = aggregate([
      R('a', true, { wastedTurns: 0 }),
      R('b', true, { wastedTurns: 4 }),
    ]);
    expect(card.avgWastedTurns).toBe(2);
  });

  test('no calls → error rate is 0, not NaN', () => {
    const card = aggregate([R('a', true), R('b', true)]);
    expect(card.toolErrorRate).toBe(0);
    expect(card.avgToolErrors).toBe(0);
    expect(card.toolErrorsByName).toEqual({});
  });
});

describe('compare — tool-error deltas', () => {
  test('signed after − before (negative = fewer errors, the win)', () => {
    const before = aggregate([R('a', true, { toolCalls: 4, toolErrors: 4, wastedTurns: 3 })]);
    const after = aggregate([R('a', true, { toolCalls: 4, toolErrors: 1, wastedTurns: 1 })]);
    const d = compare(before, after);
    expect(d.toolErrorsDelta).toBe(-3);
    expect(d.wastedTurnsDelta).toBe(-2);
    expect(d.toolErrorRateDelta).toBe(-0.75); // 0.25 − 1.00
  });

  test('a regression rise is positive (what the opt-in guard blocks on)', () => {
    const before = aggregate([R('a', true, { toolCalls: 4, toolErrors: 0 })]);
    const after = aggregate([R('a', true, { toolCalls: 4, toolErrors: 2 })]);
    expect(compare(before, after).toolErrorsDelta).toBe(2);
  });
});

describe('wastedTurns — the three named heuristics', () => {
  test('repeated-identical-call counts the extras (same tool + same args)', () => {
    const w = wastedTurns([
      { name: 'read_file', input: { path: '/a' } },
      { name: 'read_file', input: { path: '/a' } },  // extra 1
      { name: 'read_file', input: { path: '/a' } },  // extra 2
    ]);
    expect(w.byKind.repeatedIdenticalCall).toBe(2);
  });

  test('key is order-independent over args (a stable hash)', () => {
    const w = wastedTurns([
      { name: 'click', input: { a: 1, b: 2 } },
      { name: 'click', input: { b: 2, a: 1 } }, // same identity despite key order
    ]);
    expect(w.byKind.repeatedIdenticalCall).toBe(1);
  });

  test('different args are NOT repeats — a real loop is not waste', () => {
    const w = wastedTurns([
      { name: 'click', input: { sel: '#1' } },
      { name: 'click', input: { sel: '#2' } },
      { name: 'click', input: { sel: '#3' } },
    ]);
    expect(w.byKind.repeatedIdenticalCall).toBe(0);
  });

  test('error-then-retry counts a failed call followed by the same tool', () => {
    const w = wastedTurns([
      { name: 'click', input: { sel: '#x' }, ok: false },
      { name: 'click', input: { sel: '#y' }, ok: true }, // retry (different args → not a repeat)
    ]);
    expect(w.byKind.errorThenRetry).toBe(1);
    expect(w.byKind.repeatedIdenticalCall).toBe(0);
  });

  test('blind spot: a retry via a DIFFERENT tool is invisible (undercounts)', () => {
    const w = wastedTurns([
      { name: 'click', input: {}, ok: false },
      { name: 'page_code', input: {}, ok: true }, // recovered via another tool — not seen
    ]);
    expect(w.byKind.errorThenRetry).toBe(0);
  });

  test('blind spot: a retry after an intervening step is invisible', () => {
    const w = wastedTurns([
      { name: 'fetch_url', input: { url: 'https://a' }, ok: false },
      { name: 'now', input: {}, ok: true },
      { name: 'fetch_url', input: { url: 'https://b' }, ok: false }, // not immediately after the first
    ]);
    expect(w.byKind.errorThenRetry).toBe(0);
  });

  test('truncation-forced-reread: a read tool re-hit on the same target (no marker → approximate)', () => {
    const w = wastedTurns([
      { name: 'read_file', input: { path: '/big', offset: 0 } },
      { name: 'read_file', input: { path: '/big', offset: 500 } }, // same primary target, paged
    ]);
    // same target, looser primary-arg match catches the paged reread even though
    // the full args differ (so repeated-identical-call does NOT fire here).
    expect(w.byKind.truncationForcedReread).toBe(1);
    expect(w.byKind.repeatedIdenticalCall).toBe(0);
  });

  test('truncation heuristic ignores non-read tools', () => {
    const w = wastedTurns([
      { name: 'click', input: { sel: '#a' } },
      { name: 'click', input: { sel: '#a', extra: true } }, // different full args, not a read tool
    ]);
    expect(w.byKind.truncationForcedReread).toBe(0);
  });

  test('with truncated markers: a reread after a COMPLETE read is not truncation-forced', () => {
    const w = wastedTurns([
      { name: 'fetch_url', input: { url: 'https://x' }, truncated: false },
      { name: 'fetch_url', input: { url: 'https://x' } }, // prior read was complete → skip
    ]);
    expect(w.byKind.truncationForcedReread).toBe(0);
  });

  test('with truncated markers: a reread after a TRUNCATED read counts', () => {
    const w = wastedTurns([
      { name: 'fetch_url', input: { url: 'https://x' }, truncated: true },
      { name: 'fetch_url', input: { url: 'https://x' } },
    ]);
    expect(w.byKind.truncationForcedReread).toBe(1);
  });

  test('total sums the kinds (overlap is deliberate) and is safe on junk input', () => {
    const w = wastedTurns([
      { name: 'read_file', input: { path: '/a' } },
      { name: 'read_file', input: { path: '/a' } }, // repeated-identical +1 AND truncation +1
    ]);
    expect(w.byKind.repeatedIdenticalCall).toBe(1);
    expect(w.byKind.truncationForcedReread).toBe(1);
    expect(w.total).toBe(2); // documented double-count
    expect(wastedTurns(null as any).total).toBe(0);
    expect(wastedTurns([]).total).toBe(0);
  });
});

describe('includesCI', () => {
  test('case-insensitive substring; safe on non-strings', () => {
    expect(includesCI('Ada Lovelace', 'ada')).toBe(true);
    expect(includesCI('hello', 'bye')).toBe(false);
    expect(includesCI(null as any, 'x')).toBe(false);
  });
});

describe('usedAny', () => {
  test('true when the agent used any of the named tools', () => {
    expect(usedAny(['get', 'click'], ['get'])).toBe(true);
    expect(usedAny(['script'], ['sandbox_create', 'js_notebook', 'script'])).toBe(true);
  });
  test('false when none matched, or on non-arrays', () => {
    expect(usedAny(['click', 'type'], ['get'])).toBe(false);
    expect(usedAny([], ['get'])).toBe(false);
    expect(usedAny(null as any, ['get'])).toBe(false);
    expect(usedAny(['get'], null as any)).toBe(false);
  });
});
