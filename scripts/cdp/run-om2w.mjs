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
// Then score offline (WebJudge / o4-mini) with the sibling helper — it clones
// the pinned upstream scorer, provisions a venv, and reports the pass rate:
//   OPENAI_API_KEY=sk-... bun scripts/cdp/om2w/score.mjs --run=<run>
//
// Usage:
//   PEERD_BENCH_KEY=sk-ant-... bun scripts/cdp/run-om2w.mjs --model=claude-opus-4-8 --offset=0 --count=5
// Flags: --provider (anthropic|openrouter), --model, --offset, --count (shard),
//   --run=<name> (output subdir; default the dataset revision), --show-tabs,
//   --budget-min (default 90), --task-timeout-min (default 5),
//   --recycle-every=<N> (relaunch Chrome every N tasks + after any timeout to
//   wipe accumulated hung-actor/debugger/tab state; default 2, 0 disables),
//   --max-consec-timeouts=<N> (bail after N timeouts across recycles; default 4),
//   --actor-surface=tools|code (web-actor A/B, #119; 'code' writes to a
//   separate <run>-code dir so both arms can be scored side by side).

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
// Web-actor action surface A/B (#119): 'tools' (discrete click/type/navigate) vs
// 'code' (page_code writes JS). Unset = the extension default ('tools'). The two
// arms write to SEPARATE output dirs (…-code) so the same shard can be run on
// both and scored side by side.
const ACTOR_SURFACE = flag('actor-surface', false) ? String(flag('actor-surface', '')) : '';
if (ACTOR_SURFACE && ACTOR_SURFACE !== 'tools' && ACTOR_SURFACE !== 'code') { console.error("[om2w] --actor-surface must be 'tools' or 'code'"); process.exit(2); }
const KEY = process.env.PEERD_BENCH_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY || '';

if (!SMOKE && !existsSync(DATA)) { console.error(`[om2w] no tasks at ${DATA} — run: HF_TOKEN=... bun scripts/cdp/om2w/fetch-tasks.mjs`); process.exit(2); }
if (!SMOKE && !KEY) { console.error('[om2w] no provider key — set PEERD_BENCH_KEY (or ANTHROPIC_API_KEY / OPENROUTER_API_KEY).'); process.exit(2); }

const { revision, tasks: ALL } = SMOKE
  ? { revision: 'smoke000', tasks: [] }   // real tasks are synthesized after the fixture starts
  : JSON.parse(readFileSync(DATA, 'utf8'));
const RUN = String(flag('run', ACTOR_SURFACE === 'code' ? `${revision.slice(0, 8)}-code` : revision.slice(0, 8)));
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
        // --actor-surface=code: the actor's ONE action tool is page_code; its
        // inner page.* ops must surface as page/op events → recorder steps.
        // This is the $0 proof of the code-arm trajectory path end to end.
        if (ACTOR_SURFACE === 'code') {
          if (t === 0) return { sse: sseToolCall('page_code', { code: `await page.goto(${JSON.stringify(`${fixture.url}/products`)}); await page.click('a[href="/contact"]'); return 'clicked';` }) };
          return { sse: sseText('Drove the products page via page_code.') };
        }
        if (t === 0) return { sse: sseToolCall('navigate', { url: `${fixture.url}/products` }) };
        if (t === 1) return { sse: sseToolCall('click', { selector: 'a[href="/contact"]' }) };
        return { sse: sseText('Opened the products page and clicked Contact.') };
      }
      if (!orchDelegated) { orchDelegated = true; return { sse: sseToolCall('message_actor', { to: 'web', message: 'open the products page and click a link' }) }; }
      return { sse: sseText('Done — drove the products page.') };
    };
    log(`SMOKE — wire-fake against ${fixture.url}${ACTOR_SURFACE ? ` (${ACTOR_SURFACE} surface)` : ''}; no dataset, no key, no cost.`);
  } else {
    const shard = ALL.slice(OFFSET, OFFSET + COUNT);
    log(`OM2W ${revision.slice(0, 8)} — tasks ${OFFSET}..${OFFSET + shard.length - 1} of ${ALL.length}, model=${MODEL || PROVIDER} → ${OUT}`);
    todo = shard.filter((t) => !existsSync(join(OUT, t.task_id, 'result.json')));   // resumable
    log(`${shard.length - todo.length} already exported; ${todo.length} to run`);
    if (!todo.length) { log('nothing to do'); process.exit(0); }
  }

  // Launch Chrome + bring peerd to a ready-to-run state (vault, provider, the
  // eval page). Factored out so the run can RECYCLE the whole browser mid-run.
  // why: a long-lived session accumulates un-reaped hung web-actor turns +
  // debugger attachments + tabs (product bug — an un-timed CDP Runtime.evaluate
  // can hang a turn forever, and the abort isn't honored mid-dispatch; tracked
  // in NotASithLord/peerd#176). That state is SW-/Chrome-process-scoped, so only a fresh Chrome
  // clears it. Recycling on a cadence keeps every task running against a clean
  // browser instead of a degrading one.
  async function bringUp() {
    const c = await launchPeerd(modelResponder ? { modelResponder } : {});
    const vault = await rpc(c.page, { type: 'vault/initialize', passphrase: PASSPHRASE });
    if (!vault?.ok) throw new Error(`vault/initialize failed: ${JSON.stringify(vault)}`);
    await rpc(c.page, { type: 'onboarding/complete', peerName: 'peerd', facts: null });
    if (SMOKE) {
      // The surface applies to the smoke too — the code-arm smoke is the $0
      // proof of the page/op recording path, which needs the setting live.
      await rpc(c.page, { type: 'settings/update', patch: { providerName: 'ollama', ...(ACTOR_SURFACE ? { webActorActionSurface: ACTOR_SURFACE } : {}) } });
    } else {
      const set = await rpc(c.page, { type: 'provider/setKey', provider: PROVIDER, plaintext: KEY });
      if (!set?.ok) throw new Error(`provider/setKey failed: ${JSON.stringify(set)}`);
      const patch = { providerName: PROVIDER };
      if (MODEL) patch.providerModel = MODEL;
      if (ACTOR_SURFACE) patch.webActorActionSurface = ACTOR_SURFACE;
      await rpc(c.page, { type: 'settings/update', patch });
    }
    const page = await openExtPage(c, 'eval/runner.html');
    if (SHOW_TABS) await evalIn(page, `(() => { const el = document.getElementById('showtabs'); if (el) el.checked = true; })()`);
    if (!await waitFor(() => evalIn(page, `!!(window.__peerdEval && window.__peerdEval.ready)`), { budgetMs: 30_000 })) {
      throw new Error('eval/runner.html never exposed __peerdEval');
    }
    return { ctx: c, evalPage: page };
  }

  // A dead CDP connection (SW hung / Chrome half-up after a recycle) makes any
  // rpc/evalIn await FOREVER — the harness's conn.send has no timeout, and one
  // such hang stranded a run overnight at "side panel mounted". Bound every
  // driver await; on a deadline the caller tears Chrome down and retries.
  const withDeadline = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)),
  ]);
  const BRINGUP_DEADLINE_MS = 120_000;

  let ctx = null;
  let evalPage = null;
  try {
    ({ ctx, evalPage } = await withDeadline(bringUp(), BRINGUP_DEADLINE_MS, 'bringUp'));
    log(`provider ready: ${PROVIDER}${MODEL ? ` (${MODEL})` : ''}${ACTOR_SURFACE ? ` · actor surface: ${ACTOR_SURFACE}` : ''}`);

    // ONE task per __peerdEval.run() call — an OM2W task can take minutes and we
    // want each trajectory exported immediately (resumable), not held to the end.
    const started = Date.now();
    let done = 0;
    // Recycle Chrome to WIPE the accumulated hung-actor / debugger / tab state
    // that wedges a long-lived session: proactively every N tasks AND immediately
    // after any timeout (a timeout may have left a hung actor behind). Resumable:
    // exported tasks already have result.json, so we just rebuild the browser and
    // continue with the next task in the shard. --recycle-every=0 disables it.
    // Default 2: the wedge is empirically "2 clean tasks, then the 3rd wedges,"
    // so recycling AFTER every 2 keeps each Chrome to 2 clean tasks and never
    // reaches the 3rd — avoiding the 6-min timeout entirely (vs. 3, which would
    // still eat one timeout per window). ~15 recycles over 30 tasks (~4 min).
    const RECYCLE_EVERY = Number(flag('recycle-every', 2));
    // Circuit breaker: if even freshly-recycled Chromes time out N in a row, the
    // wedge has some OTHER cause — bail rather than burn the budget on a wall.
    const MAX_CONSEC_TIMEOUTS = Number(flag('max-consec-timeouts', 4));
    let consecTimeouts = 0;
    let sinceRecycle = 0;
    const recycle = async (why) => {
      log(`  ↻ recycling Chrome (${why})`);
      try { ctx.close(); } catch { /* */ }
      try {
        ({ ctx, evalPage } = await withDeadline(bringUp(), BRINGUP_DEADLINE_MS, 'recycle bringUp'));
      } catch (e) {
        // One retry with another fresh Chrome — a flaky launch shouldn't strand
        // a resumable run. A second failure propagates (main's catch exits 1;
        // exported tasks are safe, a re-run resumes).
        log(`  ⚠ recycle failed (${/** @type {{ message?: string }} */ (e)?.message ?? e}); retrying once with a fresh Chrome`);
        try { ctx.close(); } catch { /* */ }
        ({ ctx, evalPage } = await withDeadline(bringUp(), BRINGUP_DEADLINE_MS, 'recycle bringUp (retry)'));
      }
      sinceRecycle = 0;
    };
    for (let i = 0; i < todo.length; i++) {
      const t = todo[i];
      if (Date.now() - started > RUN_BUDGET_MS) { log(`budget reached; stopping after ${done} task(s)`); break; }
      const runOpts = { om2w: true, tasks: [{ id: t.task_id, title: t.task_id, startUrl: t.website, prompt: t.task_description, timeoutMs: TASK_TIMEOUT_MS, reference_length: t.reference_length }] };
      // Harness faults (dead eval page, in-page error, hung CDP send) are
      // per-task failures, NOT run-enders: treat like a timeout so the recycle
      // + circuit-breaker machinery handles them and the shard stays resumable.
      let card = null;
      try {
        await withDeadline(
          evalIn(evalPage, `(() => { window.__peerdEval.run(${JSON.stringify(runOpts)}); return true; })()`),
          30_000, 'task launch');
        card = await withDeadline(waitFor(async () => {
          const err = await evalIn(evalPage, `window.__peerdEval.lastError`);
          if (err) throw new Error(`in-page: ${err}`);
          return evalIn(evalPage, `window.__peerdEval.lastCard`);
        }, { budgetMs: TASK_TIMEOUT_MS + 60_000, pollMs: 3_000 }), TASK_TIMEOUT_MS + 90_000, 'task wait');
      } catch (e) {
        log(`  ⚠ ${t.task_id}: harness fault (${/** @type {{ message?: string }} */ (e)?.message ?? e}) — treating as a timeout`);
        card = null;
      }
      let timedOut = false;
      if (!card) {
        log(`  ✗ ${t.task_id}: no result within budget`);
        timedOut = true;
        if (++consecTimeouts >= MAX_CONSEC_TIMEOUTS) {
          log(`\n⚠ ${consecTimeouts} consecutive timeouts even across Chrome recycles — the wedge has another cause; stopping to save budget. Timed-out tasks wrote no result.json, so a later resume retries them.`);
          break;
        }
      } else {
        consecTimeouts = 0;
        const results = await withDeadline(evalIn(evalPage, `window.__peerdEval.lastResults`), 30_000, 'results read').catch(() => null);
        exportTask(t, (results || [])[0]);
        done++;
      }
      sinceRecycle++;
      const isLast = i === todo.length - 1;
      if (!isLast && RECYCLE_EVERY > 0 && (timedOut || sinceRecycle >= RECYCLE_EVERY)) {
        await recycle(timedOut ? 'after timeout' : `every ${RECYCLE_EVERY} tasks`);
      }
    }

    log(`\nexported ${done} task(s) → ${OUT}`);
    if (!SMOKE) log(`score it (WebJudge/o4-mini): OPENAI_API_KEY=sk-... bun scripts/cdp/om2w/score.mjs --run=${RUN}`);
    if (fixture) await fixture.close().catch(() => {});
    ctx.close();
    process.exit(0);
  } catch (e) {
    console.error('[om2w]', e?.message || e);
    if (fixture) await fixture.close().catch(() => {});
    try { ctx?.close(); } catch { /* */ }
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
