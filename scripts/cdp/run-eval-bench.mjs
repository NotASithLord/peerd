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
//   --suite=simple|robust                    (default simple)
//   --limit=N                                run only the first N tasks (cost control)
//   --baseline=<path.json>                   diff against a prior scorecard; exit 1 on a regression
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
const LIMIT = SMOKE ? 1 : (flag('limit', false) ? Number(flag('limit', 0)) : 0);
const BASELINE = flag('baseline', false) ? String(flag('baseline', '')) : '';
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
  try {
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

    // 2) open the eval harness page + wait for its driver hook
    const evalPage = await openExtPage(ctx, 'eval/runner.html');
    if (SHOW_TABS) await evalIn(evalPage, `(() => { const c = document.getElementById('showtabs'); if (c) c.checked = true; })()`);
    const ready = await waitFor(() => evalIn(evalPage, `!!(window.__peerdEval && window.__peerdEval.ready)`), { budgetMs: 30_000 });
    if (!ready) throw new Error('eval/runner.html never exposed __peerdEval — is the runner hook present?');

    // 3) start the run (fire-and-forget in the page), then poll — a full suite
    //    outlasts a single awaited CDP call. Smoke targets ONE network-free
    //    compute task so the plumbing check is fast + deterministic.
    const runOpts = { suite: SUITE };
    if (SMOKE) runOpts.taskIds = ['clock-now'];
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
    const outPath = join(OUT_DIR, `${sha}-${modelTag}-${stamp}.json`);
    const record = {
      build: sha, provider: PROVIDER, model: MODEL || null, suite: SUITE,
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
      printDelta(compare(base.card ?? base, card));
      regressed = compare(base.card ?? base, card).regressions.length > 0;
    }

    ctx.close();
    process.exit(SMOKE ? 0 : (regressed ? 1 : 0));
  } catch (e) {
    console.error('[bench]', e?.message || e);
    try { ctx.close(); } catch { /* */ }
    process.exit(1);
  }
}

function printCard(card) {
  log('=== SCORECARD ===');
  log(`passRate ${card.passRate}% (${card.passed}/${card.total})  ·  avg ${card.avgSteps} steps  ·  MAIN ${card.avgFreshTokens} fresh + ${card.avgCacheReadTokens} cache  ·  $${card.avgCostUsd}/task  ·  ${(card.avgDurationMs / 1000).toFixed(1)}s`);
  if (card.failures?.length) log(`failures (${card.failures.length}): ${card.failures.map((f) => f.id).join(', ')}`);
}

function printDelta(d) {
  log('=== Δ vs baseline ===');
  const s = (n) => (n >= 0 ? `+${n}` : `${n}`);
  log(`passRate ${s(d.passRateDelta)}%  ·  fresh ${s(d.freshTokensDelta)} tok  ·  $/task ${s(d.costUsdDelta)}  ·  steps ${s(d.stepsDelta)}`);
  if (d.regressions.length) log(`⚠ REGRESSIONS (${d.regressions.length}): ${d.regressions.join(', ')}`);
  else log(`✓ no regressions${d.fixes.length ? `  ·  fixed: ${d.fixes.join(', ')}` : ''}`);
}
