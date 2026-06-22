import { describe, test, expect } from 'bun:test';
import { aggregate, compare, includesCI, usedAny } from '../../extension/eval/score.js';

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

  test('tracks browser-runner (do/get/check) spend separately from main', () => {
    const card = aggregate([
      R('a', true, { inputTokens: 50, outputTokens: 10, runnerTokens: 40_000 }),  // most work offloaded to the runner
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
    expect(usedAny(['js_run'], ['js_create', 'js_notebook', 'js_run'])).toBe(true);
  });
  test('false when none matched, or on non-arrays', () => {
    expect(usedAny(['click', 'type'], ['get'])).toBe(false);
    expect(usedAny([], ['get'])).toBe(false);
    expect(usedAny(null as any, ['get'])).toBe(false);
    expect(usedAny(['get'], null as any)).toBe(false);
  });
});
