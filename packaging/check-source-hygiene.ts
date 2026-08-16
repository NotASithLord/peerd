// Source-hygiene gate — fails CI on two classes of defect that silently
// slipped into worktrees during the multi-agent batches and that NO other
// check catches:
//
//   1. A RAW NUL BYTE in a text-source file.
//      committed into a .ts/.js/etc makes git classify the file as BINARY —
//      it renders as `Bin`/`data` in the diff, so reviewers (and code-review
//      tooling) can't see it, and the byte reads as an invisible character at
//      runtime. Twice a separator was authored as a literal NUL byte instead
//      of a space; both passed typecheck+lint+tests and were caught only by a
//      reviewer running `file`. This gate makes that mechanical.
//
//   2. A TRACKED SYMLINK. A worktree convenience `ln -s … node_modules` got
//      committed (git mode 120000) pointing at an absolute machine path — it
//      dangles on every other clone and can shadow a real install. `.gitignore`
//      matches `node_modules/` (a directory) but NOT a symlink of the same
//      name, so nothing stopped it.
//
// Both are pure byte/mode facts, so the core is a pure function (tested in
// tests/packaging/source-hygiene.test.ts) and the shell just enumerates the
// git-tracked set.
//
// Run: bun run check:hygiene   (also part of `bun run preflight` + the CI lint job)

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib.ts';

// Extensions we treat as TEXT SOURCE and scan for control bytes. Anything not
// listed (png/ico/zip/xpi/wasm/woff/pdf/… — and extensionless files) is left
// alone: those are legitimately binary. Kept as an allowlist so a new binary
// asset type never trips the gate, while every real source file is covered.
export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'md', 'html', 'htm',
  'css', 'txt', 'yml', 'yaml', 'svg', 'xml', 'sh', 'mts', 'cts',
]);

/** The git ls-files mode for a symbolic link. */
export const SYMLINK_MODE = '120000';

/**
 * The offset of the first raw NUL (0x00) in `bytes`, or -1 if none. NUL is the
 * PRECISE trigger for git's binary detection — a file with a NUL renders as
 * `Bin`/`data` in every diff and is unreviewable. Other control bytes (ESC/US
 * used as intentional delimiters, etc.) do NOT make git binary and are left
 * alone: this gate targets the exact "unreviewable" harm, not code style. A
 * genuinely-needed NUL is written as a \\u0000 escape (same runtime value,
 * text-safe source) — which is the fix the failure message names. Pure.
 */
export const firstNulByte = (bytes: Uint8Array): { offset: number } | null => {
  const at = bytes.indexOf(0);
  return at === -1 ? null : { offset: at };
};

/** Is this path a text-source file we should scan (by extension)? Pure. */
export const isSourcePath = (path: string): boolean => {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return SOURCE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
};

/**
 * Classify one tracked entry. Pure: (mode, path, readBytes) -> violation|null.
 * `readBytes` is injected so the core stays IO-free and testable; the shell
 * passes a real reader. A symlink is flagged by MODE regardless of extension.
 */
export const classifyEntry = (
  mode: string,
  path: string,
  readBytes: (p: string) => Uint8Array,
): { path: string; kind: 'symlink' | 'nul-byte'; detail: string } | null => {
  if (mode === SYMLINK_MODE) {
    return { path, kind: 'symlink', detail: 'tracked symbolic link (dangles on other clones)' };
  }
  // vendor/ holds audited third-party code (incl. minified bundles that may
  // carry legitimate control bytes); it is reviewed at vendoring time, not here.
  if (!isSourcePath(path) || path.includes('/vendor/') || path.startsWith('vendor/')) return null;
  const hit = firstNulByte(readBytes(path));
  if (hit) {
    return {
      path, kind: 'nul-byte',
      detail: `raw NUL (0x00) at offset ${hit.offset} `
        + '(makes git treat the file as binary — write it as a \\u0000 escape instead)',
    };
  }
  return null;
};

/** Enumerate tracked (mode, path) pairs via `git ls-files -s`. */
export const trackedEntries = (root: string = REPO_ROOT): Array<{ mode: string; path: string }> => {
  const out = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  const entries: Array<{ mode: string; path: string }> = [];
  for (const rec of out.toString('utf8').split('\0')) {
    if (!rec) continue;
    // "<mode> <sha> <stage>\t<path>"
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const mode = rec.slice(0, rec.indexOf(' '));
    entries.push({ mode, path: rec.slice(tab + 1) });
  }
  return entries;
};

const main = (): void => {
  const root = REPO_ROOT;
  const readBytes = (p: string): Uint8Array => readFileSync(join(root, p));
  const violations = trackedEntries(root)
    // `git ls-files` includes an unstaged deletion. Ignore an entry that is
    // absent from the worktree so the gate can run before a deletion is
    // staged. Use lstat rather than existsSync: a tracked dangling symlink
    // must remain visible to the symlink check above.
    .filter((e) => {
      try { lstatSync(join(root, e.path)); return true; }
      catch (error: any) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
    })
    .map((e) => classifyEntry(e.mode, e.path, readBytes))
    .filter((v): v is NonNullable<typeof v> => v !== null);

  if (violations.length === 0) {
    console.log(`source hygiene OK — no raw NUL bytes or tracked symlinks across the git-tracked tree.`);
    return;
  }
  console.error('SOURCE HYGIENE FAILED:');
  for (const v of violations) console.error(`  [${v.kind}] ${v.path} — ${v.detail}`);
  console.error(
    '\nA raw NUL makes the file binary to git (unreviewable); a tracked '
    + 'symlink dangles on other clones. Fix the byte (escape it) or `git rm --cached` the symlink.',
  );
  process.exit(1);
};

if (import.meta.main) main();
