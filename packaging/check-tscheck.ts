// Typecheck-coverage ratchet — fails CI if the extension's // @ts-check
// coverage regresses below the recorded floor.
//
// The extension is no-build vanilla JS adopting types incrementally
// (tsconfig.json: checkJs is OFF, a file opts into checking with a
// `// @ts-check` directive). `bun run typecheck` proves the checked
// files are type-CLEAN; this script proves the checked SET only grows.
// Together they make the ratchet real: you can add coverage freely, but
// you cannot silently drop a file out of checking (delete the directive,
// or land a new untyped file that pulls the ratio down) without bumping
// the floor here in the same commit — which is the visible signal in
// review that coverage moved.
//
// When you raise coverage: run `bun run check:tscheck` and set
// COVERED_FLOOR to the reported count (never lower it).
//
// Run: bun run check:tscheck   (also part of `bun run preflight`)

import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './lib.ts';
import { computeCoverage } from './tscheck-coverage.ts';

// The number of extension .js files that must carry // @ts-check. Bump
// this (never lower) whenever you bring more files under the checker.
//
// As of the integration branch this is effectively 100%: every extension
// .js file outside the ES5-injected set (below) carries // @ts-check.
// Coverage reached here in waves — #71's opt-in ratchet, then the ~36 new
// feature-PR files (#53 vm-net/* cores, #49 pdf/* cores, #72 failover +
// resume-detect, #70 stores + routes), then the three files #70/#53/#72 had
// structurally rewritten and #71 couldn't carry forward (service-worker.js,
// sessions/store.js, vm-tab.js). The dev-only peerd-distributed/demo/
// harness (pruned from every package, wired into nothing) was removed
// rather than typed.
const COVERED_FLOOR = 475;

// The scan (walk + // @ts-check detection + the ES5-injected exemption set)
// lives in tscheck-coverage.ts so the badge generator reports the same number.
const { count, total } = computeCoverage();
const pct = ((count / total) * 100).toFixed(1);

if (count < COVERED_FLOOR) {
  console.error(
    `TYPECHECK COVERAGE REGRESSED — ${count}/${total} extension files carry `
    + `// @ts-check, below the floor of ${COVERED_FLOOR}.\n`
    + 'A file lost its // @ts-check directive, or a new untyped file landed. '
    + 'Restore the directive (and make the file type-clean: bun run typecheck), '
    + 'or — only if coverage genuinely went UP elsewhere — bump COVERED_FLOOR '
    + 'in packaging/check-tscheck.ts.',
  );
  process.exit(1);
}

if (count > COVERED_FLOOR) {
  // Not a failure — coverage grew. Nudge (don't block) to ratchet the
  // floor up so it stays a tight minimum.
  console.log(
    `typecheck coverage OK — ${count}/${total} extension files (${pct}%) carry // @ts-check, `
    + `ABOVE the floor of ${COVERED_FLOOR}. Consider bumping COVERED_FLOOR to ${count} `
    + `in ${relative(REPO_ROOT, fileURLToPath(import.meta.url))} to lock the gain in.`,
  );
  process.exit(0);
}

console.log(`typecheck coverage OK — ${count}/${total} extension files (${pct}%) carry // @ts-check (floor ${COVERED_FLOOR})`);
