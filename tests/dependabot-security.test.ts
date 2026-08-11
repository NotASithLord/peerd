import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addSecurityChangelog,
  assertAtLeastDaysOld,
  assertMalwareObservationWindow,
  assertNoGitHubMalwareAdvisories,
  assertRecentUtcDate,
  assertTrustedSocketScanner,
  changedBunLockPackages,
  minimumSecurityAgeDays,
  nextPatchVersion,
  parseDependencyNames,
  validateActionsDiff,
  validatePackageJsonChange,
  validatePrepared,
  verifyNoGitHubNpmMalware,
  verifyNpmSeasoning,
} from '../packaging/dependabot-security.ts';

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const write = (root: string, path: string, value: string): void => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), value);
};

const git = (root: string, ...args: string[]): string =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

const bunLock = (packages: Record<string, unknown>): string => JSON.stringify({
  lockfileVersion: 1,
  configVersion: 1,
  workspaces: { '': { devDependencies: {} } },
  packages,
});

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
    expect(minimumSecurityAgeDays('bun')).toBe(3);
    expect(minimumSecurityAgeDays('github_actions')).toBe(30);
    expect(assertAtLeastDaysOld('2026-08-07T11:59:59Z', 3, now)).toBe(3);
    expect(() => assertAtLeastDaysOld('2026-08-08T12:00:00Z', 3, now))
      .toThrow('2 days ago; 3 days of seasoning are required');
  });

  test('permanently rejects active or withdrawn GitHub malware matches', () => {
    expect(() => assertNoGitHubMalwareAdvisories([], 'eslint@10.4.1', false)).not.toThrow();
    expect(() => assertNoGitHubMalwareAdvisories({}, 'eslint@10.4.1', false))
      .toThrow('GitHub malware lookup for eslint@10.4.1 returned invalid JSON');
    expect(() => assertNoGitHubMalwareAdvisories(
      [{ ghsa_id: 'GHSA-1111-2222-3333', withdrawn_at: null }],
      'eslint@10.4.1',
      false,
    )).toThrow('active GitHub malware advisory GHSA-1111-2222-3333');
    expect(() => assertNoGitHubMalwareAdvisories(
      [{ ghsa_id: 'GHSA-4444-5555-6666', withdrawn_at: '2026-08-09T00:00:00Z' }],
      'eslint@10.4.1',
      true,
    )).toThrow('withdrawn GitHub malware advisory GHSA-4444-5555-6666');
  });

  test('checks the active and withdrawn advisory request path for scoped packages', async () => {
    const urls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json([]);
    }) as typeof fetch;
    await verifyNoGitHubNpmMalware([
      { dependencyName: '@scope/widget', newVersion: '1.2.4' },
    ], 'test-token', fetcher);
    expect(urls).toHaveLength(2);
    const queries = urls.map((url) => new URL(url).searchParams);
    expect(queries.map((query) => query.get('type'))).toEqual(['malware', 'malware']);
    expect(queries.map((query) => query.get('ecosystem'))).toEqual(['npm', 'npm']);
    expect(queries.map((query) => query.get('affects'))).toEqual([
      '@scope/widget@1.2.4',
      '@scope/widget@1.2.4',
    ]);
    expect(queries.map((query) => query.get('is_withdrawn'))).toEqual(['false', 'true']);
  });

  test('fails closed on advisory HTTP and response-shape errors', async () => {
    const unavailable = (async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch;
    await expect(verifyNoGitHubNpmMalware([
      { dependencyName: 'eslint', newVersion: '10.4.1' },
    ], undefined, unavailable)).rejects.toThrow('returned HTTP 503');

    const malformed = (async () => Response.json({ advisories: [] })) as unknown as typeof fetch;
    await expect(verifyNoGitHubNpmMalware([
      { dependencyName: 'eslint', newVersion: '10.4.1' },
    ], undefined, malformed)).rejects.toThrow('returned invalid JSON');
  });

  test('applies patch-only policy to every resolved Bun lockfile replacement', () => {
    const base = bunLock({
      eslint: ['eslint@10.4.0', '', {}, 'sha512-AAAA'],
      transitive: ['transitive@2.7.3', '', {}, 'sha512-BBBB'],
    });
    const head = bunLock({
      eslint: ['eslint@10.4.1', '', {}, 'sha512-CCCC'],
      transitive: ['transitive@2.7.4', '', {}, 'sha512-DDDD'],
    });
    expect(changedBunLockPackages(base, head)).toEqual([
      {
        lockKey: 'eslint',
        dependencyName: 'eslint',
        previousVersion: '10.4.0',
        newVersion: '10.4.1',
        integrity: 'sha512-CCCC',
      },
      {
        lockKey: 'transitive',
        dependencyName: 'transitive',
        previousVersion: '2.7.3',
        newVersion: '2.7.4',
        integrity: 'sha512-DDDD',
      },
    ]);

    expect(() => changedBunLockPackages(base, bunLock({
      eslint: ['eslint@10.4.1', '', {}, 'sha512-CCCC'],
      transitive: ['transitive@3.0.0', '', {}, 'sha512-DDDD'],
    }))).toThrow('is not a semantic patch update');
    expect(() => changedBunLockPackages(base, bunLock({
      eslint: ['eslint@10.4.1', '', {}, 'sha512-CCCC'],
      transitive: ['transitive@2.7.3', '', {}, 'sha512-EEEE'],
    }))).toThrow('without a version replacement');
    expect(() => changedBunLockPackages(base, bunLock({
      eslint: ['eslint@10.4.1', '', {}, 'sha512-CCCC'],
      transitive: ['transitive@2.7.3', '', {}, 'sha512-BBBB'],
      surprise: ['surprise@1.0.0', '', {}, 'sha512-FFFF'],
    }))).toThrow('introduced new dependency slot surprise');
  });

  test('binds every changed lockfile integrity to exact npm registry metadata', async () => {
    const requested: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      const dependencyName = decodeURIComponent(new URL(url).pathname.slice(1));
      const version = dependencyName === 'eslint' ? '10.4.1' : '2.7.4';
      const integrity = dependencyName === 'eslint' ? 'sha512-CCCC' : 'sha512-DDDD';
      return Response.json({
        time: { [version]: '2026-08-01T00:00:00Z' },
        versions: { [version]: { dist: { integrity } } },
      });
    }) as typeof fetch;
    const replacements = [
      { dependencyName: 'eslint', newVersion: '10.4.1', integrity: 'sha512-CCCC' },
      { dependencyName: 'transitive', newVersion: '2.7.4', integrity: 'sha512-DDDD' },
    ];
    await expect(verifyNpmSeasoning(replacements, undefined, fetcher)).resolves.toBeUndefined();
    expect(requested).toHaveLength(2);
    await expect(verifyNpmSeasoning([
      { dependencyName: 'eslint', newVersion: '10.4.1', integrity: 'sha512-WRONG' },
    ], undefined, fetcher)).rejects.toThrow('does not match the npm registry');
  });

  test('does not allow the Socket scanner to approve its own three-day update', () => {
    expect(() => assertTrustedSocketScanner([
      { dependencyName: '@socketsecurity/bun-security-scanner' },
    ])).toThrow('scanner cannot approve itself');
    expect(() => assertTrustedSocketScanner([
      { dependencyName: 'eslint' },
    ])).not.toThrow();
  });

  test('requires a continuous, fresh 72-hour malware observation window', () => {
    const headSha = 'a'.repeat(40);
    const start = new Date('2026-08-07T12:00:00Z');
    const observation = (hour: number, conclusion = 'success') => ({
      headSha,
      conclusion,
      completedAt: new Date(start.getTime() + hour * 3_600_000).toISOString(),
    });
    const clean = Array.from({ length: 19 }, (_, index) => observation(index * 4));
    const now = new Date(start.getTime() + 72 * 3_600_000);
    expect(assertMalwareObservationWindow(clean, headSha, 72, 6, now)).toBe(72);

    const withFinding = clean.map((entry, index) => index === 10
      ? { ...entry, conclusion: 'failure' }
      : entry);
    expect(() => assertMalwareObservationWindow(withFinding, headSha, 72, 6, now))
      .toThrow('only 28 continuous clean observation hours');

    const missed = clean.filter((_, index) => index !== 10 && index !== 11);
    expect(() => assertMalwareObservationWindow(missed, headSha, 72, 6, now))
      .toThrow('only 24 continuous clean observation hours');
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
