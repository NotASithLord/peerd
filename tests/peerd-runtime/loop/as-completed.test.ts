import { describe, test, expect } from 'bun:test';
import { asCompleted } from '../../../extension/peerd-runtime/loop/agent-loop.js';

// asCompleted is the merge primitive behind concurrent tool dispatch: it
// yields each settled value the moment it lands (completion order), not the
// order the promises were passed in. That's what lets N spawned subagents
// flip their chat cards to "done" independently as each finishes.

const deferred = () => {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe('asCompleted', () => {
  test('yields in COMPLETION order, not input order', async () => {
    const a = deferred();
    const b = deferred();
    const c = deferred();
    const seen: string[] = [];

    const drain = (async () => {
      for await (const v of asCompleted([a.promise, b.promise, c.promise])) {
        seen.push(v as string);
      }
    })();

    // Resolve out of input order: c, then a, then b.
    c.resolve('c');
    await Promise.resolve();
    a.resolve('a');
    await Promise.resolve();
    b.resolve('b');
    await drain;

    expect(seen).toEqual(['c', 'a', 'b']);
  });

  test('yields every value exactly once', async () => {
    const ps = [
      Promise.resolve(1),
      Promise.resolve(2),
      Promise.resolve(3),
      Promise.resolve(4),
    ];
    const out: number[] = [];
    for await (const v of asCompleted(ps)) out.push(v as number);
    expect(out.slice().sort()).toEqual([1, 2, 3, 4]);
    expect(out.length).toBe(4);
  });

  test('empty input completes immediately', async () => {
    const out: unknown[] = [];
    for await (const v of asCompleted([])) out.push(v);
    expect(out).toEqual([]);
  });
});
