import { describe, test, expect } from 'bun:test';
import { score, filterCandidates } from '../../../extension/peerd-runtime/composer/palette-filter.js';

describe('score', () => {
  test('empty query matches everything with a flat score', () => {
    expect(score('', 'anything')).toBe(1);
  });
  test('subsequence match succeeds; non-subsequence fails', () => {
    expect(score('rvw', 'review')).toBeGreaterThan(-Infinity);
    expect(score('qd', 'query-dom')).toBeGreaterThan(-Infinity);
    expect(score('zzz', 'review')).toBe(-Infinity);
  });
  test('exact prefix outscores a scattered subsequence', () => {
    expect(score('rev', 'review')).toBeGreaterThan(score('rev', 'retrieve'));
  });
  test('query longer than label cannot match', () => {
    expect(score('reviewing', 'review')).toBe(-Infinity);
  });
});

describe('filterCandidates', () => {
  const cands = [
    { id: 'review', label: 'review' },
    { id: 'preview', label: 'preview' },
    { id: 'run-tests', label: 'run-tests' },
    { id: 'deploy', label: 'deploy' },
  ];

  test('filters out non-matches', () => {
    const out = filterCandidates(cands, 'rev');
    const ids = out.map((c) => c.id);
    expect(ids).toContain('review');
    expect(ids).toContain('preview'); // 'rev' is a subsequence of p-r-e-v-iew
    expect(ids).not.toContain('deploy');
  });

  test('ranks the exact-prefix match first', () => {
    const out = filterCandidates(cands, 'rev');
    expect(out[0].id).toBe('review');
  });

  test('word-boundary fuzzy: "rt" matches "run-tests" via the hyphen seam', () => {
    const out = filterCandidates(cands, 'rt');
    expect(out.map((c) => c.id)).toContain('run-tests');
  });

  test('empty query returns all in stable input order', () => {
    const out = filterCandidates(cands, '');
    expect(out.map((c) => c.id)).toEqual(['review', 'preview', 'run-tests', 'deploy']);
  });

  test('respects the limit', () => {
    expect(filterCandidates(cands, '', 2)).toHaveLength(2);
  });
});
