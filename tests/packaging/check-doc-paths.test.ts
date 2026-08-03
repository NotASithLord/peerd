// The doc-path gate (packaging/check-doc-paths.ts) fails CI when a
// top-level doc references a repo path that no longer exists (the class of
// drift the 0.2.1 doc cut left behind). These tests pin the extraction
// heuristics and the resolution rules.

import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  extractPathRefs, resolutionRoots, resolvesInRepo, isCheckableRef,
  isGitignored, isRouteName, CHECKED_DOCS,
} from '../../packaging/check-doc-paths.ts';
import { REPO_ROOT } from '../../packaging/lib.ts';

describe('extractPathRefs', () => {
  test('markdown links, minus anchors and external URLs', () => {
    const refs = extractPathRefs(
      'See [a](docs/A.md), [b](CONTRIBUTING.md#setup), [c](#install), [d](https://x.test/y).',
    );
    expect(refs).toContain('docs/A.md');
    expect(refs).toContain('CONTRIBUTING.md');
    expect(refs).not.toContain('');
    expect(refs.some((r) => r.startsWith('http'))).toBe(false);
  });

  test('img src attributes', () => {
    expect(extractPathRefs('<img src="docs/store/assets/x.svg" width="1">'))
      .toContain('docs/store/assets/x.svg');
  });

  test('backticked paths, minus commands, globs, schemes, npm names', () => {
    const refs = extractPathRefs([
      'Read `peerd-egress/vault/` and `tools/exposure.js`.',
      'Run `bun run gen:dev` with `manifests/*.json` and `@xterm/xterm`.',
      'Open `chrome://extensions` and `wss://x.test/y`; see `<kind>-tab/`.',
    ].join('\n'));
    expect(refs).toContain('peerd-egress/vault/');
    expect(refs).toContain('tools/exposure.js');
    expect(refs.some((r) => r.includes('*') || r.includes('<'))).toBe(false);
    expect(refs.some((r) => r.startsWith('@') || r.includes('://'))).toBe(false);
    expect(refs).not.toContain('bun run gen:dev');
  });

  test('fenced code blocks are ignored', () => {
    const refs = extractPathRefs('```\n`docs/NOT-A-CLAIM.md`\n```\nand `docs/A.md`.');
    expect(refs).toContain('docs/A.md');
    expect(refs).not.toContain('docs/NOT-A-CLAIM.md');
  });
});

describe('resolution against the real repo', () => {
  const roots = resolutionRoots();

  test('repo-root, extension/ shorthand, and module shorthand all resolve', () => {
    expect(resolvesInRepo('packaging/lib.ts', roots)).toBe(true);
    expect(resolvesInRepo('peerd-egress/vault', roots)).toBe(true);      // extension/
    expect(resolvesInRepo('tools/exposure.js', roots)).toBe(true);       // peerd-runtime/
    expect(resolvesInRepo('docs/DOES-NOT-EXIST.md', roots)).toBe(false);
  });

  test('only plausible repo paths are checkable', () => {
    expect(isCheckableRef('peerd-runtime/nope.js', roots)).toBe(true);   // real module, drift if missing
    expect(isCheckableRef('UsefulSensors/moonshine', roots)).toBe(false); // HF id
    expect(isCheckableRef('/api/tags', roots)).toBe(false);              // URL path
  });

  test('gitignored output paths get a pass, trailing slash included', () => {
    expect(isGitignored('scripts/cdp/artifacts/')).toBe(true);
    expect(isGitignored('packaging/lib.ts')).toBe(false);
  });
});

describe('the real top-level docs', () => {
  // The live gate: every checked doc's path claims must resolve. This is
  // the same walk main() does, run at PR time via bun test as well.
  for (const doc of CHECKED_DOCS) {
    test(`${doc} has no dead path references`, () => {
      const p = join(REPO_ROOT, doc);
      if (!existsSync(p)) return;
      // Same resolution the checker uses: the doc's own directory is a root, so a
      // doc under docs/ can use ordinary sibling links.
      const roots = resolutionRoots(REPO_ROOT, dirname(p));
      const dead = extractPathRefs(readFileSync(p, 'utf8'))
        .filter((r) => !isRouteName(r))
        .filter((r) => isCheckableRef(r, roots))
        .filter((r) => !resolvesInRepo(r, roots) && !isGitignored(r));
      expect(dead).toEqual([]);
    });
  }
});
