import { describe, test, expect } from 'bun:test';
import { canonicalize } from '../../extension/shared/bundle/canonical.js';

describe('canonical JSON (signing)', () => {
  test('sorts object keys regardless of insertion order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test('is deterministic for nested structures', () => {
    const x = { z: [3, 2, 1], a: { d: true, c: null } };
    expect(canonicalize(x)).toBe('{"a":{"c":null,"d":true},"z":[3,2,1]}');
  });

  test('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  test('refuses non-integer and non-finite numbers in signed payloads', () => {
    expect(() => canonicalize({ x: 1.5 })).toThrow();
    expect(() => canonicalize({ x: Infinity })).toThrow();
  });
});
