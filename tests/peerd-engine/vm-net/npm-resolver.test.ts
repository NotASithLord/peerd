import { describe, test, expect } from 'bun:test';
import {
  parseVersion, compareVersions, satisfies, maxSatisfying,
  resolveVersion, parseSpec, resolveTree,
} from '../../../extension/peerd-engine/vm-net/npm-resolver.js';

describe('version parsing + compare', () => {
  test('parses and orders', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3, '']);
    expect(parseVersion('v2.0.0-beta.1')?.[3]).toBe('beta.1');
    expect(compareVersions('1.2.3', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0-rc.1')).toBe(1); // release > prerelease
  });
});

describe('satisfies', () => {
  test('caret', () => {
    expect(satisfies('1.4.2', '^1.2.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfies('0.4.0', '^0.3.0')).toBe(false); // ^0.x locks minor
    expect(satisfies('0.3.9', '^0.3.0')).toBe(true);
  });
  test('tilde', () => {
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
  });
  test('comparators, AND, OR', () => {
    expect(satisfies('1.5.0', '>=1.2.0 <2.0.0')).toBe(true);
    expect(satisfies('2.5.0', '>=1.2.0 <2.0.0')).toBe(false);
    expect(satisfies('3.0.0', '^1.0.0 || ^3.0.0')).toBe(true);
  });
  test('x-ranges and wildcards', () => {
    expect(satisfies('1.9.9', '1.x')).toBe(true);
    expect(satisfies('2.0.0', '1.x')).toBe(false);
    expect(satisfies('5.5.5', '*')).toBe(true);
    expect(satisfies('1.2.3', '')).toBe(true);
  });
  test('does not match prerelease for plain ranges', () => {
    expect(satisfies('1.2.0-beta', '^1.0.0')).toBe(false);
    expect(satisfies('1.2.0-beta', '1.2.0-beta')).toBe(true); // exact prerelease ok
  });
});

describe('maxSatisfying / resolveVersion', () => {
  const doc = {
    'dist-tags': { latest: '2.1.0', next: '3.0.0-rc.1' },
    versions: { '1.0.0': {}, '1.5.0': {}, '2.0.0': {}, '2.1.0': {}, '3.0.0-rc.1': {} },
  };
  test('maxSatisfying picks the highest match', () => {
    expect(maxSatisfying(Object.keys(doc.versions), '^1.0.0')).toBe('1.5.0');
    expect(maxSatisfying(Object.keys(doc.versions), '>=1.0.0 <3.0.0')).toBe('2.1.0');
  });
  test('resolveVersion honors dist-tags, exact, ranges', () => {
    expect(resolveVersion(doc, 'latest')).toBe('2.1.0');
    expect(resolveVersion(doc, 'next')).toBe('3.0.0-rc.1');
    expect(resolveVersion(doc, '1.5.0')).toBe('1.5.0');
    expect(resolveVersion(doc, '^2.0.0')).toBe('2.1.0');
  });
});

describe('parseSpec', () => {
  test('plain, ranged, scoped', () => {
    expect(parseSpec('express')).toEqual({ name: 'express', range: 'latest' });
    expect(parseSpec('lodash@^4.17.0')).toEqual({ name: 'lodash', range: '^4.17.0' });
    expect(parseSpec('@scope/pkg@1.2.3')).toEqual({ name: '@scope/pkg', range: '1.2.3' });
    expect(parseSpec('@scope/pkg')).toEqual({ name: '@scope/pkg', range: 'latest' });
  });
});

describe('resolveTree', () => {
  const registry: Record<string, any> = {
    a: { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dist: { tarball: 'http://r/a.tgz' }, dependencies: { b: '^1.0.0', c: '~2.0.0' } } } },
    b: { 'dist-tags': { latest: '1.2.0' }, versions: { '1.1.0': { dist: { tarball: 'http://r/b110.tgz' }, dependencies: {} }, '1.2.0': { dist: { tarball: 'http://r/b120.tgz' }, dependencies: { c: '^2.0.0' } } } },
    c: { 'dist-tags': { latest: '2.0.5' }, versions: { '2.0.5': { dist: { tarball: 'http://r/c.tgz' }, dependencies: {} } } },
  };
  const getDoc = async (n: string) => registry[n];

  test('resolves a transitive runtime graph, deduped by name', async () => {
    const plan = await resolveTree(['a'], getDoc);
    const byName = Object.fromEntries(plan.map((p) => [p.name, p.version]));
    expect(byName).toEqual({ a: '1.0.0', b: '1.2.0', c: '2.0.5' });
    expect(plan.find((p) => p.name === 'a')?.tarball).toBe('http://r/a.tgz');
  });

  test('throws on a missing package', async () => {
    await expect(resolveTree(['nope'], getDoc)).rejects.toThrow(/not found/);
  });

  test('throws on an unsatisfiable range', async () => {
    await expect(resolveTree(['c@^9.0.0'], getDoc)).rejects.toThrow(/satisfies/);
  });
});
