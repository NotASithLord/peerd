// peerd:std — the Notebook standard library. Pure functions (no DOM, no I/O),
// so exercised directly in bun. Display helpers return descriptors the page-side
// renderer turns into a table/SVG; data helpers are the "batteries".

import { describe, test, expect } from 'bun:test';
import {
  table, chart, sum, mean, median, min, max, round, range, unique, groupBy, sortBy,
  divmod, divDecimal,
  clamp, variance, stdev, quantile, mode, sumBy, meanBy, countBy, keyBy,
  chunk, zip, partition,
  parseJsonl, toJsonl, dedupeBy,
  gcd, lcm, factorial, modpow,
} from '../../extension/notebook-tab/notebook-std.js';

describe('peerd:std display helpers (pure descriptors)', () => {
  test('table → a table descriptor; non-array → empty rows', () => {
    const d = table([{ a: 1 }, { a: 2 }]);
    expect(d.__peerd_display).toBe('table');
    expect(d.rows.length).toBe(2);
    expect(table('nope' as any).rows).toEqual([]);
  });

  test('chart normalizes the spec; defaults type to bar and data to []', () => {
    const d = chart({ type: 'line', data: [1, 2, 3], title: 'T' });
    expect(d.__peerd_display).toBe('chart');
    expect(d.type).toBe('line');
    expect(d.data).toEqual([1, 2, 3]);
    expect(d.title).toBe('T');
    expect(chart({ type: 'nonsense' as any }).type).toBe('bar');
    expect(chart().data).toEqual([]);
    expect(chart({ title: 42 as any }).title).toBe(null);
  });
});

describe('peerd:std data helpers (pure)', () => {
  test('stats ignore non-finite / non-number values', () => {
    expect(sum([1, 2, 3, 'x', NaN, Infinity])).toBe(6);
    expect(mean([2, 4, 6])).toBe(4);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(min([5, 2, 8])).toBe(2);
    expect(max([5, 2, 8])).toBe(8);
    expect(Number.isNaN(mean([]))).toBe(true);
  });

  test('round to dp', () => {
    expect(round(3.14159, 2)).toBe(3.14);
    expect(round(2.5)).toBe(3);
  });

  test('range', () => {
    expect(range(3)).toEqual([0, 1, 2]);
    expect(range(2, 5)).toEqual([2, 3, 4]);
    expect(range(0, 10, 3)).toEqual([0, 3, 6, 9]);
    expect(range(5, 0)).toEqual([]);            // wrong direction with +step
    expect(range(3, 0, -1)).toEqual([3, 2, 1]);
  });

  test('unique / groupBy / sortBy are pure (no input mutation)', () => {
    expect(unique([1, 1, 2, 3, 3])).toEqual([1, 2, 3]);

    const rows = [{ k: 'a', v: 1 }, { k: 'b', v: 2 }, { k: 'a', v: 3 }];
    const g: any = groupBy(rows, 'k');
    expect(g.a.length).toBe(2);
    expect(g.b.length).toBe(1);

    const input = [{ n: 3 }, { n: 1 }, { n: 2 }];
    expect(sortBy(input, 'n').map((x: any) => x.n)).toEqual([1, 2, 3]);
    expect(input.map((x) => x.n)).toEqual([3, 1, 2]);  // original untouched
  });
});

describe('peerd:std exact integer / ratio math (no floats)', () => {
  test('divmod returns exact BigInt quotient + remainder', () => {
    expect(divmod(8944394323791464n, 9n)).toEqual({
      quotient: 993821591532384n, remainder: 8n,
    });
    expect(divmod(10n, 2n)).toEqual({ quotient: 5n, remainder: 0n });
    // sign follows BigInt / and % (truncate toward zero, remainder takes dividend sign)
    expect(divmod(-7n, 2n)).toEqual({ quotient: -3n, remainder: -1n });
    // accepts integer Number and all-digit strings, not just BigInt
    expect(divmod(7, 2)).toEqual({ quotient: 3n, remainder: 1n });
    expect(divmod('100', '7')).toEqual({ quotient: 14n, remainder: 2n });
    expect(() => divmod(1n, 0n)).toThrow(/division by zero/);
  });

  test('divDecimal expands a/b exactly — the transcript case that floats got wrong', () => {
    // Number(fib78) / 9 rounded to ...384.9; the exact value is ...384.8̄.
    expect(divDecimal(8944394323791464n, 9n)).toBe('993821591532384.88888888888888888888');
    expect(divDecimal(1n, 3n)).toBe('0.33333333333333333333');
    expect(divDecimal(1n, 3n, 5)).toBe('0.33333');
    expect(divDecimal(4n, 2n)).toBe('2');             // exact division → no point
    expect(divDecimal(7n, 8n)).toBe('0.875');         // terminating → trailing zeros trimmed
    expect(divDecimal(-1n, 3n)).toBe('-0.33333333333333333333');
    expect(divDecimal(0n, 5n)).toBe('0');
    expect(divDecimal(1n, 3n, 0)).toBe('0');          // zero places → integer part only
    expect(() => divDecimal(1n, 0n)).toThrow(/division by zero/);
  });

  test('exact helpers reject floats rather than silently lose precision', () => {
    expect(() => divmod(3.5, 2n)).toThrow(/expected an integer/);
    expect(() => divDecimal(1n, 2.5)).toThrow(/expected an integer/);
  });
});

describe('peerd:std stats + reshaping (pure)', () => {
  test('clamp keeps x inside [lo, hi]', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });

  test('variance / stdev — population by default, sample with the flag', () => {
    // population variance of [2,4,4,4,5,5,7,9] is 4 (the textbook example).
    const data = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(variance(data)).toBe(4);
    expect(stdev(data)).toBe(2);
    // sample variance divides by n-1 → larger.
    expect(round(variance([1, 2, 3, 4, 5], { sample: true }), 4)).toBe(2.5);
    expect(Number.isNaN(variance([1], { sample: true }))).toBe(true); // need 2 for sample
    expect(variance([5])).toBe(0);                                     // population ok with 1
    expect(variance(['x' as any])).toBeNaN();
  });

  test('quantile interpolates between ranks; 0.5 === median', () => {
    const data = [1, 2, 3, 4];
    expect(quantile(data, 0)).toBe(1);
    expect(quantile(data, 1)).toBe(4);
    expect(quantile(data, 0.5)).toBe(median(data));
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantile([], 0.5)).toBeNaN();
    expect(quantile([10, 20, 30], 2)).toBe(30); // q clamped to [0,1]
  });

  test('mode returns the most frequent value (first on ties)', () => {
    expect(mode([1, 2, 2, 3, 3, 3])).toBe(3);
    expect(mode(['a', 'b', 'a'])).toBe('a');
    expect(mode([])).toBeUndefined();
  });

  test('sumBy / meanBy / countBy / keyBy over rows', () => {
    const rows = [{ k: 'a', v: 1 }, { k: 'b', v: 2 }, { k: 'a', v: 3 }];
    expect(sumBy(rows, 'v')).toBe(6);
    expect(meanBy(rows, 'v')).toBe(2);
    expect(sumBy(rows, (r: any) => r.v * 2)).toBe(12);
    expect(countBy(rows, 'k')).toEqual({ a: 2, b: 1 });
    expect((keyBy(rows, 'k') as any).a).toEqual({ k: 'a', v: 3 }); // last write wins
  });

  test('chunk / zip / partition reshape without mutating input', () => {
    const input = [1, 2, 3, 4, 5];
    expect(chunk(input, 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);          // size floored to >=1
    expect(input).toEqual([1, 2, 3, 4, 5]);                // untouched

    expect(zip([1, 2, 3], ['a', 'b'])).toEqual([[1, 'a'], [2, 'b']]); // truncates
    expect(zip()).toEqual([]);

    expect(partition([1, 2, 3, 4], (n: number) => n % 2 === 0)).toEqual([[2, 4], [1, 3]]);
  });
});

describe('peerd:std line-delimited records (JSONL)', () => {
  test('parseJsonl: one value per non-blank line, skipping blanks + non-JSON lines', () => {
    const text = '{"id":1,"a":"x"}\n\n  \n{"id":2}\nnot json\n{"id":3}';
    expect(parseJsonl(text)).toEqual([{ id: 1, a: 'x' }, { id: 2 }, { id: 3 }]);
    expect(parseJsonl('')).toEqual([]);
    expect(parseJsonl(42 as any)).toEqual([]);
  });

  test('toJsonl: one JSON line each, newline-joined, no trailing newline; non-array → ""', () => {
    expect(toJsonl([{ id: 1 }, { id: 2 }])).toBe('{"id":1}\n{"id":2}');
    expect(toJsonl([])).toBe('');
    expect(toJsonl('nope' as any)).toBe('');
  });

  test('parseJsonl ∘ toJsonl round-trips an object array (and tolerates a trailing newline)', () => {
    const rows = [{ id: 'a', amount: 12.5 }, { id: 'b', amount: 7 }];
    expect(parseJsonl(toJsonl(rows))).toEqual(rows);
    expect(parseJsonl(toJsonl(rows) + '\n')).toEqual(rows);
  });

  test('dedupeBy keeps the FIRST occurrence per key (idempotent append-merge)', () => {
    const existing = [{ id: 'o1', total: 10 }, { id: 'o2', total: 20 }];
    const fresh = [{ id: 'o2', total: 999 }, { id: 'o3', total: 30 }]; // o2 re-harvested
    const merged = dedupeBy([...existing, ...fresh], 'id');
    expect(merged.map((r: any) => r.id)).toEqual(['o1', 'o2', 'o3']);              // stable order
    expect((merged.find((r: any) => r.id === 'o2') as any).total).toBe(20);        // existing wins
    expect(dedupeBy(merged, 'id')).toEqual(merged);                                 // idempotent
    expect(dedupeBy([{ d: '25-01' }, { d: '25-01' }, { d: '25-02' }], (r: any) => r.d).length).toBe(2);
    expect(dedupeBy('nope' as any, 'id')).toEqual([]);
  });
});

describe('peerd:std number theory (exact BigInt)', () => {
  test('gcd / lcm are non-negative and accept Number/string/BigInt', () => {
    expect(gcd(12, 18)).toBe(6n);
    expect(gcd(-12n, 18n)).toBe(6n);
    expect(gcd('100', '75')).toBe(25n);
    expect(lcm(4, 6)).toBe(12n);
    expect(lcm(0n, 5n)).toBe(0n);
  });

  test('factorial is exact past the float ceiling', () => {
    expect(factorial(5)).toBe(120n);
    expect(factorial(0)).toBe(1n);
    expect(factorial(25)).toBe(15511210043330985984000000n); // float would have rounded
    expect(() => factorial(-1)).toThrow(/negative/);
  });

  test('modpow never materializes the full power', () => {
    expect(modpow(2, 10, 1000)).toBe(24n);  // 1024 mod 1000
    expect(modpow(7, 256, 13)).toBe(9n);
    expect(modpow(5, 0, 7)).toBe(1n);
    expect(() => modpow(2, 3, 0)).toThrow(/modulus/);
    expect(() => modpow(2, -1, 5)).toThrow(/negative exponent/);
  });
});
