// Preflight — the same gate CI runs, runnable locally. Exists so main
// stays green even when GitHub Actions can't provision runners (billing
// outages, offline work): run it before pushing, or install it as a
// pre-push hook with scripts/install-hooks.sh.
//
//   bun run preflight          fast checks (~15s): generated-file drift,
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

const main = () => {
  const args = parseArgs(process.argv.slice(2));

  // Drift check. gen:dev rewrites the two generated files, so snapshot
  // their current bytes first: if they were already modified in the
  // working tree (e.g. a regen the user intends to commit), we must not
  // silently clobber that — we compare the freshly-generated output to
  // what's COMMITTED (HEAD), and restore the user's bytes afterward so
  // preflight is non-destructive either way.
  const genFiles = ['extension/manifest.json', 'extension/shared/channel-config.js']
    .map((p) => join(REPO_ROOT, p));
  const before = genFiles.map((f) => readFileSync(f));
  run('regenerate dev manifest + channel-config', 'bun', ['run', 'gen:dev']);
  let drift = false;
  for (const f of genFiles) {
    try {
      execFileSync('git', ['diff', '--quiet', '--exit-code', 'HEAD', '--', f], { cwd: REPO_ROOT });
    } catch { drift = true; }
  }
  // Restore the pre-run bytes (whatever they were) — the generated output
  // we just wrote was only needed for the comparison above.
  genFiles.forEach((f, i) => writeFileSync(f, before[i]));
  if (drift) {
    console.error(
      '\npreflight FAILED: extension/manifest.json or shared/channel-config.js '
      + 'differs from `bun run gen:dev` output vs HEAD. Run `bun run gen:dev` '
      + 'and commit the regenerated files (sources: manifests/*.json, '
      + 'packaging/default-settings.mjs).',
    );
    process.exit(1);
  }
  console.log('generated files in sync with HEAD');

  run('eslint', 'npm', ['run', 'lint']);
  run('typecheck (bun suite + // @ts-check extension files)', 'bun', ['run', 'typecheck']);
  run('typecheck coverage floor', 'bun', ['run', 'check:tscheck']);
  run('dweb boundary', 'bun', ['run', 'check:boundary']);
  run('packaged import graph (no pruned-but-imported file)', 'bun', ['run', 'check:imports']);
  run('bun tests', 'bun', ['test', './tests']);
  if (args.matrix === true) {
    run('artifact matrix (store artifacts verified)', 'bun', ['packaging/package.ts', '--all', '--no-sign']);
    // Chrome-cost gate: boots every page of the real pruned build (both channels)
    // and fails on a blank page / missing same-origin resource. Needs Chrome for
    // Testing (bun run e2e:chrome); mirrors the CI `packaged page boot` job.
    run('packaged page boot (every page loads clean in the pruned build)', 'bun', ['run', 'check:pages']);
  }

  console.log('\npreflight OK');
};

main();
