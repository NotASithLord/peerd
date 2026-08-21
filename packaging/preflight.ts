// Preflight — the same gate CI runs, runnable locally. Exists so main
// stays green even when GitHub Actions can't provision runners (billing
// outages, offline work): run it before pushing, or install it as a
// pre-push hook with scripts/install-hooks.sh.
//
//   bun run preflight          release checks (~5m): generated-file drift,
//                              ESLint, typecheck, dweb boundary, Bun tests
//   bun run preflight -- --matrix   also build + verify all four artifacts
//
// Mirrors the `test` + `checks` jobs in package-and-release.yml (and the
// `build` matrix with --matrix). Keep the two in sync when adding steps.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, parseArgs } from './lib.ts';

const run = (label: string, cmd: string, args: string[]) => {
  console.log(`\n── preflight: ${label} ──`);
  execFileSync(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit' });
};

type SyncRunner = typeof execFileSync;

/** One pathspec-batched diff preserves the old any-file-drift verdict. */
export const generatedFilesDifferFromHead = (
  root: string,
  files: string[],
  runner: SyncRunner = execFileSync,
): boolean => {
  if (files.length === 0) return false;
  try {
    runner('git', ['diff', '--quiet', '--exit-code', 'HEAD', '--', ...files], {
      cwd: root,
      stdio: 'ignore',
    });
    return false;
  } catch {
    // Exit 1 means drift; command/path/repository errors also stay fail-closed.
    return true;
  }
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));

  // Drift check. gen:dev rewrites the two generated files, so snapshot
  // their current bytes first: if they were already modified in the
  // working tree (e.g. a regen the user intends to commit), we must not
  // silently clobber that — we compare the freshly-generated output to
  // what's COMMITTED (HEAD), and restore the user's bytes afterward so
  // preflight is non-destructive either way.
  // why the badge too: CI's drift step diffs all three generated files; the
  // badge changes whenever the tscheck coverage denominator moves (it did when
  // the web-shell template joined the scan), and preflight passing while CI fails on badge
  // drift is exactly the out-of-sync trap this mirror exists to prevent.
  const genFiles = [
    'extension/manifest.json', 'extension/shared/channel-config.js',
    'extension/shared/build-config.js', 'badges/tscheck.json',
    // The supply-chain badges ride gen:dev too: pure reads of package.json,
    // vendor.lock.json and the workflows, so they drift exactly like a manifest.
    'badges/vendor-integrity.json', 'badges/actions-pinned.json',
    'badges/no-build.json',
  ].map((p) => join(REPO_ROOT, p));
  const before = genFiles.map((f) => readFileSync(f));
  run('regenerate dev manifest + channel-config', 'bun', ['run', 'gen:dev']);
  const drift = generatedFilesDifferFromHead(REPO_ROOT, genFiles);
  // Restore the pre-run bytes (whatever they were) — the generated output
  // we just wrote was only needed for the comparison above.
  genFiles.forEach((f, i) => writeFileSync(f, before[i]));
  if (drift) {
    console.error(
      '\npreflight FAILED: a generated file (extension/manifest.json, '
      + 'shared/channel-config.js, shared/build-config.js, or badges/tscheck.json) differs from '
      + '`bun run gen:dev` output vs HEAD. Run `bun run gen:dev` and commit '
      + 'the regenerated files (sources: manifests/*.json, '
      + 'packaging/default-settings.mjs, the // @ts-check coverage scan).',
    );
    process.exit(1);
  }
  console.log('generated files in sync with HEAD');

  run('eslint', 'npm', ['run', 'lint']);
  run('typecheck (bun suite + // @ts-check extension files)', 'bun', ['run', 'typecheck']);
  run('complete typecheck coverage', 'bun', ['run', 'check:tscheck']);
  run('cold-entry graph, policy, and artifact ratchets', 'bun', ['run', 'check:cold-static']);
  run('dweb boundary', 'bun', ['run', 'check:boundary']);
  run('packaged import graph (no pruned-but-imported file)', 'bun', ['run', 'check:imports']);
  // MUST follow check:imports, which is what stages the four channel×browser
  // builds this lints. This covers the static Firefox package posture; the
  // separate firefox-runtime CI job installs the Store XPI and runs it in Gecko.
  run('firefox package lint (AMO validator; no unguarded Chrome-only API)', 'bun', ['run', 'check:firefox']);
  run('doc path references (top-level docs point at real files)', 'bun', ['run', 'check:docpaths']);
  // The browser lanes each regenerate their own badge in CI (they need Chrome or
  // Firefox in the room). This is the part preflight CAN prove locally: the
  // endpoints are well-formed and the two in-browser lanes still agree on how
  // many browser tests exist.
  run('coverage badges (well-formed; in-browser lanes agree)', 'bun', ['run', 'check:badges']);
  run('action pins (every third-party action at a full commit SHA)', 'bun', ['run', 'check:actions']);
  run('source hygiene (no control bytes / tracked symlinks in source)', 'bun', ['run', 'check:hygiene']);
  run('copy hygiene (no new em dashes / assistant authorship markers)', 'bun', ['run', 'check:copy']);
  run('vendor integrity (extension/vendor/ matches vendor.lock.json)', 'bun', ['run', 'check:vendor']);
  run('security invariants (manifest surface / dynamic code / message hosts)', 'bun', ['run', 'check:invariants']);
  // Web target: stage it fresh from source, then prove the tree is import-closed
  // (nothing curated reaches pruned chassis; the browser-polyfill shim is in
  // place). This is what makes the web tree safely inherit upstream — an escape
  // introduced upstream fails here instead of rotting the staged library silently.
  run('web target build (from live source)', 'bun', ['run', 'package:web']);
  run('web import-closure boundary', 'bun', ['run', 'check:web']);
  // The functional badge comes from the actual passing JUnit aggregate. Treat
  // it like the other generated artifacts, while restoring any preflight
  // caller's existing bytes so this gate remains non-destructive.
  const functionalBadge = join(REPO_ROOT, 'badges', 'functional-tests.json');
  const functionalBadgeBefore = readFileSync(functionalBadge);
  let functionalBadgeDrift = false;
  try {
    run('bun functional tests + passing-count badge', 'bun', ['run', 'test:functional:badge']);
    try {
      execFileSync('git', ['diff', '--quiet', '--exit-code', 'HEAD', '--', functionalBadge], { cwd: REPO_ROOT });
    } catch { functionalBadgeDrift = true; }
  } finally {
    writeFileSync(functionalBadge, functionalBadgeBefore);
  }
  if (functionalBadgeDrift) {
    console.error(
      '\npreflight FAILED: badges/functional-tests.json is stale. '
      + 'Run `bun run gen:badge:functional` and commit the regenerated badge.',
    );
    process.exit(1);
  }
  if (args.matrix === true) {
    run('artifact matrix (store artifacts verified)', 'bun', ['packaging/package.ts', '--all', '--no-sign']);
    // Chrome-cost gate: boots every page of the real pruned build (both channels)
    // and fails on a blank page / missing same-origin resource. Needs Chrome for
    // Testing (bun run e2e:chrome); mirrors the CI `packaged page boot` job.
    run('packaged page boot (every page loads clean in the pruned build)', 'bun', ['run', 'check:pages']);
  }

  console.log('\npreflight OK');
};

if (import.meta.main) main();
