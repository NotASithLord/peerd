import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDeepmergeException } from '../../packaging/check-deepmerge-exception.mjs';
const lock = readFileSync(new URL('../../bun.lock', import.meta.url), 'utf8');
const config = '[[IgnoredVulns]]\nid = "GHSA-gcqx-w48m-w2h4"\nignoreUntil = 2026-11-11T00:00:00Z\n';
const now = Date.parse('2026-10-28T00:00:00Z');
let root: string;
const put = (name: string, text: string) => writeFileSync(join(root, name), text);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deepmerge-scope-'));
  for (const name of ['extension', 'packaging', 'scripts', '.github']) mkdirSync(join(root, name));
  put('package.json', '{}'); put('bun.lock', lock); put('osv-scanner.toml', config);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
test('reviewed scope expires and removal is allowed', () => {
  expect(() => checkDeepmergeException(root, now)).not.toThrow();
  expect(() => checkDeepmergeException(root, Date.parse('2026-11-11'))).toThrow('expired');
  put('osv-scanner.toml', '');
  expect(() => checkDeepmergeException(root, Date.parse('2026-11-12'))).not.toThrow();
});
test('expiry extension requires review', () => {
  put('osv-scanner.toml', config.replace('2026-11-11', '2026-11-12'));
  expect(() => checkDeepmergeException(root, now)).toThrow('expiry changed');
});
test('version and integrity changes require review', () => {
  for (const changed of [lock.replace('deepmerge@4.3.1', 'deepmerge@4.3.2'),
    lock.replace('sha512-3sUqbMEc77X', 'sha512-TAMPERED77X'),
    lock.replace('addons-linter@10.10.0', 'addons-linter@10.11.0')]) {
    put('bun.lock', changed);
    expect(() => checkDeepmergeException(root, now)).toThrow('changed');
  }
});
test('new consumer cannot inherit waiver', () => {
  put('bun.lock', lock.replace('"@devicefarmer/adbkit": "3.3.9"', '"@devicefarmer/adbkit": "3.3.9", "deepmerge": "4.3.1"'));
  expect(() => checkDeepmergeException(root, now)).toThrow('New deepmerge consumer');
});
test('direct dependencies and patches require review', () => {
  for (const field of ['dependencies', 'overrides', 'patchedDependencies']) {
    put('package.json', JSON.stringify({ [field]: { deepmerge: '4.3.1' } }));
    expect(() => checkDeepmergeException(root, now)).toThrow('Direct schema-merge');
  }
});
test('custom schemas and programmatic use require review', () => {
  for (const text of ['import merge from "deepmerge";', 'lint({ schemaObject: input })',
    'require("addons-linter")', 'options.themeSchemaObject = input']) {
    put('scripts/new.mjs', text);
    expect(() => checkDeepmergeException(root, now)).toThrow('Potential custom schema');
  }
});
