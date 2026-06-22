// Drift guard for the in-browser test manifest.
//
// extension/tests/index.js is a HAND-MAINTAINED list of static imports —
// the in-browser framework collects suites by import side effect, so a
// test file missing from the manifest silently never runs (and an import
// of a deleted file breaks the whole runner at load time). This keeps
// the manifest and the filesystem in lockstep, both directions.
//
// why Bun and not the browser: this is pure values-in/values-out (a
// glob vs. a parsed import list) — exactly the kind of check CLAUDE.md
// routes to the Bun surface.

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { Glob } from 'bun';

const TESTS_DIR = join(import.meta.dir, '..', '..', 'extension', 'tests');

const onDisk = [...new Glob('unit/**/*.test.js').scanSync({ cwd: TESTS_DIR })]
  // normalize to the manifest's './unit/...' specifier form
  .map((p) => './' + p.split(sep).join('/'))
  .sort();

const manifestSource = readFileSync(join(TESTS_DIR, 'index.js'), 'utf8');
const imported = [...manifestSource.matchAll(/^\s*import\s+['"](\.\/unit\/[^'"]+\.test\.js)['"]/gm)]
  .map((m) => m[1])
  .sort();

describe('extension/tests/index.js — in-browser test manifest', () => {
  it('finds test files on disk (sanity: glob is not silently empty)', () => {
    expect(onDisk.length).toBeGreaterThan(0);
  });

  it('imports every unit/**/*.test.js that exists on disk', () => {
    const missing = onDisk.filter((f) => !imported.includes(f));
    // a file listed here exists but is never imported → its tests never run
    expect(missing).toEqual([]);
  });

  it('imports no test files that are missing on disk', () => {
    const stale = imported.filter((f) => !onDisk.includes(f));
    // a file listed here is imported but deleted → runner dies at load
    expect(stale).toEqual([]);
  });

  it('has no duplicate imports', () => {
    expect(new Set(imported).size).toBe(imported.length);
  });
});
