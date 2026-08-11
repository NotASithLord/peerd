#!/usr/bin/env bun
// run-e2e-verify — the single-Chrome VERIFY LOOP. Runs every state from
// states.mjs (functional + visual) against ONE Chrome (reset the session + swap
// the model responder between states), writes screenshot artifacts + a
// structured result.json an agent can READ, and prints a concise summary.
//
// THIS is the command the change→verify→fix loop invokes:
//   1. edit code
//   2. `bun run e2e:verify`
//   3. read scripts/cdp/artifacts/result.json (what passed/failed + why)
//      and the screenshots (LOOK at the rendered UI); on a visual diff, read
//      <name>-diff.png to see what moved
//   4. edit, repeat until ok:true
//
// Flags / env:
//   --functional            skip visual states (environment-independent; CI)
//   UPDATE_BASELINES=1       (re)write visual baselines instead of comparing
//
// Artifacts (gitignored) land in scripts/cdp/artifacts/:
//   <state>-<label>.png         screenshots to look at
//   <name>-current.png / -diff.png   on a visual state
//   result.json                 the structured verdict

import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPeerd, unlockAndReady, resetSession, freezeAnimations, setEmulatedTheme, capturePage, THEMES, sleep, log } from './e2e-harness.mjs';
import { STATES } from './states.mjs';
import {
  compareToBaseline, decodePng, writeDiffImage, BASELINE_DIR, UPDATE_BASELINES,
  VISUAL_PLATFORM, VISUAL_AUTHORITY, IS_AUTHORITY,
} from './visual.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ARTIFACTS = join(HERE, 'artifacts');
const FUNCTIONAL_ONLY = process.argv.includes('--functional'); // CI: env-independent
const VISUAL_ONLY = process.argv.includes('--visual');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice('--only='.length)
  .split(',').map((s) => s.trim()).filter(Boolean);

const selected = (s) => {
  if (ONLY.length) return ONLY.includes(s.name);
  if (FUNCTIONAL_ONLY) return s.kind === 'functional';
  if (VISUAL_ONLY) return s.kind === 'visual';
  return true;
};

const makeRecorder = (ctx, state) => {
  const checks = [];
  const screenshots = [];
  const visuals = [];
  return {
    check(name, pass, detail = '') {
      checks.push({ name, pass: !!pass, detail: String(detail ?? '') });
      log(`  ${pass ? 'PASS' : 'FAIL'}  [${state.name}] ${name}${detail ? ` — ${detail}` : ''}`);
    },
    async shot(label) {
      const png = await ctx.screenshot();
      const file = join(ARTIFACTS, `${state.name}-${label}.png`);
      writeFileSync(file, png);
      screenshots.push({ label, path: relative(ROOT, file) });
      return png;
    },
    async shotPage(label, page, options) {
      const png = await capturePage(page, options);
      const file = join(ARTIFACTS, `${state.name}-${label}.png`);
      writeFileSync(file, png);
      screenshots.push({ label, path: relative(ROOT, file) });
      return png;
    },
    // Compare + record ONE captured variant (a state × theme). Shared by the
    // panel-sized `visual` and the wide-page `visualPage`.
    _record(variant, base, theme, png, opts) {
      const curFile = join(ARTIFACTS, `${variant}-current.png`);
      writeFileSync(curFile, png);
      const v = compareToBaseline(variant, png, { update: UPDATE_BASELINES, ...opts });
      const entry = {
        name: variant, base, theme,
        ratio: Number(v.ratio.toFixed(5)), threshold: v.threshold,
        pass: v.pass, rawPass: v.rawPass ?? v.pass, gated: v.gated ?? true,
        platform: VISUAL_PLATFORM, wrote: v.wrote, current: relative(ROOT, curFile),
      };
      // why keyed on rawPass, not pass: off-authority `pass` is forced true, but
      // the diff image is exactly what that lane exists to produce.
      if (!v.wrote && v.dimsMatch && !entry.rawPass) {
        const baseFile = join(BASELINE_DIR, `${variant}.png`);
        const diffFile = join(ARTIFACTS, `${variant}-diff.png`);
        writeDiffImage(decodePng(readFileSync(baseFile)), decodePng(png), diffFile, opts);
        entry.baseline = relative(ROOT, baseFile);
        entry.diff = relative(ROOT, diffFile);
      }
      visuals.push(entry);
      const status = v.wrote ? 'baseline written'
        : entry.rawPass ? `OK ${(v.ratio * 100).toFixed(2)}%`
          : `DIFF ${(v.ratio * 100).toFixed(2)}% > ${(v.threshold * 100).toFixed(2)}%${entry.gated ? '' : ' (off-authority, not gating)'}`;
      log(`  ${entry.rawPass ? 'PASS' : entry.gated ? 'FAIL' : 'note'}  [${state.name}] visual:${variant} — ${status}`);
    },
    // Capture the side panel in BOTH themes. Each becomes its own baseline
    // `<name>.<theme>.png`, so the gate and the gallery both see light + dark.
    // Restores light after so any later interaction runs in the default theme.
    async visual(name, opts = {}) {
      for (const theme of THEMES) {
        await setEmulatedTheme(ctx.page, theme);
        await sleep(80); // let the CSS media switch repaint before the shot
        this._record(`${name}.${theme}`, name, theme, await ctx.screenshot(), opts);
      }
      await setEmulatedTheme(ctx.page, 'light');
    },
    // The same dual-theme capture for an arbitrary WIDE page (full-tab surfaces:
    // the home SPA, options) opened via openWidePage — the large in-browser view.
    // beforeShot(page, theme) runs after the theme switch and before the shot,
    // for a page that is still CHANGING while we capture it. why per-theme and
    // not once per state: the two captures are ~100ms apart, so a state that
    // normalises something time-varying (vm-tab-failed pins its boot-log clock)
    // has to re-normalise for the second one — otherwise whatever moved in that
    // window lands in the dark shot only, and the state flaps on dark forever.
    async visualPage(name, page, { beforeShot, ...opts } = {}) {
      for (const theme of THEMES) {
        await setEmulatedTheme(page, theme);
        await sleep(80);
        if (beforeShot) await beforeShot(page, theme);
        this._record(`${name}.${theme}`, name, theme, await capturePage(page), opts);
      }
    },
    result() {
      const ok = checks.every((c) => c.pass) && visuals.every((v) => v.pass);
      return { name: state.name, kind: state.kind, ok, checks, screenshots, visuals };
    },
  };
};

async function runState(ctx, state, results) {
  const rec = makeRecorder(ctx, state);
  if (state.responder) ctx.setModelResponder(state.responder);
  try {
    // Wide visual pages become Chrome's foreground target for capture. Put the
    // side panel back in front before the next state so headless Chrome does not
    // throttle its redraws until the eventual screenshot brings it forward.
    await ctx.page.send('Page.bringToFront').catch(() => {});
    await sleep(50);
    await state.run(ctx, rec);
  } catch (e) {
    rec.check('state ran without throwing', false, e?.message || String(e));
  }
  results.push(rec.result());
}

async function main() {
  rmSync(ARTIFACTS, { recursive: true, force: true });
  mkdirSync(ARTIFACTS, { recursive: true });

  const states = STATES.filter(selected);
  const preUnlock = states.filter((s) => s.phase === 'pre-unlock');
  const postUnlock = states.filter((s) => s.phase === 'post-unlock');
  const results = [];
  const ctx = await launchPeerd({});
  try {
    await freezeAnimations(ctx);
    for (const s of preUnlock) await runState(ctx, s, results);
    if (postUnlock.length) {
      await unlockAndReady(ctx.page);
      await freezeAnimations(ctx);
      for (const s of postUnlock) {
        await resetSession(ctx);
        await runState(ctx, s, results);
      }
    }
  } finally {
    ctx.close();
  }

  const checksTotal = results.reduce((n, r) => n + r.checks.length, 0);
  const checksFailed = results.reduce((n, r) => n + r.checks.filter((c) => !c.pass).length, 0);
  // Counted on rawPass so an off-authority run still REPORTS what moved, even
  // though those renders don't fail the exit code.
  const visualFailed = results.reduce((n, r) => n + r.visuals.filter((v) => !(v.rawPass ?? v.pass)).length, 0);
  const ok = results.every((r) => r.ok);
  const report = {
    ok,
    runAt: new Date().toISOString(),
    visual: {
      platform: VISUAL_PLATFORM,
      authority: VISUAL_AUTHORITY,
      gating: IS_AUTHORITY,
      baselineDir: relative(ROOT, BASELINE_DIR),
    },
    summary: { states: results.length, checksTotal, checksFailed, visualFailed },
    artifactsDir: relative(ROOT, ARTIFACTS),
    states: results,
  };
  writeFileSync(join(ARTIFACTS, 'result.json'), JSON.stringify(report, null, 2));

  log('');
  for (const r of results) {
    const tag = r.ok ? 'ok  ' : 'FAIL';
    const detail = r.kind === 'visual'
      ? r.visuals.map((v) => `${v.name} ${v.wrote ? 'written' : `${(v.ratio * 100).toFixed(2)}%`}`).join(', ')
      : `${r.checks.filter((c) => c.pass).length}/${r.checks.length} checks`;
    log(`  ${tag}  ${r.name} — ${detail}`);
  }
  log('');
  log(`${ok ? 'VERIFY PASSED' : 'VERIFY FAILED'} — ${results.length} states, ${checksTotal - checksFailed}/${checksTotal} checks${visualFailed ? `, ${visualFailed} visual diff(s)` : ''}`);
  if (visualFailed && !IS_AUTHORITY) {
    log(`NOTE: visual diffs above are INFORMATIONAL — ${VISUAL_PLATFORM} is not the baseline`);
    log(`authority (${VISUAL_AUTHORITY}). Look at the -diff.png files; CI decides pass/fail.`);
  }
  log(`artifacts + result.json → ${relative(ROOT, ARTIFACTS)}/`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('[e2e] verify crashed:', e?.message || e); process.exit(1); });
