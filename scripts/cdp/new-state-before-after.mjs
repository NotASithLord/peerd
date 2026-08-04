#!/usr/bin/env bun
// new-state-before-after — the one comparison the pixel gate structurally cannot make.
//
// THE HOLE. A baseline only exists once someone commits one. So a PR that ADDS a
// visual state has nothing to compare against: the state is seeded from that same
// branch and passes trivially, and the PR reports "no visual drift" for a screen
// nobody had ever photographed. That is not a hypothetical — PR #294 rebuilt the
// whole Behavior and Denylist pages (7–23% of pixels) and the gate reported no
// drift, correctly and uselessly, because neither page had a baseline.
//
// THE FIX. For states with no committed baseline, compute the "before" instead of
// reading it: render the SAME state definitions against the merge-base's
// extension code. peerd has no build step, so "check out the base and render it"
// is a checkout plus a harness run — cheap enough to do per PR, and impossible in
// a project that has to compile first.
//
// why the merge-base and not origin/main: main moves. Diffing against its HEAD
// attributes everything that landed while you were branched to your PR.
//
// This does NOT replace the committed baselines. Those stay the approved-look
// record (and the gallery), and they carry the human checkpoint a computed
// baseline cannot: with main-as-truth, a bad render that lands silently becomes
// the new correct. This only covers the case where there is no record yet.
//
// Usage:
//   bun scripts/cdp/new-state-before-after.mjs [--base <ref>] [--force <state,…>]
// Writes <state>.<theme>.{before,after,diff}.png + new-state-report.json into
// scripts/cdp/artifacts/, and prints a markdown table on stdout.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { launchPeerd, unlockAndReady, resetSession, setEmulatedTheme, capturePage, THEMES, sleep, log } from './e2e-harness.mjs';
import { STATES } from './states.mjs';
import { VISUAL_AUTHORITY, decodePng, comparePixels, writeDiffImage } from './visual.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const ARTIFACTS = join(HERE, 'artifacts');

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};
const forced = new Set((arg('--force') || '').split(',').map((s) => s.trim()).filter(Boolean));

// The merge-base is both the build we render the "before" against AND the
// reference that decides which states are new (see isNew below), so it is
// resolved first. Rationale for the merge-base itself is in the header.
const baseRef = arg('--base') || execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();

// A state is "new" when THE MERGE BASE has no committed PNG for it.
//
// why the base and not the working tree: because the question is "did the gate
// have anything to compare this against", and the gate's answer was fixed
// before the PR existed. A PR that adds a state AND commits its baseline — the
// normal way to add one — has the file present locally, so a working-tree check
// calls it established and skips it. That is precisely the case this script
// exists for: the render step then compares the new state against the PR's OWN
// baseline and passes, which is the trivial pass, not a comparison. (Found on
// #294, which added options-behavior + options-denylist with baselines and so
// went undetected until it was forced by hand.)
//
// THE AUTHORITY's path, deliberately not the local platform's: only linux-x64
// baselines are committed, so checking the local platform would call every
// state new on a dev machine and render the entire suite twice.
const baselinePath = (name, theme) =>
  `scripts/cdp/baselines/${VISUAL_AUTHORITY}/${name}.${theme}.png`;

/** Did `path` exist, as a file, in the base commit? */
const existsAtBase = (path) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${baseRef}:${path}`], { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch {
    // Also false when the ref itself is unreachable (a too-shallow fetch). That
    // direction is the safe one: it renders a before/after that turns out to be
    // redundant, rather than silently skipping the one comparison worth making.
    return false;
  }
};

const isNew = (name) => forced.has(name)
  || THEMES.some((t) => !existsAtBase(baselinePath(name, t)));

const visualStates = STATES.filter((s) => s.kind === 'visual');
const newStates = visualStates.filter((s) => isNew(s.name));

if (newStates.length === 0) {
  log('no new visual states — every state had a committed baseline at the merge base, nothing to compute');
  process.exit(0);
}
log(`state(s) with no baseline at ${baseRef.slice(0, 8)}: ${newStates.map((s) => s.name).join(', ')}`);

// ── the "before" build ───────────────────────────────────────────────────────
// A detached worktree at the merge-base. The STATE DEFINITIONS come from this
// branch (they have to — the base does not know these states exist); only the
// EXTENSION under test comes from the base. That separation is the whole trick.
const baseTree = join(ARTIFACTS, `base-${baseRef.slice(0, 8)}`);
mkdirSync(ARTIFACTS, { recursive: true });
if (!existsSync(baseTree)) {
  log(`materialising the base build at ${baseRef.slice(0, 8)}`);
  execFileSync('git', ['worktree', 'add', '--detach', baseTree, baseRef], { cwd: ROOT, stdio: 'pipe' });
  // The manifest is generated, not committed in a runnable state for every
  // channel — regenerate it inside the base tree so it can be loaded unpacked.
  try { execFileSync('bun', ['run', 'gen:dev'], { cwd: baseTree, stdio: 'pipe' }); }
  catch (e) { log(`gen:dev in the base tree failed (continuing): ${e?.message ?? e}`); }
}

/**
 * Capture-only recorder. The real one compares against baselines; here there is
 * nothing to compare against yet, so it just writes PNGs under a given suffix.
 */
const captureRecorder = (ctx, suffix) => ({
  check: () => {},
  shot: async () => {},
  async visual(name) {
    for (const theme of THEMES) {
      await setEmulatedTheme(ctx.page, theme);
      await sleep(80);
      writeFileSync(join(ARTIFACTS, `${name}.${theme}.${suffix}.png`), await ctx.screenshot());
    }
    await setEmulatedTheme(ctx.page, 'light');
  },
  async visualPage(name, page) {
    for (const theme of THEMES) {
      await setEmulatedTheme(page, theme);
      await sleep(80);
      writeFileSync(join(ARTIFACTS, `${name}.${theme}.${suffix}.png`), await capturePage(page));
    }
  },
});

/** Render the given states against one extension build. */
const renderAgainst = async (extensionDir, suffix) => {
  const ctx = await launchPeerd({ modelResponder: () => ({ sse: '' }), extensionDir });
  try {
    await unlockAndReady(ctx.page);
    const rec = captureRecorder(ctx, suffix);
    for (const state of newStates) {
      if (state.responder) ctx.setModelResponder(state.responder);
      await resetSession(ctx).catch(() => {});
      try { await state.run(ctx, rec); }
      catch (e) { log(`  ${state.name} threw on the ${suffix} build: ${e?.message ?? e}`); }
    }
  } finally { ctx.close(); }
};

log('rendering the BEFORE (merge-base build)…');
await renderAgainst(join(baseTree, 'extension'), 'before');
log('rendering the AFTER (this branch)…');
await renderAgainst(join(ROOT, 'extension'), 'after');

// ── compare ─────────────────────────────────────────────────────────────────
const rows = [];
for (const state of newStates) {
  for (const theme of THEMES) {
    const b = join(ARTIFACTS, `${state.name}.${theme}.before.png`);
    const a = join(ARTIFACTS, `${state.name}.${theme}.after.png`);
    if (!existsSync(a)) continue;
    if (!existsSync(b)) {
      // The route did not exist on the base at all — a genuinely new screen, as
      // opposed to a new PHOTOGRAPH of an existing one. Say which it is; they
      // read identically in a diff report and mean opposite things to a reviewer.
      rows.push({ state: state.name, theme, verdict: 'new screen (absent on base)', ratio: null });
      continue;
    }
    const before = decodePng(readFileSync(b));
    const after = decodePng(readFileSync(a));
    if (before.width !== after.width || before.height !== after.height) {
      rows.push({ state: state.name, theme, verdict: `resized ${before.width}×${before.height} → ${after.width}×${after.height}`, ratio: null });
      continue;
    }
    const { ratio } = comparePixels(before, after);
    if (ratio > 0) writeDiffImage(before, after, join(ARTIFACTS, `${state.name}.${theme}.diff.png`));
    rows.push({ state: state.name, theme, verdict: ratio > 0 ? 'changed' : 'identical', ratio });
  }
}

writeFileSync(join(ARTIFACTS, 'new-state-report.json'), JSON.stringify({ baseRef, rows }, null, 2));

console.log(`### New visual states — before/after vs \`${baseRef.slice(0, 8)}\`\n`);
console.log('These states had no committed baseline, so the pixel gate could not compare them.');
console.log('The "before" is the same state rendered against the merge-base build.\n');
console.log('| state | theme | result |');
console.log('|---|---|---|');
for (const r of rows) {
  const pct = r.ratio == null ? '—' : `${(r.ratio * 100).toFixed(2)}% of pixels`;
  console.log(`| \`${r.state}\` | ${r.theme} | ${r.verdict}${r.ratio ? ` · ${pct}` : ''} |`);
}

// Housekeeping: the base worktree is a build artifact, not state worth keeping.
try { execFileSync('git', ['worktree', 'remove', '--force', baseTree], { cwd: ROOT, stdio: 'pipe' }); }
catch { try { rmSync(baseTree, { recursive: true, force: true }); } catch { /* best effort */ } }
