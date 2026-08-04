// The FIREFOX gate — the only check in the tree that judges peerd AS a Firefox
// extension rather than as a Chrome one.
//
// why this exists: every executing lane is Chrome (in-browser tests, e2e, visual,
// packaged page boot). Firefox is BUILT, import-checked, and signed — never run.
// So a Chrome-only API landing in the Firefox package ships green today. This
// closes the cheapest slice of that gap without needing a browser at all:
// `web-ext lint` is AMO's own static validator, so it knows Firefox's API surface
// and its manifest rules, and it runs offline.
//
// Two gates, deliberately different in kind:
//
//   1. ERRORS are absolute. An error here is a package AMO would reject, so
//      there is no threshold to argue about — zero, always.
//
//   2. Chrome-only API usage is a RATCHET against a named allowlist, the same
//      shape as check-tscheck.ts's coverage floor. peerd legitimately ships some
//      Chrome-only code into the Firefox package: the module is loaded but the
//      call site is guarded by a runtime capability probe (`offscreenAvailable`,
//      `debuggerApiAvailable()`, and friends), which is a pattern a static linter
//      cannot see through. So the answer is not "make the warning go away" — it
//      is to enumerate the ones we have deliberately guarded, and fail on any
//      NEW one. A new unguarded Chrome API in the Firefox build is exactly the
//      bug this repo currently cannot catch.
//
// What this does NOT do: execute anything. It cannot tell you the guards actually
// hold at runtime — only that the set of things needing a guard has not grown.
// Real Firefox execution is the next rung and needs a Firefox binary.
//
// Run: bun run check:firefox   (also part of `bun run preflight`)

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, ARTIFACTS_DIR } from './lib.ts';

/**
 * Chrome-only APIs we KNOWINGLY ship into the Firefox package, each behind a
 * runtime guard. Keyed by the API name web-ext reports plus the file, so moving
 * a call within a file is free but introducing one somewhere new is not.
 *
 * Adding an entry is a deliberate act: it asserts "this call site is guarded and
 * Firefox takes the fallback path". Do not add one to silence a lint — add it
 * once the guard exists.
 */
const GUARDED_CHROME_ONLY: readonly { api: string; file: string; why: string }[] = [
  // The heap split needs the offscreen API; Firefox has none, so actorClient is
  // null and the actor turn falls back to the in-SW loop (THREAT-MODEL R1).
  { api: 'offscreen.createDocument', file: 'background/service-worker.js', why: 'guarded by offscreenAvailable' },
  { api: 'runtime.getContexts', file: 'background/service-worker.js', why: 'offscreen liveness probe, same guard' },
  { api: 'runtime.getContexts', file: 'background/routes/dweb.js', why: 'offscreen liveness probe, same guard' },
  // CDP. The `debugger` permission is STRIPPED from every Firefox manifest
  // (gen-manifest.ts), and the pool is wired in only when advancedAutomationOn().
  { api: 'debugger.attach', file: 'background/debugger-pool.js', why: 'permission stripped on Firefox; guarded by advancedAutomationOn()' },
  { api: 'debugger.detach', file: 'background/debugger-pool.js', why: 'same' },
  { api: 'debugger.sendCommand', file: 'background/debugger-pool.js', why: 'same' },
  { api: 'debugger.onEvent', file: 'background/debugger-pool.js', why: 'same' },
  { api: 'debugger.onDetach', file: 'background/debugger-pool.js', why: 'same' },
  // Firefox uses sidebar_action, not side_panel — the manifest transform swaps
  // them and these call sites are capability-probed.
  { api: 'sidePanel.open', file: 'background/tab-affordances.js', why: 'Firefox uses sidebar_action' },
  { api: 'sidePanel.setPanelBehavior', file: 'background/tab-affordances.js', why: 'Firefox uses sidebar_action' },
  { api: 'sidePanel.setOptions', file: 'background/service-worker.js', why: 'Firefox uses sidebar_action' },
  // Tab groups are the engine-tab strip affordance; absent on Firefox, and the
  // tracker degrades to ungrouped tabs.
  { api: 'tabs.group', file: 'background/tab-tracker.js', why: 'cosmetic grouping; degrades to ungrouped' },
  { api: 'tabGroups.query', file: 'background/tab-tracker.js', why: 'same' },
  { api: 'tabGroups.update', file: 'background/tab-tracker.js', why: 'same' },
];

/** The two codes that mean "this API is not there on Firefox". */
const CHROME_ONLY_CODES = new Set(['UNSUPPORTED_API', 'INCOMPATIBLE_API']);

type LintItem = { code?: string; message?: string; file?: string; line?: number };

const lint = (sourceDir: string): { errors: LintItem[]; warnings: LintItem[] } => {
  const bin = join(REPO_ROOT, 'node_modules', '.bin', 'web-ext');
  const run = spawnSync(bin, ['lint', '--source-dir', sourceDir, '--self-hosted', '-o', 'json'], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  // web-ext exits non-zero when it finds anything, so the exit code is not the
  // signal — the parsed report is. A missing/unparseable report IS fatal though:
  // silently treating "the linter did not run" as "the linter found nothing" is
  // how a gate becomes decorative.
  const out = run.stdout ?? '';
  const start = out.indexOf('{');
  if (start < 0) {
    throw new Error(`web-ext lint produced no JSON report for ${sourceDir}\n${run.stderr ?? ''}`);
  }
  const parsed = JSON.parse(out.slice(start));
  return { errors: parsed.errors ?? [], warnings: parsed.warnings ?? [] };
};

/** Does this warning name an API on the guarded list, in the file we expect it in? */
const isGuarded = (item: LintItem): boolean =>
  GUARDED_CHROME_ONLY.some((g) => (item.message ?? '').includes(g.api) && item.file === g.file);

const main = () => {
  const builds = ['store-firefox', 'preview-firefox']
    .map((name) => ({ name, dir: join(ARTIFACTS_DIR, 'staging', name) }))
    .filter((b) => existsSync(b.dir));

  if (builds.length === 0) {
    console.error('FIREFOX LINT FAILED: no Firefox staging build found.\n'
      + '  Run `bun packaging/package.ts --channel=store --browser=firefox` first\n'
      + '  (CI builds all four channel×browser artifacts before this step).');
    process.exit(1);
  }

  const problems: string[] = [];
  for (const { name, dir } of builds) {
    const { errors, warnings } = lint(dir);
    for (const e of errors) {
      problems.push(`  [${name}] ERROR ${e.code} — ${e.message} (${e.file ?? 'manifest'}${e.line ? `:${e.line}` : ''})`);
    }
    const ungated = warnings.filter((w) => CHROME_ONLY_CODES.has(w.code ?? '') && !isGuarded(w));
    // Dedupe: the linter reports every call site, and one unguarded API is one
    // problem to fix, not eight lines of noise.
    const seen = new Set<string>();
    for (const w of ungated) {
      const key = `${w.code}|${w.message}|${w.file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push(`  [${name}] ${w.code} — ${w.message} (${w.file}:${w.line})`);
    }
    const guardedCount = warnings.filter((w) => CHROME_ONLY_CODES.has(w.code ?? '')).length - ungated.length;
    console.log(`[${name}] ${errors.length} error(s) · ${warnings.length} warning(s) · `
      + `${guardedCount} Chrome-only call site(s) on the guarded list · ${ungated.length} not`);
  }

  if (problems.length > 0) {
    console.error('\nFIREFOX LINT FAILED:\n' + problems.join('\n') + '\n\n'
      + 'An ERROR is a package AMO would reject — fix it.\n'
      + 'An UNSUPPORTED_API / INCOMPATIBLE_API means Chrome-only code reached the Firefox\n'
      + 'build. Either guard the call site behind a runtime capability probe and add it to\n'
      + 'GUARDED_CHROME_ONLY in packaging/check-firefox.ts (with the guard named), or keep\n'
      + 'the code out of the Firefox package. Do NOT add an entry to silence the lint —\n'
      + 'the entry asserts a guard exists.');
    process.exit(1);
  }
  console.log(`firefox lint OK — ${builds.length} build(s), 0 errors, no unguarded Chrome-only APIs.`);
};

main();
