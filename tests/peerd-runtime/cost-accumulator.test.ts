// Cost telemetry (feature 06) — accumulator + hard-limit predicate.
//
// The accumulator is the functional core: pure folds over token usage and
// a pure limit-exceeded predicate. The SW's imperative shell (persist,
// push, abort) is exercised by the in-browser runner; here we lock down
// the math and the exact limit-crossing boundary.

import { describe, test, expect } from 'bun:test';
import {
  emptyTally,
  normalizeTally,
  addUsage,
  bumpTurn,
  totalTokens,
  limitExceeded,
} from '../../extension/peerd-runtime/cost/accumulator.js';

const usage = (i: number, o: number, cr = 0, cw = 0) => ({
  inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheWriteTokens: cw,
});

describe('accumulator folds', () => {
  test('emptyTally is all zeros and a fresh object each call', () => {
    const a = emptyTally();
    const b = emptyTally();
    expect(a).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, cost: 0, turns: 0,
    });
    expect(a).not.toBe(b);
  });

  test('addUsage sums tokens + cost without mutating the input', () => {
    const t0 = emptyTally();
    const t1 = addUsage(t0, usage(100, 50, 10, 5), 0.0025);
    expect(t1.inputTokens).toBe(100);
    expect(t1.outputTokens).toBe(50);
    expect(t1.cacheReadTokens).toBe(10);
    expect(t1.cacheWriteTokens).toBe(5);
    expect(t1.cost).toBeCloseTo(0.0025, 8);
    // immutability
    expect(t0.inputTokens).toBe(0);
    expect(t0.cost).toBe(0);

    // a second fold accumulates (multi-step tool-using turn)
    const t2 = addUsage(t1, usage(200, 75), 0.004);
    expect(t2.inputTokens).toBe(300);
    expect(t2.outputTokens).toBe(125);
    expect(t2.cost).toBeCloseTo(0.0065, 8);
  });

  test('bumpTurn increments only the turn counter', () => {
    const t = bumpTurn(addUsage(emptyTally(), usage(10, 10), 1));
    expect(t.turns).toBe(1);
    expect(t.inputTokens).toBe(10);
    expect(bumpTurn(t).turns).toBe(2);
  });

  test('totalTokens sums all four buckets', () => {
    expect(totalTokens(usage(1, 2, 3, 4) as any)).toBe(10);
  });

  test('addUsage tolerates a non-finite cost (NaN guard)', () => {
    const t = addUsage(emptyTally(), usage(10, 10), Number.NaN);
    expect(t.cost).toBe(0);
  });
});

describe('normalizeTally', () => {
  test('coerces missing/garbage into a valid zeroed tally', () => {
    expect(normalizeTally(undefined)).toEqual(emptyTally());
    expect(normalizeTally(null)).toEqual(emptyTally());
    expect(normalizeTally({ inputTokens: -5, cost: NaN } as any)).toEqual(emptyTally());
  });

  test('keeps valid numeric fields', () => {
    const t = normalizeTally({ inputTokens: 42, cost: 1.5, turns: 3 } as any);
    expect(t.inputTokens).toBe(42);
    expect(t.cost).toBe(1.5);
    expect(t.turns).toBe(3);
    expect(t.outputTokens).toBe(0);
  });
});

describe('limitExceeded predicate (the hard-limit halt trigger)', () => {
  test('no limit configured → never exceeded', () => {
    expect(limitExceeded(999, 0)).toBe(false);
    expect(limitExceeded(999, null as any)).toBe(false);
    expect(limitExceeded(999, undefined as any)).toBe(false);
    expect(limitExceeded(999, NaN)).toBe(false);
    expect(limitExceeded(999, -5)).toBe(false);
  });

  test('fires only when spend strictly exceeds the cap', () => {
    expect(limitExceeded(4.99, 5)).toBe(false);   // under
    expect(limitExceeded(5.0, 5)).toBe(false);    // exactly on cap is allowed
    expect(limitExceeded(5.01, 5)).toBe(true);    // over → halt
  });

  test('realistic accumulation crosses the cap mid-session', () => {
    const limit = 0.01;
    let session = bumpTurn(emptyTally());
    session = addUsage(session, usage(1000, 500), 0.006);
    expect(limitExceeded(session.cost, limit)).toBe(false);
    session = addUsage(session, usage(1000, 500), 0.006); // total 0.012
    expect(limitExceeded(session.cost, limit)).toBe(true);
  });
});
