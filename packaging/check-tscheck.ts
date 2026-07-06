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
//
// 478 → 474: actor_list collapsed five separate list tools (vm-list / js-list /
// app-list / list-tabs / list-integrations — all // @ts-check'd) into one
// (actor-list.js), a net −4 CHECKED FILES. This is a legitimate decrease (files
// deleted, not directives dropped) — coverage stays 100% of the non-ES5 set.
// 474 → 475: the view tool (tools/web/view.js) added one // @ts-check'd file.
// 475 → 471: the do/get/check cull removed four // @ts-check'd files (the do/
// get/check tool defs + runner/index.js — the web actor holds the DOM tools
// directly now). A legitimate decrease (files deleted, not directives dropped).
// 471 → 473: main added one // @ts-check'd file post-cull, and the async-actor
// proposal adds delegation-lineage.js (the pure trusted-lineage predicate).
// 473 → 477: heap-split phase 1 adds reasoning-worker-core.js, reasoning-worker.js,
// reasoning-runner.js, offscreen-reasoning-client.js (all // @ts-check).
// 477 → 481: heap-split phase 2 adds actor-worker-core.js, actor-worker.js,
// actor-runner.js, offscreen-actor-client.js.
// 481 → 477: heap-split UNIFICATION — the reasoning stack collapses into the actor
// stack (a reasoning subagent is a tool-less ephemeral actor), deleting those four
// phase-1 files; their code lives on in the (still // @ts-check'd) actor-* stack.
// A legitimate decrease (files deleted, not directives dropped).
// 487 → 485: the Firefox WebVM notice added vm-tab/firefox-webvm-note.js +
// its in-browser test (+2), then the inspect_* fold deleted the five old
// inspect tool defs and added tools/defs/inspect.js (−4) — net −2 checked
// files, all deletions, no directive dropped.
// 485 → 487: the sandbox_create merge — vm_create/js_create/app_create fold
// into tools/defs/sandbox-create.js (+1; the three old files stay as its
// // @ts-check'd per-kind handler modules) — and the review pass extracted the
// shared tools/defs/kind-dispatch.js (+1).
// +1: extension/tests/unit/red-team/sandbox-escape.test.js (the in-browser
// red-team tier — real-realm seal + CSP-fence assertions).
// 488 → 490: the actors-in-script surface adds subagent/actors-api.js (the
// pure delegation core) and background/script-runs.js (the live-run registry).
// 490 → 493: the debug surface adds observability/failure-classify.js,
// observability/debug-bundle.js, and observability/otel-export.js (the pure
// cores of the debug-bundle export + failure classifier + OTel mapper).
// 493 → 496: the debug surface's wiring + UI add background/context-snapshots.js
// (the capture ring), sidepanel/components/context-inspector.js, and the
// failure-chip in-browser test.
// 496 -> 498: the hardening pass adds peerd-egress/audit/chain.js (the R4
// tamper-evidence hash chain) and background/confirm-grant-key.js (the R5
// origin-bound grant key).
// 498 → 499: standing peer conversations add subagent/conversation-registry.js
// (the pure convId → turns thread store).
// 499 → 500: the OpenAI provider adapter adds peerd-provider/adapters/openai.js.
const COVERED_FLOOR = 500;

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
