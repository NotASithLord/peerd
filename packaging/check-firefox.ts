// The static Firefox package gate. The separate `firefox-runtime` CI job runs
// the packaged Store XPI and the shared browser suite in Gecko.
//
// why this exists: runtime coverage cannot replace AMO validation or an exact
// inventory of guarded Chrome-only call sites. A bad manifest or a new unguarded
// API must fail before runtime. This gate does that without launching a browser:
// `web-ext lint` is AMO's own static validator, so it knows Firefox's API surface
// and its manifest rules, and it runs offline.
//
// Two gates, deliberately different in kind:
//
//   1. ERRORS are absolute. An error here is a package AMO would reject, so
//      there is no threshold to argue about — zero, always.
//
//   2. Chrome-only API usage is a RATCHET against a named allowlist, the same
//      shape as check-tscheck.ts's complete-coverage invariant. peerd legitimately ships some
//      Chrome-only code into the Firefox package: the module is loaded but the
//      call site is guarded by a runtime capability probe (`offscreenAvailable`,
//      `debuggerApiAvailable()`, and friends), which is a pattern a static linter
//      cannot see through. So the answer is not "make the warning go away" — it
//      is to enumerate the ones we have deliberately guarded, and fail on any
//      NEW one. A new unguarded Chrome API in the Firefox build is exactly the
//      bug this repo currently cannot catch.
//
// What this does NOT do: execute anything. It proves the static package posture;
// the `firefox-runtime` job proves the installed Store package in Firefox.
//
// Run: bun run check:firefox   (also part of `bun run preflight`)

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT, ARTIFACTS_DIR, STORE_LOADER_TEMPLATE,
  DWEB_ROUTES_DISABLED_TEMPLATE, DWEB_SELF_ROUTES_DISABLED_TEMPLATE,
} from './lib.ts';

/**
 * Chrome-only APIs we KNOWINGLY ship into the Firefox package, each behind a
 * runtime guard. Keyed by the API name web-ext reports plus the file, so moving
 * a call within a file is free but introducing one somewhere new is not.
 *
 * Adding an entry is a deliberate act: it asserts "this call site is guarded and
 * Firefox takes the fallback path". Do not add one to silence a lint — add it
 * once the guard exists.
 */
export type GuardedChromeOnlyApi = {
  api: string;
  file: string;
  why: string;
  /** Whitespace-insensitive source fragments that prove the named guard and guarded call ship together. */
  proof?: readonly string[];
};

export const FIREFOX_BUILD_NAMES = ['store-firefox', 'preview-firefox'] as const;

export const GUARDED_CHROME_ONLY: readonly GuardedChromeOnlyApi[] = [
  // Chrome uses this for the actor-worker host and other document-only jobs.
  // Firefox starts the actor Worker directly from its extension background page.
  { api: 'offscreen.createDocument', file: 'background/service-worker.js', why: 'guarded by offscreenAvailable' },
  { api: 'runtime.getContexts', file: 'background/offscreen-contexts.js', why: 'one capability-checked offscreen liveness probe' },
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
  // The native kernel is one buildless source graph for Chrome and Firefox.
  // Every Chrome-only member below is capability-probed before use, and the
  // package gate verifies the probe and guarded call in BOTH Firefox artifacts.
  { api: 'offscreen.createDocument', file: 'background/kernel-feature-host.js',
    why: 'ensureOffscreen refuses when the API is absent; Firefox uses direct background lifetimes',
    proof: ["typeof offscreen?.createDocument !== 'function'", 'await offscreen.createDocument('] },
  { api: 'offscreen.closeDocument', file: 'background/kernel-feature-host.js',
    why: 'close is a no-op unless the capability exists',
    proof: ["typeof browser.offscreen?.closeDocument === 'function'", 'await browser.offscreen.closeDocument()'] },
  { api: 'sidePanel.open', file: 'background/kernel-front-door.js',
    why: 'decidePullIn selects Firefox sidebarAction when sidePanel.open is absent',
    proof: ["hasSidePanel: typeof browser.sidePanel?.open === 'function'", 'browser.sidePanel.open({ windowId })'] },
  { api: 'sidePanel.setPanelBehavior', file: 'background/kernel-front-door.js',
    why: 'native preference sync returns false when the capability is absent',
    proof: ["typeof browser.sidePanel?.setPanelBehavior !== 'function'", 'await browser.sidePanel.setPanelBehavior('] },
  { api: 'runtime.requestUpdateCheck', file: 'background/vault-kernel.js',
    why: 'enabled only for a top-level Chrome update_url plus the runtime capability',
    proof: ['!!kernelManifest.update_url', "typeof browser.runtime.requestUpdateCheck === 'function'"] },
  { api: 'runtime.requestUpdateCheck', file: 'background/service-worker.js',
    why: 'legacy cold listener is enabled only for a Chrome update_url plus the runtime capability',
    proof: ['Boolean(coldManifest.update_url)', "typeof browser.runtime.requestUpdateCheck === 'function'"] },
  { api: 'offscreen.closeDocument', file: 'background/service-worker.js',
    why: 'legacy lease teardown is a no-op unless the close capability exists',
    proof: ["offscreen?.closeDocument === 'function'", 'offscreen.closeDocument()'] },
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

export const main = () => {
  const builds = FIREFOX_BUILD_NAMES
    .map((name) => ({ name, dir: join(ARTIFACTS_DIR, 'staging', name) }))
    .filter((b) => existsSync(b.dir));
  const problems: string[] = [];
  for (const name of FIREFOX_BUILD_NAMES) {
    if (!builds.some((build) => build.name === name)) {
      problems.push(`  [${name}] staging build is missing`);
    }
  }
  for (const { name, dir } of builds) {
    if (existsSync(join(dir, 'peerd-distributed'))) {
      problems.push(`  [${name}] dweb module is present without a Firefox mesh host`);
    }
    const loader = join(dir, 'shared', 'dweb-loader.js');
    if (!existsSync(loader)
        || !readFileSync(loader).equals(readFileSync(STORE_LOADER_TEMPLATE))) {
      problems.push(`  [${name}] dweb loader is not the inert package template`);
    }
    for (const [relativePath, templatePath] of [
      ['background/routes/dweb.js', DWEB_ROUTES_DISABLED_TEMPLATE],
      ['background/routes/dweb-self.js', DWEB_SELF_ROUTES_DISABLED_TEMPLATE],
    ] as const) {
      const packagedPath = join(dir, relativePath);
      if (!existsSync(packagedPath)
          || !readFileSync(packagedPath).equals(readFileSync(templatePath))) {
        problems.push(`  [${name}] ${relativePath} is not the inert package template`);
      }
    }
    const channelConfig = readFileSync(join(dir, 'shared', 'channel-config.js'), 'utf8');
    if (!channelConfig.includes('export const DWEB_ENABLED = false')
        || channelConfig.includes('dwebEnabled:')
        || channelConfig.includes('dwebAgentEnabled:')) {
      problems.push(`  [${name}] channel config advertises dweb without a Firefox mesh host`);
    }
    for (const guarded of GUARDED_CHROME_ONLY) {
      if (!guarded.proof) continue;
      const guardedPath = join(dir, guarded.file);
      if (!existsSync(guardedPath)) {
        problems.push(`  [${name}] guarded API owner is missing: ${guarded.file}`);
        continue;
      }
      const compact = readFileSync(guardedPath, 'utf8').replace(/\s+/g, '');
      const missingProof = guarded.proof
        .filter((fragment) => !compact.includes(fragment.replace(/\s+/g, '')));
      if (missingProof.length > 0) {
        problems.push(`  [${name}] ${guarded.api} guard proof is stale in ${guarded.file}`);
      }
    }
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

if (import.meta.main) main();
