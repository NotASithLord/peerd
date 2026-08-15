import { describe, expect, test } from 'bun:test';
import {
  actionsPinnedBadge, countRuntimeDependencies, countVendorLockedFiles,
  runtimeDepsBadge, scanActionPins, vendorIntegrityBadge,
} from '../../packaging/supply-chain.ts';
import { readWorkflows } from '../../packaging/gen-supply-chain-badges.ts';

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

describe('runtime dependency count', () => {
  test('reports zero when package.json declares no dependencies at all', () => {
    expect(countRuntimeDependencies({ devDependencies: { eslint: '1' } })).toBe(0);
    expect(runtimeDepsBadge(0)).toMatchObject({ message: '0', color: 'brightgreen' });
  });

  test('goes red at the first runtime dependency, not at some threshold', () => {
    expect(countRuntimeDependencies({ dependencies: { mithril: '2' } })).toBe(1);
    expect(runtimeDepsBadge(1).color).toBe('red');
  });

  test('refuses a malformed dependencies field', () => {
    expect(() => countRuntimeDependencies({ dependencies: 'nope' })).toThrow(/not an object/);
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

describe('the live repo', () => {
  test('every third-party action in every workflow is pinned to a full SHA', () => {
    // The gate itself (check:actions) enforces this in CI and preflight; asserting
    // it here means a bad pin also fails the fast local suite.
    const scan = scanActionPins(readWorkflows());
    expect(scan.uses.length).toBeGreaterThan(0);
    expect(scan.unpinned.map((use) => `${use.file}:${use.line} ${use.uses}`)).toEqual([]);
  });
});
