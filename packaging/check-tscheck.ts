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
// 501 → 506: PR #119 + its OM2W eval merge in: the web-actor page-API
// translation core (subagent/page-api.js) + the page-call handler
// (subagent/page-call-handler.js) + the code-REPL action tool
// (tools/defs/page-code.js) + the OM2W adapter's two eval modules
// (eval/om2w-actions.js + eval/om2w-recorder.js).
// 501 → 505: the fetch_url content pipeline adds offscreen/web-extract.js,
// background/offscreen-web-client.js, tools/web/spill.js, and
// tools/defs/read-web-cache.js (vendor/ is exempt from the scan).
// 505/506 → 510: the #119 (page bridge + OM2W eval) and #187 (fetch content
// pipeline) file sets merge — both ledgers above are kept; the union floor.
// 510 → 511: the Z.ai GLM provider adapter (peerd-provider/adapters/glm.js).
// 530 → 534: the security-boundary arc's four pure cores —
// actor/reply-schema.js (#241), actor/ugc-registry.js (#242),
// tools/egress-heuristics.js (#243), dom/cdr.js (#244).
// 545/547 → 548: the learned-origins un-learn surface (#262) and the Activity
// origin-lock rows (#282) land together — both ledgers are kept and the floor
// is their union, the same shape as the 505/506 → 510 merge above.
// 648 → 653: Firefox actor isolation adds the direct background host, worker
// protocol, browser-neutral capability, shared capability banner, and browser
// UX test.
// 548 → 549: the in-page activity indicator's two checked cores (#259) —
// actor/activity-label.js and background/page-activity.js. The injected
// overlay body itself is ES5 and exempt, so it does not count.
// 549 → 551: ratchet hygiene at the 0.4.0 release, not new annotation work.
// The 548 and 549 steps were each derived from a conflicting base rather than
// from a fresh scan, so the floor was left trailing the real count by two.
// Taking the reported number locks the existing gain in.
// 551 → 553: the denylist's declarativeNetRequest backstop adds two checked
// files — peerd-egress/denylist/dnr-rules.js (the pure patterns → rule mapping)
// and background/denylist-net-guard.js (the session-rule sync shell).
// 553 → 570: the JS-superpower arc — vm-tab/run-capture.js (design 7.1),
// durable script workspace + run-cache (design 1), extract:'markdown' +
// peerd:std helpers (design 2), remote module imports via egress (design 3),
// peerd.provider.call (design 5), and the peerd:toolbox store + tools
// (design 6); all new files carry // @ts-check.
// 570 → 572: the tool-ergonomics batch — the shared once-per-session dedup
// guard (tools/defs/once-per-session.js, design 6) and the pure failure
// aggregator's home (metrics design 5); all new files carry // @ts-check.
// 572 → 576: the DPoP proof-of-possession credential path (INV-15) adds
// peerd-egress/dpop/proof.js (the pure RFC 9449 core) and dpop/keys.js (the
// non-extractable keypair shell); both carry // @ts-check. The +4 (not +2) also
// locks in two files that had already landed above the stale 572 floor.
// Merge with main (#294 settings redesign etc.): main's floor was 576; this
// branch's DPoP work plus the new in-browser dpop-key-idb.test.js, merged with
// main's two new checked files (settings-row.js, behavior-rows.test.js), put
// the merged count at 579 (computed on the merged tree, not summed).
// peerd-runtime/doc + its offscreen/SW/tool wiring (the read_doc document
// reader) all landed // @ts-check-clean, so the floor moves up to lock them in.
// Merge with main (#309 dpop nonces): this branch's lifecycle files put the
// floor at 614; main adds peerd-egress/dpop/nonce.js. Computed on the MERGED
// tree, not summed — the same shape as the 579 merge above.
// 615 → 618: the lifecycle hardening batch — failure-taxonomy.js (typed
// outcomes), write-guard.js (§11.5 enforcement), engine-liveness.js (§9
// ledger); all carry // @ts-check.
// 618 → 619: the actors-in-code SW route extracted for issue #324.
// 619 → 624: the initial portable-identity capsule/record implementation.
// 624 → 628: custody hardening added the shared crypto/host boundaries,
// rendered restore-flow test, and tested offscreen lifecycle barrier while
// centralizing identity-bound sharing and removing unused device-key files.
// 628 → 629: targeted dweb-custody port client (raw roots and passphrases
// never ride extension-wide broadcast messaging).
// 629 → 630: permanent identity reads and first-mint writes moved from generic
// runtime routes into the verified custody port.
// 630 → 631: one shared memory-hard KDF policy now protects every new backup
// password oracle.
// 631 → 633: the exact-options transfer Port and its client keep backup
// passwords off extension-wide runtime messages.
// 633 → 635: App asset classification and the full binary runner test.
// 635 → 636: the recoverable publish transaction is shared by dweb hosts.
// 636 → 639: dweb reseed, content ownership, and share rollback are checked.
// 650 → 651: Firefox actor credential-custody browser coverage is checked.
// 651 → 657: the direct host, worker protocol, isolation policy, banner,
// rendered fixture, and UI test are checked.
// 657 → 658: durable actor isolation failure state is checked.
// 659 → 660: the remote module import policy is checked.
// 660 → 662: the shared private-network and browser-target policies are checked.
// 662 → 670: browser navigation custody and exact-document helpers are checked.
// 672 → 673: cold-start popup network custody is checked.
// Contributor Metrics adds the closed accumulator/store, trusted background
// route, Options surface, and rendered side-panel coverage.
// 673 → 676: the Actor Fabric adds its pure topology model, SW live projection,
// and rendered browser contract while replacing the checked async-task bar.
const COVERED_FLOOR = 690;

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
