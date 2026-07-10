import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The puzzle-race RULES MODULE is dwapp content (a plain, dependency-free
// script whose last binding is `const rules`) executed in the sealed worker.
// Load it here exactly the way the arena's worker wrapper does: source text +
// an appended `return rules`.
const source = readFileSync(join(import.meta.dir, '../../web/public/web/games/puzzle-race.js'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const rules = new Function(`${source}\nreturn rules;`)() as {
  meta: { id: string, name: string, version: number },
  derive: (seed: string) => { kind: string, prompt: string } & Record<string, any>,
  check: (seed: string, answer: string) => { correct: boolean, score: number },
  solve: (ch: Record<string, any>) => string | null,
};

// A couple of fixed 64-hex seeds (what combineSeed emits).
const SEED_A = 'aa11bb22cc33dd44ee55ff660718293a4b5c6d7e8f90a1b2c3d4e5f607182931';
const SEED_B = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('puzzle-race rules module', () => {
  test('is a plain script: no imports/exports, defines rules with the boilerplate surface', () => {
    expect(source).not.toMatch(/^\s*(import|export)\s/m);
    expect(rules.meta.id).toBe('puzzle-race');
    expect(typeof rules.derive).toBe('function');
    expect(typeof rules.check).toBe('function');
    expect(typeof rules.solve).toBe('function');
  });

  test('derive is deterministic: same seed → byte-identical puzzle; different seed → different puzzle', () => {
    const p1 = rules.derive(SEED_A);
    const p2 = rules.derive(SEED_A);
    expect(JSON.stringify(p1)).toBe(JSON.stringify(p2));
    expect(JSON.stringify(rules.derive(SEED_B))).not.toBe(JSON.stringify(p1));
    expect(p1.prompt.length).toBeGreaterThan(20);
  });

  test('the reference solver produces an answer check accepts, on both puzzle kinds', () => {
    // sweep seeds until both kinds have been exercised
    const seen = new Set<string>();
    for (let i = 0; i < 40 && seen.size < 2; i++) {
      const seed = i.toString(16).padStart(8, '0') + SEED_A.slice(8);
      const ch = rules.derive(seed);
      if (seen.has(ch.kind)) continue;
      const answer = rules.solve(ch);
      if (answer == null) continue; // an unlucky pow tail is legal (timeout in play)
      seen.add(ch.kind);
      expect(rules.check(seed, answer)).toEqual({ correct: true, score: 1 });
    }
    expect([...seen].sort()).toEqual(['chain', 'pow']);
  }, 30_000);

  test('check rejects wrong answers and garbage without throwing', () => {
    expect(rules.check(SEED_A, 'not-a-number').correct).toBe(false);
    expect(rules.check(SEED_A, '-1').correct).toBe(false);
    expect(rules.check(SEED_A, '3.14').correct).toBe(false);
    expect(rules.check(SEED_A, String(Number.MAX_SAFE_INTEGER)).correct).toBe(false);
  });

  test('check is pure re-derivation: verdicts agree across independent loads (two "machines")', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const rules2 = new Function(`${source}\nreturn rules;`)() as typeof rules;
    const ch = rules.derive(SEED_B);
    const answer = rules.solve(ch);
    if (answer != null) {
      expect(rules2.check(SEED_B, answer)).toEqual(rules.check(SEED_B, answer));
    }
    expect(rules2.check(SEED_B, '12345')).toEqual(rules.check(SEED_B, '12345'));
  }, 30_000);
});
