#!/usr/bin/env bun
// scripts/cdp/run-eval-bench.mjs — drive the eval/lab task suite over the REAL
// extension and score one BUILD, so we can diff build-over-build instead of
// guessing whether a change helped. Reuse, not a new benchmark tool:
//   - launchPeerd (e2e-harness.mjs) loads the real unpacked extension in
//     headless Chrome for Testing,
//   - this injects a real provider key + selects the model,
//   - opens eval/runner.html and runs the suite through the page's __peerdEval
//     hook (the same runSuite the "Run all tasks" button calls),
//   - writes a commit-tagged scorecard to bench-results/,
//   - and (optionally) runs the PURE score.compare() against a baseline file to
//     surface regressions/fixes — the build-over-build signal.
//
// REAL runs make real model calls and COST MONEY, and need a real key — exactly
// the constraint the owner flagged. The score is tied to YOUR model + key + live
// page state, so a baseline is local + explicit (there's no backend to stash a
// shared one in).
//
// --smoke uses launchPeerd's keyless-Ollama wire fake (no key, no cost, no real
// model) to verify the DRIVER PLUMBING end to end — open → run → read scorecard.
// passRate will be ~0 (the faked model can't solve tasks); that's expected, the
// smoke only asserts a scorecard comes back.
//
// Usage:
//   PEERD_BENCH_KEY=sk-ant-... bun run eval:bench --provider=anthropic --model=claude-haiku-4-5
//   bun run eval:bench --provider=anthropic --model=claude-haiku-4-5 --baseline=scripts/cdp/bench-results/<prev>.json
//   bun run eval:bench --smoke           # zero-cost plumbing check
//
// Flags:
//   --provider=anthropic|openrouter|ollama   (default anthropic; smoke → ollama)
//   --model=<id>                             (default: the provider's default)
//   --suite=simple|robust|web-actor          (default simple; web-actor starts
//                                            a local fixture server + drives it)
//   --actor-surface=tools|code               web actor action surface (default: the
//                                            channel default, i.e. tools). The PR #119
//                                            A/B: run once per surface, diff with
//                                            --baseline. Tagged into the scorecard.
//   --limit=N                                run only the first N tasks (cost control)
//   --baseline=<path.json>                   diff against a prior scorecard; exit 1 on a regression
//   --guard-tool-errors                      also exit 1 if avg tool errors/task rose vs the baseline
//                                            (opt-in — off by default so an existing bench doesn't
//                                            start failing on the new axis)
//   --budget-min=N                           max minutes to wait for the run (default 45; smoke 5)
//   --show-tabs                              open the agent's eval window visibly
//   --smoke                                  keyless plumbing run (implies provider=ollama, limit=1)
// Key (real mode): PEERD_BENCH_KEY, else ANTHROPIC_API_KEY / OPENROUTER_API_KEY.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { launchPeerd, openExtPage, rpc, evalIn, waitFor, log, PASSPHRASE, sseText } from './e2e-harness.mjs';
import { compare } from '../../extension/eval/score.js';
import { startWebFixtureServer } from './fixtures/web-suite.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, 'bench-results');

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};

const SMOKE = !!flag('smoke', false);
const PROVIDER = String(flag('provider', SMOKE ? 'ollama' : 'anthropic'));
const MODEL = flag('model', false) ? String(flag('model', '')) : '';
const SUITE = String(flag('suite', 'simple'));
// PR #119 A/B: the web actor's action surface for THIS run. Empty = leave the
// channel default alone ('tools'); 'code' flips the setting before the run.
const ACTOR_SURFACE = flag('actor-surface', false) ? String(flag('actor-surface', '')) : '';
if (ACTOR_SURFACE && ACTOR_SURFACE !== 'tools' && ACTOR_SURFACE !== 'code') {
  console.error(`[bench] --actor-surface must be 'tools' or 'code' (got '${ACTOR_SURFACE}')`);
  process.exit(2);
}
const LIMIT = SMOKE ? 1 : (flag('limit', false) ? Number(flag('limit', 0)) : 0);
const BASELINE = flag('baseline', false) ? String(flag('baseline', '')) : '';
const GUARD_TOOL_ERRORS = !!flag('guard-tool-errors', false);
const SHOW_TABS = !!flag('show-tabs', false);
const RUN_BUDGET_MS = Number(flag('budget-min', SMOKE ? 5 : 45)) * 60_000;

const KEY = process.env.PEERD_BENCH_KEY
  || (PROVIDER === 'anthropic' ? process.env.ANTHROPIC_API_KEY : '')
  || (PROVIDER === 'openrouter' ? process.env.OPENROUTER_API_KEY : '')
  || '';

const shortSha = () => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'nogit'; } };
const isKeyless = (p) => p === 'ollama' || p === 'local-webgpu';

main();

async function main() {
  if (!SMOKE && !isKeyless(PROVIDER) && !KEY) {
    console.error('[bench] No provider key. Set PEERD_BENCH_KEY (or ANTHROPIC_API_KEY / OPENROUTER_API_KEY), or run with --smoke for the keyless plumbing check.');
    process.exit(2);
  }
  if (SMOKE) {
    log('SMOKE — keyless Ollama wire fake. No real model calls, no cost. Verifies the driver plumbing only (passRate will be ~0).');
  } else {
    log(`REAL benchmark — provider=${PROVIDER} model=${MODEL || '(provider default)'} suite=${SUITE}${LIMIT ? ` limit=${LIMIT}` : ''}. Makes real API calls and COSTS MONEY.`);
  }

  // In smoke mode launchPeerd intercepts the keyless model wire; a fixed no-op
  // answer is fine — we only check the driver yields a scorecard.
  const ctx = await launchPeerd(SMOKE ? { modelResponder: () => ({ sse: sseText('benchmark smoke: no-op answer.') }) } : {});
  // The web-actor suite drives a local fixture site (drift-free); start it on an
  // ephemeral port and thread the base URL into the run (the tasks carry the
  // __FIXTURE__ sentinel). Other suites don't need it.
  let fixture = null;
  try {
    if (SUITE === 'web-actor') {
      fixture = await startWebFixtureServer();
      log(`web-actor fixture server → ${fixture.url}`);
    }
    // 1) vault + provider
    const vault = await rpc(ctx.page, { type: 'vault/initialize', passphrase: PASSPHRASE });
    if (!vault?.ok) throw new Error(`vault/initialize failed: ${JSON.stringify(vault)}`);
    await rpc(ctx.page, { type: 'onboarding/complete', peerName: 'peerd', facts: null });

    if (isKeyless(PROVIDER)) {
      const patch = { providerName: PROVIDER };
      if (MODEL) patch.providerModel = MODEL;
      const upd = await rpc(ctx.page, { type: 'settings/update', patch });
      if (!upd?.ok) throw new Error(`settings/update failed: ${JSON.stringify(upd)}`);
    } else {
      const set = await rpc(ctx.page, { type: 'provider/setKey', provider: PROVIDER, plaintext: KEY });
      if (!set?.ok) throw new Error(`provider/setKey failed: ${JSON.stringify(set)}`);
      const patch = { providerName: PROVIDER };
      if (MODEL) patch.providerModel = MODEL;
      const upd = await rpc(ctx.page, { type: 'settings/update', patch });
      if (!upd?.ok) throw new Error(`settings/update failed: ${JSON.stringify(upd)}`);
    }

    const status = await rpc(ctx.page, { type: 'provider/status' });
    const usable = Array.isArray(status?.providers) && status.providers.some((p) => p.name === PROVIDER && p.hasKey);
    if (!usable) throw new Error(`provider ${PROVIDER} is not usable after setup (no key?)`);
    log(`provider ready: ${PROVIDER}${MODEL ? ` (${MODEL})` : ''}`);

    // PR #119 A/B: pin the web actor's action surface for this run. The setting
    // is read live at each actor ctx build, so setting it once up front covers
    // every task. Fail loud if the patch didn't take (a silent fallback would
    // score the WRONG arm and poison the A/B).
    if (ACTOR_SURFACE) {
      const surf = await rpc(ctx.page, { type: 'settings/update', patch: { webActorActionSurface: ACTOR_SURFACE } });
      if (!surf?.ok) throw new Error(`settings/update webActorActionSurface failed: ${JSON.stringify(surf)}`);
      log(`web actor action surface: ${ACTOR_SURFACE}`);
    }

    // 2) open the eval harness page + wait for its driver hook
    const evalPage = await openExtPage(ctx, 'eval/runner.html');
    if (SHOW_TABS) await evalIn(evalPage, `(() => { const c = document.getElementById('showtabs'); if (c) c.checked = true; })()`);
    const ready = await waitFor(() => evalIn(evalPage, `!!(window.__peerdEval && window.__peerdEval.ready)`), { budgetMs: 30_000 });
    if (!ready) throw new Error('eval/runner.html never exposed __peerdEval — is the runner hook present?');

    // 3) start the run (fire-and-forget in the page), then poll — a full suite
    //    outlasts a single awaited CDP call. Smoke targets ONE network-free
    //    compute task so the plumbing check is fast + deterministic.
    const runOpts = { suite: SUITE };
    if (fixture) runOpts.fixtureBaseUrl = fixture.url;
    // Smoke targets ONE task to keep the plumbing check fast + deterministic:
    // the network-free clock-now for the compute suites, but the FIRST web task
    // for web-actor (so the fixture nav + __FIXTURE__ substitution are exercised
    // — it still "fails" under the wire fake, which is the expected ~0 passRate).
    if (SMOKE) { if (SUITE === 'web-actor') runOpts.limit = 1; else runOpts.taskIds = ['clock-now']; }
    else if (LIMIT) runOpts.limit = LIMIT;
    await evalIn(evalPage, `(() => { window.__peerdEval.run(${JSON.stringify(runOpts)}); return true; })()`);
    log(`run started (suite=${SUITE}${LIMIT ? `, first ${LIMIT}` : ''}); polling for the scorecard (budget ${Math.round(RUN_BUDGET_MS / 60000)} min)…`);

    const card = await waitFor(async () => {
      const err = await evalIn(evalPage, `window.__peerdEval.lastError`);
      if (err) throw new Error(`eval run failed in-page: ${err}`);
      return evalIn(evalPage, `window.__peerdEval.lastCard`);
    }, { budgetMs: RUN_BUDGET_MS, pollMs: 5_000 });
    if (!card) throw new Error(`run did not finish within ${Math.round(RUN_BUDGET_MS / 60000)} min`);

    const results = await evalIn(evalPage, `window.__peerdEval.lastResults`);

    // 4) persist, tagged by commit + model
    mkdirSync(OUT_DIR, { recursive: true });
    const sha = shortSha();
    const modelTag = (MODEL || PROVIDER).replace(/[^a-z0-9.-]+/gi, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // The surface rides the filename AND the record so two A/B legs of the same
    // build+model can't be confused when diffing with --baseline.
    const surfaceTag = ACTOR_SURFACE ? `-${ACTOR_SURFACE}` : '';
    const outPath = join(OUT_DIR, `${sha}-${modelTag}${surfaceTag}-${stamp}.json`);
    const record = {
      build: sha, provider: PROVIDER, model: MODEL || null, suite: SUITE,
      actorSurface: ACTOR_SURFACE || null,
      limit: LIMIT || null, smoke: SMOKE, at: new Date().toISOString(), card, results,
    };
    writeFileSync(outPath, JSON.stringify(record, null, 2));
    log(`scorecard → ${outPath}`);

    // 5) headline + optional baseline diff
    printCard(card);
    let regressed = false;
    if (BASELINE) {
      if (!existsSync(BASELINE)) throw new Error(`baseline not found: ${BASELINE}`);
      const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
      const baseCard = base.card ?? base;
      const d = compare(baseCard, card);
      printDelta(d);
      regressed = d.regressions.length > 0;
      // Opt-in: a change can lift pass-rate while making the agent thrash more.
      // With the guard on, more tool errors/task than the baseline fails the run.
      // Skip when the baseline predates the metric — else its absent avgToolErrors
      // coerces to 0 and EVERY current error reads as a rise (false regression).
      if (GUARD_TOOL_ERRORS && baseCard.avgToolErrors === undefined) {
        log('⚠ baseline has no tool-error metrics — guard skipped; re-baseline to enable it');
      } else if (GUARD_TOOL_ERRORS && d.toolErrorsDelta > 0) {
        log(`⚠ TOOL-ERROR REGRESSION: avg tool errors/task +${d.toolErrorsDelta} (guard on)`);
        regressed = true;
      }
    }

    if (fixture) await fixture.close().catch(() => {});
    ctx.close();
    process.exit(SMOKE ? 0 : (regressed ? 1 : 0));
  } catch (e) {
    console.error('[bench]', e?.message || e);
    if (fixture) await fixture.close().catch(() => {});
    try { ctx.close(); } catch { /* */ }
    process.exit(1);
  }
}

function printCard(card) {
  log('=== SCORECARD ===');
  log(`passRate ${card.passRate}% (${card.passed}/${card.total})  ·  avg ${card.avgSteps} steps  ·  MAIN ${card.avgFreshTokens} fresh + ${card.avgCacheReadTokens} cache  ·  $${card.avgCostUsd}/task  ·  ${(card.avgDurationMs / 1000).toFixed(1)}s`);
  // The ACTOR's spend — where delegated web work (fetch_url bodies, page reads)
  // actually lands. THE number a content-pipeline change moves; the MAIN
  // buckets above barely see it.
  log(`ACTOR ${card.avgRunnerTokens} tok/task ($${card.avgRunnerCostUsd}/task)`);
  // Tool-outcome health (design 5): failed calls + the wasted-turn proxy. These
  // sit BESIDE passRate, never replace it — passRate is the correctness truth.
  if (card.avgToolCalls !== undefined) {
    log(`TOOLS ${card.avgToolErrors} err/task of ${card.avgToolCalls} calls (${(card.toolErrorRate * 100).toFixed(1)}% error rate)  ·  ${card.avgWastedTurns} wasted turns/task`);
    const worst = Object.entries(card.toolErrorsByName ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (worst.length) log(`  top failing tools: ${worst.map(([n, c]) => `${n}×${c}`).join(', ')}`);
  }
  if (card.failures?.length) log(`failures (${card.failures.length}): ${card.failures.map((f) => f.id).join(', ')}`);
}

function printDelta(d) {
  log('=== Δ vs baseline ===');
  const s = (n) => (n >= 0 ? `+${n}` : `${n}`);
  log(`passRate ${s(d.passRateDelta)}%  ·  fresh ${s(d.freshTokensDelta)} tok  ·  ACTOR ${s(d.runnerTokensDelta)} tok  ·  $/task ${s(d.costUsdDelta)}  ·  steps ${s(d.stepsDelta)}`);
  // Negative = the fix reduced errors / wasted work (the win direction).
  log(`tool-errors ${s(d.toolErrorsDelta)}/task  ·  wasted ${s(d.wastedTurnsDelta)}/task`);
  if (d.regressions.length) log(`⚠ REGRESSIONS (${d.regressions.length}): ${d.regressions.join(', ')}`);
  else log(`✓ no regressions${d.fixes.length ? `  ·  fixed: ${d.fixes.join(', ')}` : ''}`);
}
