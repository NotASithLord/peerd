import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addSecurityChangelog,
  assertAtLeastDaysOld,
  assertRecentUtcDate,
  nextPatchVersion,
  parseDependencyNames,
  validateActionsDiff,
  validatePackageJsonChange,
  validatePrepared,
} from '../packaging/dependabot-security.ts';

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const write = (root: string, path: string, value: string): void => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), value);
};

const git = (root: string, ...args: string[]): string =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

describe('Dependabot security automation policy', () => {
  test('accepts authenticated dependency-version-only package changes', () => {
    const base = JSON.stringify({
      name: 'peerd',
      version: '0.5.0',
      devDependencies: { eslint: '10.4.0', typescript: '^6.0.3' },
    });
    const head = JSON.stringify({
      name: 'peerd',
      version: '0.5.0',
      devDependencies: { eslint: '10.4.1', typescript: '^6.0.3' },
    });
    expect(validatePackageJsonChange(base, head, ['eslint'])).toEqual(['eslint']);
  });

  test('rejects package scripts hidden in a dependency update', () => {
    const base = JSON.stringify({ name: 'peerd', scripts: { test: 'bun test' }, devDependencies: { eslint: '10.4.0' } });
    const head = JSON.stringify({ name: 'peerd', scripts: { test: 'curl bad.test' }, devDependencies: { eslint: '10.4.1' } });
    expect(() => validatePackageJsonChange(base, head, ['eslint'])).toThrow('outside dependency version maps');
  });

  test('rejects a second unauthenticated dependency change', () => {
    const base = JSON.stringify({ devDependencies: { eslint: '10.4.0', typescript: '6.0.2' } });
    const head = JSON.stringify({ devDependencies: { eslint: '10.4.1', typescript: '6.0.3' } });
    expect(() => validatePackageJsonChange(base, head, ['eslint'])).toThrow('unauthenticated dependency typescript');
  });

  test('binds a manifest change to the authenticated replacement version', () => {
    const base = JSON.stringify({ devDependencies: { eslint: '^10.4.0' } });
    const head = JSON.stringify({ devDependencies: { eslint: '^10.4.1' } });
    expect(validatePackageJsonChange(base, head, ['eslint'], { eslint: '10.4.1' }))
      .toEqual(['eslint']);
    expect(() => validatePackageJsonChange(base, head, ['eslint'], { eslint: '10.4.2' }))
      .toThrow('does not match authenticated version 10.4.2');
  });

  test('accepts only one-for-one SHA-pinned Actions replacements', () => {
    const diff = [
      'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
      '--- a/.github/workflows/ci.yml',
      '+++ b/.github/workflows/ci.yml',
      '@@ -4 +4 @@ jobs:',
      '-      - uses: actions/checkout@1111111111111111111111111111111111111111 # v7.0.0',
      '+      - uses: actions/checkout@2222222222222222222222222222222222222222 # v7.0.1',
    ].join('\n');
    expect(validateActionsDiff(diff)).toBe(1);
  });

  test('rejects mutable action tags and unrelated workflow edits', () => {
    const mutable = [
      'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
      '--- a/.github/workflows/ci.yml',
      '+++ b/.github/workflows/ci.yml',
      '@@ -4 +4 @@',
      '-      - uses: actions/checkout@1111111111111111111111111111111111111111 # v7.0.0',
      '+      - uses: actions/checkout@v7',
    ].join('\n');
    expect(() => validateActionsDiff(mutable)).toThrow('SHA-pinned uses: line');
  });

  test('rejects swapping the authenticated Action target or subpath', () => {
    const swapped = [
      'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
      '--- a/.github/workflows/ci.yml',
      '+++ b/.github/workflows/ci.yml',
      '@@ -4 +4 @@',
      '-      - uses: actions/checkout/subpath@1111111111111111111111111111111111111111 # v7.0.0',
      '+      - uses: actions/checkout/other@2222222222222222222222222222222222222222 # v7.0.1',
    ].join('\n');
    expect(() => validateActionsDiff(swapped)).toThrow('one-for-one immutable SHA replacement');
  });

  test('rejects relocating an authenticated Action into another workflow', () => {
    const relocated = [
      'diff --git a/.github/workflows/read.yml b/.github/workflows/read.yml',
      '--- a/.github/workflows/read.yml',
      '+++ b/.github/workflows/read.yml',
      '@@ -4 +3,0 @@',
      '-      - uses: actions/checkout@1111111111111111111111111111111111111111 # v7.0.0',
      'diff --git a/.github/workflows/write.yml b/.github/workflows/write.yml',
      '--- a/.github/workflows/write.yml',
      '+++ b/.github/workflows/write.yml',
      '@@ -9,0 +10 @@',
      '+      - uses: actions/checkout@2222222222222222222222222222222222222222 # v7.0.1',
    ].join('\n');
    expect(() => validateActionsDiff(relocated)).toThrow('relocated a uses: line');
  });

  test('rejects reordering authenticated Actions inside one diff hunk', () => {
    const reordered = [
      'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
      '--- a/.github/workflows/ci.yml',
      '+++ b/.github/workflows/ci.yml',
      '@@ -4,2 +4,2 @@',
      '-      - uses: actions/checkout@1111111111111111111111111111111111111111 # v7.0.0',
      '-      - uses: oven-sh/setup-bun@2222222222222222222222222222222222222222 # v2.1.9',
      '+      - uses: oven-sh/setup-bun@3333333333333333333333333333333333333333 # v2.2.0',
      '+      - uses: actions/checkout@4444444444444444444444444444444444444444 # v7.0.1',
    ].join('\n');
    expect(() => validateActionsDiff(reordered)).toThrow('one-for-one immutable SHA replacement');
  });

  test('normalizes names and creates a patch release changelog section', () => {
    const dependencies = parseDependencyNames('typescript, eslint,typescript');
    expect(dependencies).toEqual(['eslint', 'typescript']);
    expect(nextPatchVersion('0.5.9')).toBe('0.5.10');
    const next = addSecurityChangelog(
      '# Changelog\n\n## [Unreleased]\n\n## [0.5.0] - 2026-08-06\n',
      '0.5.1',
      '2026-08-10',
      dependencies,
      42,
    );
    expect(next).toContain('## [0.5.1] - 2026-08-10');
    expect(next).toContain('`eslint`, `typescript`');
    expect(next).toContain('security PR #42');
  });

  test('requires the replacement release itself to finish seasoning', () => {
    const now = new Date('2026-08-10T12:00:00Z');
    expect(assertAtLeastDaysOld('2026-07-11T11:59:59Z', 30, now)).toBe(30);
    expect(() => assertAtLeastDaysOld('2026-07-12T12:00:00Z', 30, now))
      .toThrow('29 days ago; 30 days of seasoning are required');
  });

  test('accepts only the exact generated patch on a fresh privileged runner', () => {
    const root = mkdtempSync(join(tmpdir(), 'peerd-dependabot-policy-'));
    const today = new Date().toISOString().slice(0, 10);
    const source = 'CodeMirror source\n';
    const bundle = 'export const cm = true;\n';
    const lock = {
      '//': 'test fixture',
      files: {
        'codemirror/SOURCE.txt': sha256(source),
        'codemirror/cm.js': sha256(bundle),
      },
    };
    try {
      write(root, 'package.json', `${JSON.stringify({
        name: 'peerd',
        version: '0.5.0',
        devDependencies: { eslint: '1.0.0' },
      }, null, 2)}\n`);
      write(root, 'bun.lock', 'lock-v1\n');
      write(root, 'CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n');
      write(root, 'extension/manifest.json', `${JSON.stringify({
        manifest_version: 3,
        version: '0.5.0',
        name: 'peerd',
      }, null, 2)}\n`);
      write(root, 'extension/vendor/codemirror/SOURCE.txt', source);
      write(root, 'extension/vendor/codemirror/cm.js', bundle);
      write(root, 'extension/vendor/vendor.lock.json', `${JSON.stringify(lock, null, 2)}\n`);
      git(root, 'init', '-q');
      git(root, 'config', 'user.name', 'test');
      git(root, 'config', 'user.email', 'test@example.invalid');
      git(root, 'add', '--all');
      git(root, 'commit', '-qm', 'base');
      const baseSha = git(root, 'rev-parse', 'HEAD');

      write(root, 'package.json', `${JSON.stringify({
        name: 'peerd',
        version: '0.5.0',
        devDependencies: { eslint: '1.0.1' },
      }, null, 2)}\n`);
      write(root, 'bun.lock', 'lock-v2\n');
      git(root, 'add', '--all');
      git(root, 'commit', '-qm', 'dependabot patch');
      const headSha = git(root, 'rev-parse', 'HEAD');

      write(root, 'package.json', `${JSON.stringify({
        name: 'peerd',
        version: '0.5.1',
        devDependencies: { eslint: '1.0.1' },
      }, null, 2)}\n`);
      write(root, 'CHANGELOG.md', addSecurityChangelog(
        '# Changelog\n\n## [Unreleased]\n',
        '0.5.1',
        today,
        ['eslint'],
        42,
      ));
      write(root, 'extension/manifest.json', `${JSON.stringify({
        manifest_version: 3,
        version: '0.5.1',
        name: 'peerd',
      }, null, 2)}\n`);

      const values = {
        repo: root,
        'base-sha': baseSha,
        'head-sha': headSha,
        ecosystem: 'bun',
        dependencies: 'eslint',
        pr: '42',
        date: today,
      };
      expect(() => validatePrepared(values)).not.toThrow();

      lock.files['codemirror/cm.js'] = '0'.repeat(64);
      write(root, 'extension/vendor/vendor.lock.json', `${JSON.stringify(lock, null, 2)}\n`);
      expect(() => validatePrepared(values)).toThrow('vendor lock changed beyond');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('prepared release dates tolerate only the UTC midnight handoff', () => {
    const now = new Date('2026-08-10T00:00:01Z');
    expect(() => assertRecentUtcDate('2026-08-10', now)).not.toThrow();
    expect(() => assertRecentUtcDate('2026-08-09', now)).not.toThrow();
    expect(() => assertRecentUtcDate('2026-08-08', now)).toThrow('current UTC date');
  });
});
