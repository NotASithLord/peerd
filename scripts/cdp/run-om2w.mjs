#!/usr/bin/env bun
// scripts/cdp/run-om2w.mjs — run peerd against Online-Mind2Web and EXPORT the
// schema-v2 trajectories WebJudge scores.
//
// Reuses the real eval loop (run-eval-bench's launchPeerd + __peerdEval), but in
// OM2W mode: it sends inline tasks (startUrl=website, prompt=task_description),
// the runner records per-action screenshots + Grammar A actions (om2w-recorder),
// and this driver writes one `<task_id>/result.json` + `trajectory/NNNN.jpg`
// directory per task under scripts/cdp/om2w/out/<run>/. Tasks are SHARDED and
// RESUMABLE (a task whose result.json already exists is skipped) because a full
// 300 is hours of wall-clock, past any single budget.
//
// Then score offline with the OM2W repo:
//   bash script/eval.sh   # MODEL=o4-mini, TRAJECTORIES_DIR=<out/run>, API_KEY=$OPENAI...
//
// Usage:
//   PEERD_BENCH_KEY=sk-ant-... bun scripts/cdp/run-om2w.mjs --model=claude-opus-4-8 --offset=0 --count=5
// Flags: --provider (anthropic|openrouter), --model, --offset, --count (shard),
//   --run=<name> (output subdir; default the dataset revision), --show-tabs,
//   --budget-min (default 90), --task-timeout-min (default 5).

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPeerd, openExtPage, rpc, evalIn, waitFor, log, PASSPHRASE, sseText, sseToolCall } from './e2e-harness.mjs';
import { buildResult, validateResult, shotName } from './om2w/result-builder.mjs';
import { startWebFixtureServer } from './fixtures/web-suite.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(__dirname, 'om2w', 'data', 'tasks.json');
const OUT_ROOT = resolve(__dirname, 'om2w', 'out');

const argv = process.argv.slice(2);
const flag = (n, d) => { const h = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`)); if (!h) return d; const i = h.indexOf('='); return i === -1 ? true : h.slice(i + 1); };

// --smoke: prove the WHOLE pipeline (real navigate/click events → recorder →
// screenshots → schema-valid export) for $0 — a wire-fake agent drives the local
// fixture site; no gated dataset, no key, no cost. passRate is irrelevant.
const SMOKE = !!flag('smoke', false);
const PROVIDER = String(flag('provider', SMOKE ? 'ollama' : 'anthropic'));
const MODEL = flag('model', false) ? String(flag('model', '')) : '';
const OFFSET = Number(flag('offset', 0));
const COUNT = Number(flag('count', 5));
const SHOW_TABS = !!flag('show-tabs', false);
const RUN_BUDGET_MS = Number(flag('budget-min', 90)) * 60_000;
const TASK_TIMEOUT_MS = Number(flag('task-timeout-min', 5)) * 60_000;
const KEY = process.env.PEERD_BENCH_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY || '';

if (!SMOKE && !existsSync(DATA)) { console.error(`[om2w] no tasks at ${DATA} — run: HF_TOKEN=... bun scripts/cdp/om2w/fetch-tasks.mjs`); process.exit(2); }
if (!SMOKE && !KEY) { console.error('[om2w] no provider key — set PEERD_BENCH_KEY (or ANTHROPIC_API_KEY / OPENROUTER_API_KEY).'); process.exit(2); }

const { revision, tasks: ALL } = SMOKE
  ? { revision: 'smoke000', tasks: [] }   // real tasks are synthesized after the fixture starts
  : JSON.parse(readFileSync(DATA, 'utf8'));
const RUN = String(flag('run', revision.slice(0, 8)));
const OUT = join(OUT_ROOT, RUN);

main();

async function main() {
  // --smoke: a wire-fake tool-call web actor drives the local fixture (navigate
  // → click), so the recorder/export path runs for real with no dataset/key/cost.
  let fixture = null;
  let todo;
  let modelResponder;
  if (SMOKE) {
    fixture = await startWebFixtureServer();
    todo = [{ task_id: 'smoke_fixture_products', website: `${fixture.url}/products`, task_description: 'Open a product and report its name.', reference_length: 4 }];
    let orchDelegated = false; let actorTurn = 0;
    modelResponder = (_i, request) => {
      const body = (request && request.postData) || '';
      if (body.includes('<actor_agent>')) {
        const t = actorTurn++;
        if (t === 0) return { sse: sseToolCall('navigate', { url: `${fixture.url}/products` }) };
        if (t === 1) return { sse: sseToolCall('click', { selector: 'a[href="/contact"]' }) };
        return { sse: sseText('Opened the products page and clicked Contact.') };
      }
      if (!orchDelegated) { orchDelegated = true; return { sse: sseToolCall('message_actor', { to: 'web', message: 'open the products page and click a link' }) }; }
      return { sse: sseText('Done — drove the products page.') };
    };
    log(`SMOKE — wire-fake against ${fixture.url}; no dataset, no key, no cost.`);
  } else {
    const shard = ALL.slice(OFFSET, OFFSET + COUNT);
    log(`OM2W ${revision.slice(0, 8)} — tasks ${OFFSET}..${OFFSET + shard.length - 1} of ${ALL.length}, model=${MODEL || PROVIDER} → ${OUT}`);
    todo = shard.filter((t) => !existsSync(join(OUT, t.task_id, 'result.json')));   // resumable
    log(`${shard.length - todo.length} already exported; ${todo.length} to run`);
    if (!todo.length) { log('nothing to do'); process.exit(0); }
  }

  const ctx = await launchPeerd(modelResponder ? { modelResponder } : {});
  try {
    const vault = await rpc(ctx.page, { type: 'vault/initialize', passphrase: PASSPHRASE });
    if (!vault?.ok) throw new Error(`vault/initialize failed: ${JSON.stringify(vault)}`);
    await rpc(ctx.page, { type: 'onboarding/complete', peerName: 'peerd', facts: null });
    if (SMOKE) {
      await rpc(ctx.page, { type: 'settings/update', patch: { providerName: 'ollama' } });
    } else {
      const set = await rpc(ctx.page, { type: 'provider/setKey', provider: PROVIDER, plaintext: KEY });
      if (!set?.ok) throw new Error(`provider/setKey failed: ${JSON.stringify(set)}`);
      const patch = { providerName: PROVIDER };
      if (MODEL) patch.providerModel = MODEL;
      await rpc(ctx.page, { type: 'settings/update', patch });
    }
    log(`provider ready: ${PROVIDER}${MODEL ? ` (${MODEL})` : ''}`);

    const evalPage = await openExtPage(ctx, 'eval/runner.html');
    if (SHOW_TABS) await evalIn(evalPage, `(() => { const c = document.getElementById('showtabs'); if (c) c.checked = true; })()`);
    if (!await waitFor(() => evalIn(evalPage, `!!(window.__peerdEval && window.__peerdEval.ready)`), { budgetMs: 30_000 })) {
      throw new Error('eval/runner.html never exposed __peerdEval');
    }

    // ONE task per __peerdEval.run() call — an OM2W task can take minutes and we
    // want each trajectory exported immediately (resumable), not held to the end.
    const started = Date.now();
    let done = 0;
    for (const t of todo) {
      if (Date.now() - started > RUN_BUDGET_MS) { log(`budget reached; stopping after ${done} task(s)`); break; }
      const runOpts = { om2w: true, tasks: [{ id: t.task_id, title: t.task_id, startUrl: t.website, prompt: t.task_description, timeoutMs: TASK_TIMEOUT_MS, reference_length: t.reference_length }] };
      await evalIn(evalPage, `(() => { window.__peerdEval.run(${JSON.stringify(runOpts)}); return true; })()`);
      const card = await waitFor(async () => {
        const err = await evalIn(evalPage, `window.__peerdEval.lastError`);
        if (err) throw new Error(`in-page: ${err}`);
        return evalIn(evalPage, `window.__peerdEval.lastCard`);
      }, { budgetMs: TASK_TIMEOUT_MS + 60_000, pollMs: 3_000 });
      if (!card) { log(`  ✗ ${t.task_id}: no result within budget`); continue; }
      const results = await evalIn(evalPage, `window.__peerdEval.lastResults`);
      const row = (results || [])[0];
      exportTask(t, row);
      done++;
    }

    log(`\nexported ${done} task(s) → ${OUT}`);
    if (!SMOKE) log('score offline with the OM2W repo: bash script/eval.sh  (MODEL=o4-mini, TRAJECTORIES_DIR=' + OUT + ', OpenAI key)');
    if (fixture) await fixture.close().catch(() => {});
    ctx.close();
    process.exit(0);
  } catch (e) {
    console.error('[om2w]', e?.message || e);
    if (fixture) await fixture.close().catch(() => {});
    try { ctx.close(); } catch { /* */ }
    process.exit(1);
  }
}

function exportTask(task, row) {
  const dir = join(OUT, task.task_id);
  const traj = join(dir, 'trajectory');
  mkdirSync(traj, { recursive: true });
  const rec = row?.om2w;
  if (SMOKE) log(`  [smoke] agent tools: [${(row?.tools || []).join(' ')}]  recorded actions: ${rec?.actions?.length ?? 0}`);
  if (!rec) { log(`  ✗ ${task.task_id}: no trajectory (agent/send rejected or errored: ${row?.error ?? 'unknown'})`); return; }

  const actions = rec.actions.map((a) => ({ ...a, screenshotExt: 'jpg' }));
  const result = buildResult(
    { task_id: task.task_id, task_description: task.task_description, reference_length: task.reference_length },
    actions, rec.finalAnswer, { finalScreenshotExt: 'jpg' },
  );
  const errs = validateResult(result);
  if (errs.length) log(`  ⚠ ${task.task_id}: result.json has ${errs.length} schema issue(s): ${errs.slice(0, 3).join('; ')}`);

  // Screenshots: rec.shots are data URLs (one per action + the final), zero-padded
  // to sort into step order. A blank shot (capture failed at a load boundary) is
  // written as a 1x1 placeholder so every step still resolves to a file — the
  // recorder never drops the ACTION for a failed screenshot.
  const PLACEHOLDER = Buffer.from('/9j/4AAQSkZJRgABAQEAAAAAAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
  let blanks = 0;
  rec.shots.forEach((dataUrl, i) => {
    const b64 = String(dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
    const bytes = b64 ? Buffer.from(b64, 'base64') : (blanks++, PLACEHOLDER);
    writeFileSync(join(traj, shotName(i, 'jpg')), bytes);
  });
  if (blanks) log(`  ⚠ ${task.task_id}: ${blanks} screenshot(s) fell back to placeholder (capture failed at a load boundary)`);
  writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  log(`  ✓ ${task.task_id}: ${result.action_history.length} step(s), ${rec.shots.length} shot(s)${rec.capped ? ' [capped]' : ''}${errs.length ? ' [schema warns]' : ''}`);
}
