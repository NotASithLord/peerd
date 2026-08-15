#!/usr/bin/env bun
// visual-vs-base - the visual regression answer, COMPUTED, never stored.
//
// THIS REPO COMMITS NO BASELINE IMAGES. The reference is the merge-base build:
// render every visual state against it, render the same states against this
// branch, diff the pairs. peerd has no build step, so "check out the base and
// render it" is a worktree plus a harness run - cheap here, and impossible in a
// project that has to compile first.
//
// why not committed baselines (what this replaced): a stored reference has to be
// RESEEDED by hand on every intentional UI change - dispatch a workflow, download
// an artifact, eyeball it, commit dozens of binary PNGs. That put megabytes of
// screenshots into the history of a repo whose whole point is that it has no
// build output, made every UI PR a two-commit dance, and still could not answer
// the question a reviewer actually asks ("show me the old one next to the new
// one") for any state that had no baseline yet.
//
// what is LOST, stated plainly: a computed reference cannot GATE. Against the
// merge base an intentional change and a regression are the same signal, so this
// reports and never fails the job. The human checkpoint moves from "someone
// committed this baseline" to "someone read the before/after on the PR". That is
// the trade the stored images were buying, and it is the whole of it.
//
// why the merge-base and not origin/main: main moves. Diffing against its HEAD
// attributes everything that landed while you were branched to your PR.
//
// Usage:
//   bun scripts/cdp/visual-vs-base.mjs [--base <ref>] [--only a,b] [--reuse-head]
//
// Writes into scripts/cdp/visual-runs/ (gitignored):
//   base/            the merge-base run's artifacts (its own dir: run-e2e-verify
//                    WIPES whatever it is pointed at)
//   screens/base/<state>.<theme>.png     the merge-base render
//   screens/head/<state>.<theme>.png     this branch's render
//   screens/diff/<state>.<theme>.png     red-mask highlight, only where it moved
//   visual-vs-base.json                  the structured verdict
// and prints a markdown report on stdout (the CI job summary reads it).

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { STATES } from './states.mjs';
import { THEMES, log } from './e2e-harness.mjs';
import { DEFAULT_THRESHOLD, decodePng, comparePixels, writeDiffImage } from './visual.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const ARTIFACTS = join(HERE, 'artifacts');       // the head run's normal home
const RUNS = join(HERE, 'visual-runs');          // everything this script owns

const arg = (flag) => {
  const hit = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (hit) return hit.slice(`--${flag}=`.length);
  const i = process.argv.indexOf(`--${flag}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const only = (arg('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const REUSE_HEAD = process.argv.includes('--reuse-head');

const visualStates = STATES.filter((s) => s.kind === 'visual')
  .filter((s) => !only.length || only.includes(s.name));
if (!visualStates.length) {
  console.error('[vs-base] no visual states selected');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const tryGit = (...args) => { try { return git(...args); } catch { return null; } };

// why the fallback chain: on a PR the runner checks out the MERGE ref, so
// merge-base(origin/main, HEAD) resolves to main's tip - the right "before" for
// "what will main look like after this lands". A checkout that never fetched
// origin/main would otherwise throw here and silently cost the whole comparison,
// so fall back to the plain ref before giving up.
const resolveBase = () => arg('base')
  || tryGit('merge-base', 'origin/main', 'HEAD')
  || tryGit('rev-parse', 'origin/main')
  || tryGit('rev-parse', 'main');
const baseRef = resolveBase();
const headRef = git('rev-parse', 'HEAD');
if (!baseRef) {
  console.error('[vs-base] no merge base and no origin/main - nothing to compare against');
  process.exit(0);
}

const BASE_RUN = join(RUNS, 'base');
const SCREENS = join(RUNS, 'screens');
const BASE_DIR = join(SCREENS, 'base');
const HEAD_DIR = join(SCREENS, 'head');
const DIFF_DIR = join(SCREENS, 'diff');
const baseTree = join(RUNS, `base-tree-${baseRef.slice(0, 8)}`);

rmSync(SCREENS, { recursive: true, force: true });
for (const d of [RUNS, SCREENS, BASE_DIR, HEAD_DIR, DIFF_DIR]) mkdirSync(d, { recursive: true });

/** Copy a finished run's `<name>-current.png` captures into a flat screens dir. */
const collect = (fromDir, intoDir) => {
  let n = 0;
  if (!existsSync(fromDir)) return n;
  for (const f of readdirSync(fromDir)) {
    if (!f.endsWith('-current.png')) continue;
    copyFileSync(join(fromDir, f), join(intoDir, f.replace(/-current\.png$/, '.png')));
    n += 1;
  }
  return n;
};

// ── rendering ────────────────────────────────────────────────────────────────
// Both sides go through run-e2e-verify, the SAME entry point the verify loop
// uses, differing only in --extension. why a subprocess and not a private render
// function: any second copy of the state sequencing (phase order, session reset,
// freezeAnimations) would drift from the real one, and every drift would show up
// as a diff attributed to the PR. One code path, no drift.
const render = ({ extensionDir, artifactsDir }) => {
  const args = [join(HERE, 'run-e2e-verify.mjs'), '--visual'];
  if (only.length) args.push(`--only=${only.join(',')}`);
  if (extensionDir) args.push(`--extension=${extensionDir}`);
  if (artifactsDir) args.push(`--artifacts=${artifactsDir}`);
  // Visual states no longer fail the verify run, so a non-zero exit here is a
  // state that THREW or a functional check inside a visual state. Report it and
  // keep going: whatever did get captured is still worth comparing.
  const r = spawnSync('bun', args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.status !== 0) log(`render exited ${r.status} - comparing whatever it captured`);
};

// ── the base build ───────────────────────────────────────────────────────────
// A detached worktree at the merge-base. The STATE DEFINITIONS come from this
// branch (they have to - the base does not know the new states exist); only the
// EXTENSION under test comes from the base. That separation is the whole trick.
const materialiseBase = () => {
  if (existsSync(baseTree)) return true;
  try {
    execFileSync('git', ['worktree', 'add', '--detach', baseTree, baseRef], { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    log(`could not check out ${baseRef.slice(0, 8)} (${e?.message ?? e}) - is the fetch deep enough?`);
    return false;
  }
  // The manifest is generated, not committed in a runnable state for every
  // channel - regenerate it inside the base tree so it can be loaded unpacked.
  try { execFileSync('bun', ['run', 'gen:dev'], { cwd: baseTree, stdio: 'pipe' }); }
  catch (e) { log(`gen:dev in the base tree failed (continuing): ${e?.message ?? e}`); }
  return true;
};

if (!materialiseBase()) {
  console.log('### Visual regression\n');
  console.log(`_Could not check out the merge base \`${baseRef.slice(0, 8)}\`, so there was nothing to compare against._`);
  process.exit(0);
}

log(`comparing ${headRef.slice(0, 8)} against the merge base ${baseRef.slice(0, 8)}`);

// BASE first: it renders into its own artifacts dir and so never disturbs
// scripts/cdp/artifacts/, which the head run owns and everything downstream
// (result.json, the screenshots an agent reads) expects to be THIS branch's.
log('rendering the BEFORE (merge-base build)…');
render({ extensionDir: join(baseTree, 'extension'), artifactsDir: BASE_RUN });
log(`captured ${collect(BASE_RUN, BASE_DIR)} base screen(s)`);

// --reuse-head skips the second render when the caller ALREADY ran the visual
// suite on this branch (the CI job does, to keep its own check results).
const headAlreadyRendered = REUSE_HEAD && existsSync(ARTIFACTS)
  && readdirSync(ARTIFACTS).some((f) => f.endsWith('-current.png'));
if (headAlreadyRendered) {
  log(`reusing ${collect(ARTIFACTS, HEAD_DIR)} head screen(s) already in artifacts/`);
} else {
  log('rendering the AFTER (this branch)…');
  render({ artifactsDir: ARTIFACTS });
  log(`captured ${collect(ARTIFACTS, HEAD_DIR)} head screen(s)`);
}

// ── compare ──────────────────────────────────────────────────────────────────
const rows = [];
for (const state of visualStates) {
  for (const theme of THEMES) {
    const key = `${state.name}.${theme}`;
    const b = join(BASE_DIR, `${key}.png`);
    const a = join(HEAD_DIR, `${key}.png`);
    if (!existsSync(a)) {
      // The state produced nothing on THIS branch. That is a harness problem,
      // not a visual one, but silence would read as "nothing changed here".
      rows.push({ state: state.name, theme, key, verdict: 'not captured on this branch', ratio: null });
      continue;
    }
    if (!existsSync(b)) {
      // A genuinely new screen, as opposed to a new PHOTOGRAPH of an existing
      // one. They read identically in a diff report and mean opposite things.
      rows.push({ state: state.name, theme, key, verdict: 'new screen (absent on the base)', ratio: null });
      continue;
    }
    const before = decodePng(readFileSync(b));
    const after = decodePng(readFileSync(a));
    if (before.width !== after.width || before.height !== after.height) {
      rows.push({
        state: state.name, theme, key, ratio: null,
        verdict: `capture resized ${before.width}×${before.height} to ${after.width}×${after.height}`,
      });
      continue;
    }
    const { ratio } = comparePixels(before, after);
    const changed = ratio > DEFAULT_THRESHOLD;
    if (changed) writeDiffImage(before, after, join(DIFF_DIR, `${key}.png`));
    rows.push({ state: state.name, theme, key, verdict: changed ? 'changed' : 'identical', ratio });
  }
}

const notable = rows.filter((r) => r.verdict !== 'identical');
writeFileSync(join(RUNS, 'visual-vs-base.json'), JSON.stringify({
  baseRef, headRef, threshold: DEFAULT_THRESHOLD, screens: SCREENS, rows,
}, null, 2));

// why a FILE and not stdout: the two renders run with inherited stdio, so their
// harness chatter shares this process's stdout. A caller redirecting us into a
// job summary would capture every `[e2e] PASS …` line along with the report.
const pct = (n) => `${(n * 100).toFixed(3)}%`;
const md = ['### Visual regression', '',
  'Both sides rendered from source on this runner:'
  + ` \`${baseRef.slice(0, 8)}\` (merge base) and \`${headRef.slice(0, 8)}\`.`
  + ' peerd commits no reference screenshots, so this lane reports what moved'
  + ' and leaves the call to a reviewer.', ''];
if (!notable.length) {
  md.push(`**No visual change.** All ${rows.length} screens render identically to the merge base.`);
} else {
  md.push(`**${notable.length} of ${rows.length} screens render differently.**`, '',
    '| state | theme | result | changed pixels |', '|---|---|---|---|');
  for (const r of notable) {
    md.push(`| \`${r.state}\` | ${r.theme} | ${r.verdict} | ${r.ratio == null ? '-' : pct(r.ratio)} |`);
  }
}
const REPORT_MD = join(RUNS, 'visual-vs-base.md');
writeFileSync(REPORT_MD, `${md.join('\n')}\n`);
console.log(`\n${md.join('\n')}\n`);
log(`report → ${REPORT_MD.replace(`${ROOT}/`, '')}`);

// Housekeeping: the base worktree is a build artifact, not state worth keeping.
try { execFileSync('git', ['worktree', 'remove', '--force', baseTree], { cwd: ROOT, stdio: 'pipe' }); }
catch { try { rmSync(baseTree, { recursive: true, force: true }); } catch { /* best effort */ } }
