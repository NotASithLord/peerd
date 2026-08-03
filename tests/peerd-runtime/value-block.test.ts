// The shared [VALUE] block for script / js_notebook tool results — capped at
// the SOURCE so a giant returned value reaches the model as a clean cut plus
// an actionable instruction, not blind head+tail-elided broken JSON (the field
// case: a ~437k-char hand-rolled chart spec).

import { describe, test, expect } from 'bun:test';
import { pushValueBlock, serializeValue } from '../../extension/peerd-runtime/tools/defs/value-block.js';

describe('pushValueBlock', () => {
  test('small values render in full', () => {
    const lines: string[] = [];
    pushValueBlock(lines, { a: 1 });
    expect(lines[0]).toBe('[VALUE]');
    expect(lines[1]).toContain('"a": 1');
    expect(lines.join('\n').includes('TRUNCATED')).toBe(false);
  });

  test('undefined appends nothing (a run with no return has no [VALUE])', () => {
    const lines: string[] = [];
    pushValueBlock(lines, undefined);
    expect(lines.length).toBe(0);
  });

  test('a huge value is cut with an actionable note, not silently elided mid-JSON', () => {
    const lines: string[] = [];
    const big = { values: Array.from({ length: 20000 }, (_, i) => ({ x: i, density: 0.123 })) };
    pushValueBlock(lines, big);
    const out = lines.join('\n');
    expect(out.length).toBeLessThan(7000);
    expect(out).toContain('[VALUE TRUNCATED');
    expect(out).toContain('COMPACT');
    expect(out).toContain('chart()/table()');
  });

  test('an unstringifiable value falls back to String()', () => {
    const lines: string[] = [];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    pushValueBlock(lines, cyclic);
    expect(lines[1]).toBe('[object Object]');
  });
});

// The overflow CONTRACT (design 1b): the spill path serializes ONCE via
// serializeValue (full text + verdict), then threads the result back into
// pushValueBlock — one serialization chain, two consumers, one stringify pass.
describe('serializeValue / pushValueBlock precomputed serialization', () => {
  test('undefined → undefined (no value, nothing to spill, nothing appended)', () => {
    expect(serializeValue(undefined)).toBeUndefined();
    const lines: string[] = [];
    pushValueBlock(lines, undefined);
    expect(lines.length).toBe(0);
  });

  test('a small value reports truncated:false with its full text', () => {
    const sv = serializeValue({ a: 1 });
    expect(sv?.truncated).toBe(false);
    expect(sv?.text).toContain('"a": 1');
  });

  test('an oversized value reports truncated:true and the FULL text survives in the info', () => {
    const sv = serializeValue('z'.repeat(10_000));
    expect(sv?.truncated).toBe(true);
    expect(sv?.text.length).toBeGreaterThan(10_000);  // JSON-quoted full text
  });

  test('a precomputed serialization is USED, not re-derived (single stringify pass)', () => {
    const lines: string[] = [];
    // A deliberately mismatched sv proves pushValueBlock trusts the caller's
    // precomputed result instead of serializing `value` again.
    pushValueBlock(lines, { ignored: true }, { text: 'precomputed', truncated: false });
    expect(lines).toEqual(['[VALUE]', 'precomputed']);
  });

  test('pushValueBlock and serializeValue agree (same serialization chain)', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(serializeValue(cyclic)?.text).toBe('[object Object]');
  });
});
