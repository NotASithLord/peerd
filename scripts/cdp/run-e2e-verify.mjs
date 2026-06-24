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
import { launchPeerd, unlockAndReady, resetSession, freezeAnimations, log } from './e2e-harness.mjs';
import { STATES } from './states.mjs';
import { compareToBaseline, decodePng, writeDiffImage, BASELINE_DIR, UPDATE_BASELINES } from './visual.mjs';

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
    async visual(name, opts = {}) {
      const png = await ctx.screenshot();
      const curFile = join(ARTIFACTS, `${name}-current.png`);
      writeFileSync(curFile, png);
      const v = compareToBaseline(name, png, { update: UPDATE_BASELINES, ...opts });
      const entry = {
        name, ratio: Number(v.ratio.toFixed(5)), threshold: v.threshold,
        pass: v.pass, wrote: v.wrote, current: relative(ROOT, curFile),
      };
      if (!v.wrote && v.dimsMatch && !v.pass) {
        const baseFile = join(BASELINE_DIR, `${name}.png`);
        const diffFile = join(ARTIFACTS, `${name}-diff.png`);
        writeDiffImage(decodePng(readFileSync(baseFile)), decodePng(png), diffFile, opts);
        entry.baseline = relative(ROOT, baseFile);
        entry.diff = relative(ROOT, diffFile);
      }
      visuals.push(entry);
      const status = v.wrote ? 'baseline written'
        : v.pass ? `OK ${(v.ratio * 100).toFixed(2)}%`
          : `DIFF ${(v.ratio * 100).toFixed(2)}% > ${(v.threshold * 100).toFixed(0)}%`;
      log(`  ${v.pass ? 'PASS' : 'FAIL'}  [${state.name}] visual:${name} — ${status}`);
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
  const visualFailed = results.reduce((n, r) => n + r.visuals.filter((v) => !v.pass).length, 0);
  const ok = results.every((r) => r.ok);
  const report = {
    ok,
    runAt: new Date().toISOString(),
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
  log(`artifacts + result.json → ${relative(ROOT, ARTIFACTS)}/`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('[e2e] verify crashed:', e?.message || e); process.exit(1); });
