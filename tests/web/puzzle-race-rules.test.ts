import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The puzzle-race RULES MODULE (v2: the mining race) is dwapp content (a
// plain, dependency-free script whose last binding is `const rules`) executed
// in the sealed worker. Load it here exactly the way the arena's worker
// wrapper does: source text + an appended `return rules`.
const source = readFileSync(join(import.meta.dir, '../../web/public/web/games/puzzle-race.js'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const rules = new Function(`${source}\nreturn rules;`)() as {
  meta: { id: string, name: string, version: number },
  derive: (seed: string) => { kind: string, tag: string, range: number, prompt: string },
  check: (seed: string, answer: string) => { correct: boolean, score: number },
  solve: (ch: Record<string, any>, budgetMs: number, resumeFrom?: string | null) =>
    { answer: string, score: number, hash: number, tries: number } | null,
};

const SEED = 'aa11bb22cc33dd44ee55ff660718293a4b5c6d7e8f90a1b2c3d4e5f607182931';

describe('puzzle-race rules module (v2: mining race)', () => {
  test('is a plain script with the boilerplate surface', () => {
    expect(source).not.toMatch(/^\s*(import|export)\s/m);
    expect(rules.meta.id).toBe('puzzle-race');
    expect(rules.meta.version).toBe(2);
    expect(typeof rules.derive).toBe('function');
    expect(typeof rules.check).toBe('function');
    expect(typeof rules.solve).toBe('function');
  });

  test('derive is deterministic and seed-bound', () => {
    const p1 = rules.derive(SEED);
    expect(JSON.stringify(rules.derive(SEED))).toBe(JSON.stringify(p1));
    expect(rules.derive(SEED.replace('a', 'b')).tag).not.toBe(p1.tag);
    expect(p1.kind).toBe('mine');
    expect(p1.prompt.length).toBeGreaterThan(20);
  });

  test('the score is OBJECTIVE — recomputed from the answer, higher = lower hash', () => {
    const ch = rules.derive(SEED);
    const a = rules.check(SEED, '12345');
    const b = rules.check(SEED, '99999');
    expect(a.correct && b.correct).toBe(true);
    // score = 2^32 - fnv1a(tag:n): a strictly better (lower) hash scores higher
    expect(a.score).not.toBe(b.score);
    expect(a.score).toBeGreaterThan(0);
    expect(a.score).toBeLessThanOrEqual(2 ** 32);
    // and it is stable across independent loads (two "machines" must agree)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const rules2 = new Function(`${source}\nreturn rules;`)() as typeof rules;
    expect(rules2.check(SEED, '12345')).toEqual(a);
    void ch;
  });

  test('a solve burst returns a valid answer whose claimed score check() confirms', () => {
    const ch = rules.derive(SEED);
    const burst = rules.solve(ch, 150)!;
    expect(burst).not.toBeNull();
    expect(burst.tries).toBeGreaterThan(0);
    const verdict = rules.check(SEED, burst.answer);
    expect(verdict.correct).toBe(true);
    expect(verdict.score).toBe(burst.score);   // the claim IS re-derivable
  });

  test('resumeFrom never regresses the best answer', () => {
    const ch = rules.derive(SEED);
    const first = rules.solve(ch, 120)!;
    const resumed = rules.solve(ch, 60, first.answer)!;
    expect(resumed.score).toBeGreaterThanOrEqual(first.score);
  });

  test('check rejects garbage without throwing', () => {
    expect(rules.check(SEED, 'not-a-number').correct).toBe(false);
    expect(rules.check(SEED, '-1').correct).toBe(false);
    expect(rules.check(SEED, '3.14').correct).toBe(false);
    expect(rules.check(SEED, String(2 ** 41)).correct).toBe(false);   // out of range
    expect(rules.check(SEED, '').correct).toBe(false);
  });
});
