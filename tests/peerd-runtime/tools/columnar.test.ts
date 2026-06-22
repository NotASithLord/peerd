import { describe, test, expect } from 'bun:test';
import { columnarize, serializeListResult } from '../../../extension/peerd-runtime/tools/defs/columnar.js';

// why: the densifier replaces verbose pretty-printed record arrays with a
// columnar transpose to cut tokens. The contract that matters is LOSSLESS:
// columns + rows must reconstruct the original records exactly, and small or
// non-uniform lists must keep their original byte-for-byte output so nothing
// downstream (or any existing test) shifts under them.

const vm = (id: number, live = false) => ({
  id: `vm-${id}`,
  name: `project-${id}`,
  pinned: false,
  createdAt: '2026-06-16T12:00:00.000Z',
  lastUsedAt: '2026-06-17T08:00:00.000Z',
  live,
  isCurrent: id === 1,
});

const reconstruct = (columns: string[], rows: unknown[][]) =>
  rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));

describe('columnarize', () => {
  test('returns null below the 5-record gate', () => {
    expect(columnarize([vm(1), vm(2), vm(3), vm(4)])).toBeNull();
  });

  test('transposes a uniform list at/above the gate', () => {
    const records = [vm(1), vm(2), vm(3), vm(4), vm(5)];
    const out = columnarize(records)!;
    expect(out.columns).toEqual(['id', 'name', 'pinned', 'createdAt', 'lastUsedAt', 'live', 'isCurrent']);
    expect(out.rows).toHaveLength(5);
    // lossless: columns + rows reconstruct the originals exactly
    expect(reconstruct(out.columns, out.rows)).toEqual(records);
  });

  test('reads by column NAME, so record key order is irrelevant', () => {
    const a = { id: 'a', name: 'one', live: true };
    const b = { live: false, id: 'b', name: 'two' }; // keys reordered
    const records = [a, b, { ...a, id: 'c' }, { ...b, id: 'd' }, { ...a, id: 'e' }];
    const out = columnarize(records)!;
    expect(out.columns).toEqual(['id', 'name', 'live']);
    expect(reconstruct(out.columns, out.rows)).toEqual(records);
  });

  test('preserves nested array/object cells losslessly', () => {
    const records = Array.from({ length: 6 }, (_, i) => ({
      id: `app-${i}`,
      tags: ['a', 'b', i],
      meta: { nested: { deep: i }, list: [1, 2] },
    }));
    const out = columnarize(records)!;
    expect(reconstruct(out.columns, out.rows)).toEqual(records);
  });

  test('falls back to null on non-uniform key sets (extra or missing key)', () => {
    const base = [vm(1), vm(2), vm(3), vm(4)];
    expect(columnarize([...base, { ...vm(5), extra: 1 }])).toBeNull(); // extra key
    const { isCurrent: _drop, ...missing } = vm(5);
    expect(columnarize([...base, missing])).toBeNull();                // missing key
  });

  test('falls back to null when any element is not a plain object', () => {
    expect(columnarize([vm(1), vm(2), vm(3), vm(4), ['not', 'an', 'object']])).toBeNull();
    expect(columnarize([vm(1), vm(2), vm(3), vm(4), null])).toBeNull();
    expect(columnarize([1, 2, 3, 4, 5])).toBeNull();
  });

  test('falls back to null on a non-array', () => {
    expect(columnarize(undefined)).toBeNull();
    expect(columnarize('nope')).toBeNull();
  });
});

describe('serializeListResult', () => {
  test('small lists keep byte-for-byte pretty JSON (no behavior change)', () => {
    const wrapper = { currentVmId: 'vm-1', count: 2, vms: [vm(1), vm(2)] };
    expect(serializeListResult(wrapper, 'vms')).toBe(JSON.stringify(wrapper, null, 2));
  });

  test('densifies big lists: scalars preserved, array swapped for columns/rows + legend', () => {
    const vms = [vm(1), vm(2), vm(3), vm(4), vm(5), vm(6)];
    const wrapper = { currentVmId: 'vm-1', count: 6, vms };
    const parsed = JSON.parse(serializeListResult(wrapper, 'vms'));

    // scalar header fields survive
    expect(parsed.currentVmId).toBe('vm-1');
    expect(parsed.count).toBe(6);
    // the row-object array is gone, replaced by the columnar trio
    expect(parsed.vms).toBeUndefined();
    expect(parsed.vms_format).toContain('columnar');
    expect(parsed.vms_columns).toEqual(['id', 'name', 'pinned', 'createdAt', 'lastUsedAt', 'live', 'isCurrent']);
    // lossless round-trip back to the original records
    expect(reconstruct(parsed.vms_columns, parsed.vms_rows)).toEqual(vms);
  });

  test('the densified form is meaningfully smaller than pretty JSON', () => {
    const vms = Array.from({ length: 20 }, (_, i) => vm(i + 1));
    const wrapper = { currentVmId: 'vm-1', count: 20, vms };
    const dense = serializeListResult(wrapper, 'vms');
    const pretty = JSON.stringify(wrapper, null, 2);
    expect(dense.length).toBeLessThan(pretty.length * 0.6); // >40% smaller
  });
});
