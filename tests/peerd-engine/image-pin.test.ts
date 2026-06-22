// image-pin — pure decision logic for the base-image TOFU fingerprint.
//
// The IO around it (ranged fetch, SHA-256, chrome.storage) lives in
// vm-tab.js; everything here is values in / decision out.

import { describe, test, expect } from 'bun:test';
import {
  IMAGE_PIN_HEAD_BYTES,
  parseContentRangeTotal,
  evaluateImagePin,
} from '../../extension/peerd-engine/image-pin.js';

describe('parseContentRangeTotal', () => {
  test('parses the total from a satisfied range', () => {
    expect(parseContentRangeTotal('bytes 0-65535/2000000000')).toBe(2_000_000_000);
  });

  test('parses an unsatisfied-range total (bytes */N)', () => {
    expect(parseContentRangeTotal('bytes */5044875331')).toBe(5_044_875_331);
  });

  test('is case-insensitive and whitespace-tolerant', () => {
    expect(parseContentRangeTotal('  Bytes 0-1023/4096 ')).toBe(4096);
  });

  test('unknown total (/*) is null, not a number', () => {
    expect(parseContentRangeTotal('bytes 0-65535/*')).toBeNull();
  });

  test('missing/malformed headers are null', () => {
    expect(parseContentRangeTotal(null)).toBeNull();
    expect(parseContentRangeTotal(undefined)).toBeNull();
    expect(parseContentRangeTotal('')).toBeNull();
    expect(parseContentRangeTotal('garbage')).toBeNull();
    expect(parseContentRangeTotal('items 0-10/100')).toBeNull();
    expect(parseContentRangeTotal('bytes 0-10')).toBeNull();
  });

  test('zero/overflow totals are rejected as unusable evidence', () => {
    expect(parseContentRangeTotal('bytes 0-0/0')).toBeNull();
    // beyond Number.MAX_SAFE_INTEGER — comparisons would be unreliable
    expect(parseContentRangeTotal('bytes 0-1/99999999999999999999')).toBeNull();
  });
});

describe('evaluateImagePin', () => {
  const fp = (over: Partial<{ totalBytes: number | null, headSha256: string }> = {}) => ({
    totalBytes: 2_000_000_000,
    headSha256: 'a'.repeat(64),
    ...over,
  });

  test('no pin yet → record (trust on first use)', () => {
    expect(evaluateImagePin({ pinned: null, observed: fp() })).toEqual({ action: 'record' });
    expect(evaluateImagePin({ pinned: undefined, observed: fp() })).toEqual({ action: 'record' });
  });

  test('identical fingerprint → match', () => {
    expect(evaluateImagePin({ pinned: fp(), observed: fp() })).toEqual({ action: 'match' });
  });

  test('changed head hash → mismatch naming the field', () => {
    const verdict = evaluateImagePin({
      pinned: fp(),
      observed: fp({ headSha256: 'b'.repeat(64) }),
    });
    expect(verdict).toEqual({ action: 'mismatch', mismatches: ['headSha256'] });
  });

  test('changed total size → mismatch even when the head still matches', () => {
    // why this case matters: an appended/truncated image keeps its head
    // bytes; the size is the only cheap evidence of the change.
    const verdict = evaluateImagePin({
      pinned: fp(),
      observed: fp({ totalBytes: 2_000_000_001 }),
    });
    expect(verdict).toEqual({ action: 'mismatch', mismatches: ['totalBytes'] });
  });

  test('both changed → both fields reported', () => {
    const verdict = evaluateImagePin({
      pinned: fp(),
      observed: { totalBytes: 1, headSha256: 'c'.repeat(64) },
    });
    expect(verdict).toEqual({ action: 'mismatch', mismatches: ['headSha256', 'totalBytes'] });
  });

  test('unknown total on either side is inconclusive, not a mismatch', () => {
    expect(evaluateImagePin({
      pinned: fp({ totalBytes: null }), observed: fp(),
    })).toEqual({ action: 'match' });
    expect(evaluateImagePin({
      pinned: fp(), observed: fp({ totalBytes: null }),
    })).toEqual({ action: 'match' });
  });

  test('head probe size spans past the ext2 boot block', () => {
    // bytes 0-1023 are the ext2 boot block (commonly zeros); anything
    // ≤1024 would hash a constant and pin nothing.
    expect(IMAGE_PIN_HEAD_BYTES).toBeGreaterThan(1024);
  });
});
