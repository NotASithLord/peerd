import { describe, test, expect } from 'bun:test';
import { partitionToolBatch } from '../../../extension/peerd-runtime/loop/tool-batch.js';

// partitionToolBatch is the pure scheduler behind concurrent tool dispatch:
// CONSECUTIVE concurrency-safe calls (READ-class under the permission
// policy) group into one concurrent wave; everything else is a single
// sequential wave. Flattened order must always equal input order — a safe
// call is never hoisted past an unsafe one.

const tu = (id: string, name: string) => ({ id, name });
const READS = new Set(['read_a', 'read_b', 'read_c']);
const isSafe = (t: { name: string }) => READS.has(t.name);

const flatten = (waves: Array<{ calls: Array<{ id: string }> }>) =>
  waves.flatMap((w) => w.calls.map((c) => c.id));

describe('partitionToolBatch', () => {
  test('all-safe batch becomes ONE concurrent wave', () => {
    const batch = [tu('1', 'read_a'), tu('2', 'read_b'), tu('3', 'read_c')];
    const waves = partitionToolBatch(batch, isSafe);
    expect(waves.length).toBe(1);
    expect(waves[0].concurrent).toBe(true);
    expect(waves[0].calls.map((c) => c.id)).toEqual(['1', '2', '3']);
  });

  test('all-unsafe batch becomes singleton sequential waves', () => {
    const batch = [tu('1', 'click'), tu('2', 'type')];
    const waves = partitionToolBatch(batch, isSafe);
    expect(waves.map((w) => w.concurrent)).toEqual([false, false]);
    expect(flatten(waves)).toEqual(['1', '2']);
  });

  test('only CONSECUTIVE safe calls group — a read after a write is not hoisted', () => {
    // [read, read, write, read] — the trailing read must run AFTER the
    // write (the model may have sequenced "click, then read" on purpose).
    const batch = [tu('1', 'read_a'), tu('2', 'read_b'), tu('3', 'click'), tu('4', 'read_a')];
    const waves = partitionToolBatch(batch, isSafe);
    expect(waves.length).toBe(3);
    expect(waves[0].concurrent).toBe(true);
    expect(waves[0].calls.map((c) => c.id)).toEqual(['1', '2']);
    expect(waves[1].concurrent).toBe(false);
    expect(waves[1].calls.map((c) => c.id)).toEqual(['3']);
    expect(waves[2].concurrent).toBe(false);    // single call → normalized sequential
    expect(waves[2].calls.map((c) => c.id)).toEqual(['4']);
    expect(flatten(waves)).toEqual(['1', '2', '3', '4']);
  });

  test('a lone safe call is normalized to a sequential wave', () => {
    const waves = partitionToolBatch([tu('1', 'read_a')], isSafe);
    expect(waves.length).toBe(1);
    expect(waves[0].concurrent).toBe(false);
  });

  test('two separated safe runs become two distinct concurrent waves', () => {
    const batch = [
      tu('1', 'read_a'), tu('2', 'read_b'),
      tu('3', 'click'),
      tu('4', 'read_a'), tu('5', 'read_c'),
    ];
    const waves = partitionToolBatch(batch, isSafe);
    expect(waves.map((w) => w.concurrent)).toEqual([true, false, true]);
    expect(flatten(waves)).toEqual(['1', '2', '3', '4', '5']);
  });

  test('a throwing predicate counts as NOT safe (fail toward serial)', () => {
    const batch = [tu('1', 'read_a'), tu('2', 'read_b')];
    const waves = partitionToolBatch(batch, (t) => {
      if (t.id === '2') throw new Error('boom');
      return true;
    });
    expect(waves.map((w) => w.concurrent)).toEqual([false, false]);
    expect(flatten(waves)).toEqual(['1', '2']);
  });

  test('empty / nullish input yields no waves', () => {
    expect(partitionToolBatch([], isSafe)).toEqual([]);
    expect(partitionToolBatch(undefined as any, isSafe)).toEqual([]);
  });

  test('flattened wave order ALWAYS equals input order', () => {
    // Property-ish check over a few shuffled shapes.
    const shapes = [
      ['read_a', 'click', 'read_b', 'read_c', 'type', 'read_a'],
      ['click', 'read_a', 'read_b'],
      ['read_a', 'read_b', 'read_c'],
      ['click'],
    ];
    for (const names of shapes) {
      const batch = names.map((n, i) => tu(String(i), n));
      expect(flatten(partitionToolBatch(batch, isSafe)))
        .toEqual(batch.map((c) => c.id));
    }
  });
});
