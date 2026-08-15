import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  actionsPinnedBadge, buildStepBadge, countVendorLockedFiles,
  scanActionPins, scanBuildStep, vendorIntegrityBadge,
} from '../../packaging/supply-chain.ts';
import { readWorkflows } from '../../packaging/gen-supply-chain-badges.ts';
import { REPO_ROOT } from '../../packaging/lib.ts';

const SHA = 'bf7454d06d71f1098171f2acdf0cd4708d7b5920';

describe('action pin scanning', () => {
  test('reads a full-SHA pin with its version comment as pinned', () => {
    const scan = scanActionPins([{
      file: 'ci.yml',
      text: `jobs:\n  a:\n    steps:\n      - uses: step-security/harden-runner@${SHA} # v2.20.0\n`,
    }]);
    expect(scan.unpinned).toEqual([]);
    expect(scan.actions).toEqual([{ action: 'step-security/harden-runner', pinned: true }]);
  });

  test('flags a moved-tag ref with file and line', () => {
    const scan = scanActionPins([{
      file: 'ci.yml',
      text: 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v5\n',
    }]);
    expect(scan.unpinned).toHaveLength(1);
    expect(scan.unpinned[0]).toMatchObject({ file: 'ci.yml', line: 4, uses: 'actions/checkout@v5' });
  });

  test('one unpinned use taints the action even when another use is pinned', () => {
    // The mutable ref is reachable, so the action does not count as pinned.
    const scan = scanActionPins([
      { file: 'a.yml', text: `      - uses: actions/checkout@${SHA} # v7.0.1\n` },
      { file: 'b.yml', text: '      - uses: actions/checkout@v7\n' },
    ]);
    expect(scan.actions).toEqual([{ action: 'actions/checkout', pinned: false }]);
    expect(actionsPinnedBadge(scan).color).toBe('red');
  });

  test('skips local composite actions and docker refs', () => {
    // A relative path is this repo's own reviewed code; no upstream ref to move.
    const scan = scanActionPins([{
      file: 'ci.yml',
      text: '      - uses: ./.github/actions/setup\n      - uses: docker://alpine:3\n',
    }]);
    expect(scan.uses).toEqual([]);
  });

  test('keeps a subpath action under its own name', () => {
    const scan = scanActionPins([{
      file: 'security.yml',
      text: `      - uses: github/codeql-action/init@${SHA} # v4\n`,
    }]);
    expect(scan.actions[0]?.action).toBe('github/codeql-action/init');
  });

  test('refuses to render a badge for an empty action inventory', () => {
    expect(() => actionsPinnedBadge(scanActionPins([{ file: 'x.yml', text: 'jobs: {}\n' }])))
      .toThrow(/no third-party actions/);
  });
});

describe('vendor lock count', () => {
  test('counts the pinned files', () => {
    expect(countVendorLockedFiles({ files: { 'a/LICENSE': 'aa', 'a/index.js': 'bb' } })).toBe(2);
    expect(vendorIntegrityBadge(2).message).toBe('2 files SHA-256 pinned');
  });

  test('refuses a lock with no files map or an empty one', () => {
    expect(() => countVendorLockedFiles({})).toThrow(/no "files" map/);
    expect(() => countVendorLockedFiles({ files: {} })).toThrow(/pins no files/);
  });
});

describe('no-build-step invariant', () => {
  const clean = { devDependencies: { eslint: '10', typescript: '6' }, scripts: { test: 'bun test' } };
  const tsconfig = '{ /* comment */ "compilerOptions": { "noEmit": true } }';

  test('reports none when nothing bundles, transpiles, emits, or builds', () => {
    expect(scanBuildStep(clean, tsconfig).offenders).toEqual([]);
    expect(buildStepBadge({ offenders: [] })).toMatchObject({
      label: 'Build step', message: 'none (vanilla JS)', color: 'brightgreen',
    });
  });

  test('catches a bundler or transpiler however it is scoped or prefixed', () => {
    for (const name of ['webpack', '@babel/core', 'vite', 'esbuild', '@swc/core', 'terser']) {
      const scan = scanBuildStep({ devDependencies: { [name]: '1' } }, tsconfig);
      expect(scan.offenders.join(' ')).toContain(name);
    }
  });

  test('catches a runtime dependency, which would ship npm code to a user', () => {
    // This invariant used to carry its own badge; the no-build scan owns it now.
    expect(scanBuildStep({ dependencies: { mithril: '2' } }, tsconfig).offenders.join(' '))
      .toMatch(/"mithril" is a RUNTIME dependency/);
    expect(scanBuildStep(clean, tsconfig).offenders).toEqual([]);
  });

  test('catches a build script and a tsconfig that could emit', () => {
    expect(scanBuildStep({ ...clean, scripts: { build: 'tsc' } }, tsconfig).offenders)
      .toContain('package.json declares a "build" script');
    expect(scanBuildStep(clean, '{ "compilerOptions": {} }').offenders.join(' '))
      .toMatch(/noEmit/);
  });

  test('goes red rather than quietly claiming none', () => {
    expect(buildStepBadge({ offenders: ['dependency "vite" is a bundler or transpiler'] }))
      .toMatchObject({ message: 'present', color: 'red' });
  });
});

describe('the live repo', () => {
  test('genuinely has no build step', () => {
    const scan = scanBuildStep(
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')),
      readFileSync(join(REPO_ROOT, 'tsconfig.json'), 'utf8'),
    );
    expect(scan.offenders).toEqual([]);
  });

  test('every third-party action in every workflow is pinned to a full SHA', () => {
    // The gate itself (check:actions) enforces this in CI and preflight; asserting
    // it here means a bad pin also fails the fast local suite.
    const scan = scanActionPins(readWorkflows());
    expect(scan.uses.length).toBeGreaterThan(0);
    expect(scan.unpinned.map((use) => `${use.file}:${use.line} ${use.uses}`)).toEqual([]);
  });
});
