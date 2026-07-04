// The shared [VALUE] block for js_run / js_notebook tool results — capped at
// the SOURCE so a giant returned value reaches the model as a clean cut plus
// an actionable instruction, not blind head+tail-elided broken JSON (the field
// case: a ~437k-char hand-rolled chart spec).

import { describe, test, expect } from 'bun:test';
import { pushValueBlock } from '../../extension/peerd-runtime/tools/defs/value-block.js';

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
