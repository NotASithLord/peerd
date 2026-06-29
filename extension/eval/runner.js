// @ts-check
// eval/runner — drives peerd's REAL agent stack against the task suite.
//
// This is an automated "user": it connects the same SW port the side
// panel uses (turn/* push events), sends agent/send per task, awaits the
// turn, then captures the END STATE (final tab + the agent's answer + which
// tools ran) and scores it. Same path a human triggers — so the score
// reflects the real loop, gates, tools, and model.
//
// Prereq: unlock the vault in the side panel first (the loop needs the
// provider key). Don't touch the side panel while a run is in flight — this
// page takes over the 'sidepanel' port for the duration.

import browser from '/vendor/browser-polyfill.js';
import { TASKS, SUITES } from './tasks.js';
import { aggregate, compare } from './score.js';
import { costOf } from '/peerd-provider/index.js';
import { sleep } from '/shared/util.js';

/**
 * @typedef {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, cost?: number }} Usage
 * @typedef {{ session: any, tools: string[], tokens: number, cost: Usage | null, runner: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }, error: string | null, started: boolean, resolveDone: ((value?: any) => void) | null }} Turn
 */

// The runner's own $ for a task — 'local' is FREE, a cloud runner is priced from
// its tokens. Makes "local is free" visible in the A/B.
/** @param {string} [cfg] @param {Usage} [usage] */
const priceRunnerUsd = (cfg, usage) => {
  if (!cfg || String(cfg).toLowerCase() === 'local') return 0;
  try { return costOf(cfg, /** @type {any} */ (usage))?.cost ?? 0; } catch { return 0; }
};

// Baseline = the last scorecard a dev pinned as "known good". Kept in
// localStorage (per-browser, survives reloads) — there's no backend to store it
// in, and a baseline is inherently local: it's tied to YOUR model + key + page
// state at the time you pinned it. This is how peerd answers eve's "tell me what
// a prompt/model change broke" without a server: pin a baseline, change a thing,
// re-run, read the delta + regression list.
const BASELINE_KEY = 'peerd.eval.baseline.v1';
const loadBaseline = () => { try { return JSON.parse(localStorage.getItem(BASELINE_KEY) || 'null'); } catch { return null; } };
/** @param {unknown} card */
const saveBaseline = (card) => localStorage.setItem(BASELINE_KEY, JSON.stringify(card));
const clearBaseline = () => localStorage.removeItem(BASELINE_KEY);

// The most recent run's scorecard, so "Pin as baseline" has something to pin
// without forcing a re-run.
/** @type {ReturnType<typeof aggregate> | null} */
let lastCard = null;

// why any: $ resolves one of this dev harness's mixed elements (input / select /
// button / progress / div) by static id, and callers read element-specific
// members (.value/.checked/.disabled/.options). Typing each of the ~30 sites
// individually would bury a non-shipping tool in casts; the ids are present in
// runner.html, so a null check would never fire either.
/** @param {string} id @returns {any} */
const $ = (id) => document.getElementById(id);
/** @param {string} s */
const log = (s) => { const el = $('log'); el.textContent += `${s}\n`; el.scrollTop = el.scrollHeight; };
/** @param {Usage | null | undefined} t */
const tally = (t) => t ? (t.inputTokens || 0) + (t.outputTokens || 0) + (t.cacheReadTokens || 0) + (t.cacheWriteTokens || 0) : 0;
const ZERO_COST = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, runnerTokens: 0, runnerCostUsd: 0 };
// Pull the four token buckets + USD out of the CostTally for the result row.
/** @param {Usage | null | undefined} c */
const costFields = (c) => c ? {
  inputTokens: c.inputTokens || 0, outputTokens: c.outputTokens || 0,
  cacheReadTokens: c.cacheReadTokens || 0, cacheWriteTokens: c.cacheWriteTokens || 0,
  costUsd: typeof c.cost === 'number' ? c.cost : 0,
} : { ...ZERO_COST };

// ---- per-turn state, fed by the SW push port -----------------------------
let turn = fresh();
// cost: the full CostTally pushed on turn/cost — { inputTokens, outputTokens,
// cacheReadTokens, cacheWriteTokens, cost (USD) }. We keep the whole thing so
// the scorecard can split cheap cache-reads from full-price fresh tokens and
// report actual $/task, instead of collapsing it all into one number.
// runner: tokens spent by browser-runners (do/get/check) THIS turn — separate
// from `cost` (the main session's spend). After the do/get/check cutover the
// page mechanics move off the main context into runners; this is where that
// offloaded spend shows up so the scorecard stays honest (main drops, runner
// appears — not "free").
/** @returns {Turn} */
function fresh() { return { session: null, tools: [], tokens: 0, cost: null, runner: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, error: null, started: false, resolveDone: null }; }

// 'eval' (not 'sidepanel') so an open home page doesn't think the side panel
// popped out — joins uiPorts for turn/* all the same. See service-worker onConnect.
const port = browser.runtime.connect({ name: 'eval' });
port.onMessage.addListener((/** @type {any} */ msg) => {
  switch (msg?.type) {
    case 'turn/state': turn.session = msg.session; turn.started = true; break;
    case 'turn/delta': turn.started = true; break;
    case 'turn/tool-use': turn.started = true; turn.tools.push(msg.name); break;
    case 'turn/cost': if (msg.turn) { turn.tokens = tally(msg.turn); turn.cost = msg.turn; } break;
    case 'turn/subagent-cost':
      if (msg.usage) {
        turn.runner.inputTokens += msg.usage.inputTokens || 0;
        turn.runner.outputTokens += msg.usage.outputTokens || 0;
        turn.runner.cacheReadTokens += msg.usage.cacheReadTokens || 0;
        turn.runner.cacheWriteTokens += msg.usage.cacheWriteTokens || 0;
      }
      break;
    case 'turn/error': turn.error = msg.error; break;
    case 'turn/streaming':
      if (msg.streaming) turn.started = true;
      else if (turn.started && turn.resolveDone) { const r = turn.resolveDone; turn.resolveDone = null; r(); }
      break;
    // Local-model download progress (broadcast by the SW while Gemma loads).
    case 'local-model/progress': handleDlProgress(msg.progress || {}); break;
    default: break;
  }
});

// A DEDICATED subject tab the agent drives — NEVER the runner's own tab.
// (Navigating the active tab navigated THIS page → reload → run died.)
/** @type {number | null} */
let subjectId = null;
/** @type {number | null} */
let subjectWin = null;
/** @type {number | null} */
let runnerTabId = null;
async function ensureSubject() {
  if (runnerTabId == null) {
    try { runnerTabId = (await browser.tabs.getCurrent())?.id ?? -1; } catch { runnerTabId = -1; }
  }
  // Hidden (minimized) by default so eval tabs never clutter YOUR window; the
  // "show eval tabs" checkbox (read here, at run start) opens it visible. Either
  // way focused:false → no focus theft; the agent targets the tab by id
  // (agent/send's activeTabId), and open_tab co-locates agent tabs into this window.
  /** @type {'normal' | 'minimized'} */
  const wantState = $('showtabs')?.checked ? 'normal' : 'minimized';
  // focused:false on the restore too — un-minimizing a window otherwise brings it
  // to the front (the focus-steal in visible mode). Visible = seen, never focused.
  /** @type {import('webextension-polyfill').Windows.UpdateUpdateInfoType} */
  const upd = wantState === 'normal' ? { state: 'normal', focused: false } : { state: 'minimized' };
  if (subjectId != null) {
    try {
      await browser.tabs.get(subjectId);
      if (subjectWin != null) await browser.windows.update(subjectWin, upd).catch(() => {}); // honor a toggle change since last run
      return;
    } catch { subjectId = null; } // closed → recreate
  }
  // A DEDICATED window — its own, off to the side — for everything the agent drives.
  const w = await browser.windows.create({ url: 'about:blank', focused: false, state: wantState });
  subjectId = w.tabs?.[0]?.id ?? null; subjectWin = w.id ?? null;
  log(`  (eval window ${subjectWin} created — ${wantState}; agent drives tab ${subjectId})`);
}

// (No focusSubject anymore — we target the subject tab by id via agent/send's
// activeTabId, so the eval never steals window/tab focus during a run. The
// subject was always the scored tab anyway: agent-opened tabs are active:false,
// so resolveEndTab's subject fallback returns the same tab focusing used to.)

// Tabs peerd opens DURING a task (e.g. via open_tab) LINGER in the subject
// window. Across tasks they accumulate and can steal "active" status from the
// tab the agent actually drove — so the runner scores the WRONG tab (a prior
// task's page). This bit us: selenium-multifield was scored against
// wikipedia-search's lingering Ada_Lovelace tab. We track agent-opened tabs and
// close them between tasks so each task scores a clean window. We NEVER touch
// the subject tab or the runner's own page.
/** @type {Set<number>} */
const agentTabs = new Set();
let listenersWired = false;
/** @param {any} tab */
function onAgentTabCreated(tab) {
  if (subjectWin == null || tab.windowId !== subjectWin) return; // ignore other windows (incl. before subject exists)
  if (tab.id === subjectId || tab.id === runnerTabId) return;    // never the subject tab or the runner page
  agentTabs.add(tab.id);
}
function wireListeners() {
  if (listenersWired) return;
  browser.tabs.onCreated.addListener(onAgentTabCreated);
  listenersWired = true;
}
async function closeAgentTabs() {
  for (const id of agentTabs) {
    if (id === subjectId || id === runnerTabId) continue; // belt-and-suspenders
    try { await browser.tabs.remove(id); } catch { /* already gone */ }
  }
  agentTabs.clear();
}

// The tab the agent actually ended on. CRITICAL: the runner's OWN page shares
// the subject window (ensureSubject creates the subject tab in the runner's
// current window), and on a long turn the runner page can win back "active"
// status by scoring time — so a naive query({active:true}) returns the runner's
// chrome-extension:// URL (the selenium-multifield false-fail). So we EXCLUDE
// the runner page and pick, among the window's other tabs, the active one, else
// the most-recently-accessed, else the subject tab itself. (Named resolveEndTab,
// NOT endTab — there's a local `endTab`-style usage; don't shadow.)
async function resolveEndTab() {
  /** @type {any[]} */
  let tabs = [];
  try { tabs = await browser.tabs.query({ windowId: subjectWin ?? undefined }); } catch { /* window gone */ }
  const candidates = tabs.filter((/** @type {any} */ t) => t.id != null && t.id !== runnerTabId);
  if (candidates.length) {
    candidates.sort((/** @type {any} */ a, /** @type {any} */ b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return candidates.find((/** @type {any} */ t) => t.active) || candidates[0];
  }
  try { return subjectId == null ? null : await browser.tabs.get(subjectId); } catch { return null; }
}

// Let a TERMINAL navigation finish before scoring. A click/submit that
// navigates ends the turn while the new page is still loading — reading
// immediately would score the OLD url. Grace + wait-for-complete (on the
// agent's end tab, not whatever happens to be active).
async function settleSubject() {
  await sleep(1200);
  const tab = await resolveEndTab();
  if (!tab || tab.status === 'complete') return;
  await /** @type {Promise<void>} */ (new Promise((resolve) => {
    const fin = () => { browser.tabs.onUpdated.removeListener(onUpd); resolve(); };
    const onUpd = (/** @type {any} */ id, /** @type {any} */ info) => { if (id === tab.id && info.status === 'complete') fin(); };
    browser.tabs.onUpdated.addListener(onUpd);
    setTimeout(fin, 6000);
  }));
}

/** @param {number} tabId @param {string} url */
async function navigateTab(tabId, url) {
  await browser.tabs.update(tabId, { url });
  await /** @type {Promise<void>} */ (new Promise((resolve) => {
    const done = () => { browser.tabs.onUpdated.removeListener(onUpd); resolve(); };
    const onUpd = (/** @type {any} */ id, /** @type {any} */ info) => { if (id === tabId && info.status === 'complete') done(); };
    browser.tabs.onUpdated.addListener(onUpd);
    setTimeout(done, 20_000);
  }));
}

/** @param {number} tabId */
async function readTab(tabId) {
  let url = '', title = '', text = '';
  try { const t = await browser.tabs.get(tabId); url = t.url || ''; title = t.title || ''; } catch { /* gone */ }
  try {
    const r = await browser.scripting.executeScript({
      target: { tabId },
      func: () => ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').slice(0, 3000),
    });
    // why the cast: executeScript types .result as unknown; the injected func
    // returns a string, so coerce to keep `text` a string.
    text = /** @type {string} */ (r?.[0]?.result) || '';
  } catch { /* restricted page */ }
  return { url, title, text };
}

/** @param {any} session */
function finalAnswer(session) {
  const msgs = session?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return '';
}

/** @param {any} task @param {string} [runnerCfg] */
async function runTask(task, runnerCfg) {
  turn = fresh();
  log(`\n▶ ${task.id} — ${task.title}`);
  await browser.runtime.sendMessage({ type: 'session/reset' });
  await closeAgentTabs(); // clear tabs peerd opened in PRIOR tasks → clean window to score
  // subjectId is set by ensureSubject before any task runs; cast off the null.
  const subjId = /** @type {number} */ (subjectId);
  if (task.startUrl) { log(`  nav → ${task.startUrl}`); await navigateTab(subjId, task.startUrl); }

  /** @type {Promise<void>} */
  const donePromise = new Promise((res) => { turn.resolveDone = res; });
  const start = Date.now();
  // activeTabId pins the agent to the subject tab without focusing it — the SW's
  // buildToolContext uses tabs.get(activeTabId) instead of the active-tab query.
  const reply = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'agent/send', text: task.prompt, activeTabId: subjId }));
  if (!reply?.ok) {
    const detail = `agent/send rejected: ${reply?.error}`;
    log(`  ✗ ${detail}`);
    return { id: task.id, pass: false, detail, error: reply?.error, steps: 0, tokens: 0, ...ZERO_COST, durationMs: 0, tools: [] };
  }
  await Promise.race([donePromise, sleep(task.timeoutMs ?? 90_000)]);
  const durationMs = Date.now() - start;
  const timedOut = !!turn.resolveDone;
  turn.resolveDone = null;
  if (timedOut) log('  ⏱ timed out (still scoring end state)');

  await settleSubject();
  // Resolve the tab the agent actually ended on — NEVER the runner's own page
  // (see resolveEndTab), which otherwise scores a chrome-extension:// URL.
  const end = await resolveEndTab();
  const tabInfo = await readTab(end?.id ?? subjId);
  const state = {
    tabUrl: tabInfo.url, tabTitle: tabInfo.title, tabText: tabInfo.text,
    answer: finalAnswer(turn.session), steps: turn.tools.length, tools: turn.tools,
    tokens: turn.tokens, durationMs, error: turn.error || (timedOut ? 'timeout' : null),
  };
  let res;
  try { res = task.check(state); } catch (e) { res = { pass: false, detail: `check threw: ${/** @type {{ message?: string }} */ (e)?.message ?? e}` }; }
  const cost = costFields(turn.cost);
  // why: NOT named `fresh` — there's a module-level `function fresh()` (the
  // per-turn state factory). A local `const fresh` would shadow it across this
  // whole function (TDZ), breaking `turn = fresh()` at the top of runTask.
  const freshTok = cost.inputTokens + cost.outputTokens; // full-price input+output (MAIN context)
  const runnerTokens = turn.runner.inputTokens + turn.runner.outputTokens + turn.runner.cacheReadTokens + turn.runner.cacheWriteTokens;
  const runnerCostUsd = priceRunnerUsd(runnerCfg, turn.runner);
  log(`  ${res.pass ? '✓ PASS' : '✗ FAIL'} — ${res.detail}  [${state.steps} steps · main ${freshTok} fresh + ${cost.cacheReadTokens} cache · runner ${runnerTokens} tok ($${runnerCostUsd.toFixed(4)}) · main $${cost.costUsd.toFixed(4)} · ${(durationMs / 1000).toFixed(1)}s]`);
  // why: per-task observability. The scorecard's failure rows only carry
  // id/detail/error — not WHICH tools ran or what the agent concluded. For a
  // failure like "1 step, ended on the start page", that's exactly the missing
  // signal. So always log the tool sequence, and on a failure dump the agent's
  // final answer (it usually explains what the agent THOUGHT it did).
  log(`       tools: [${state.tools.join(' → ') || '—'}]`);
  if (!res.pass && state.answer) log(`       agent said: "${state.answer.slice(0, 240).replace(/\s+/g, ' ')}"`);
  return { id: task.id, pass: res.pass, detail: res.detail, error: state.error, steps: state.steps, tokens: state.tokens, ...cost, runnerTokens, runnerCostUsd, durationMs, tools: state.tools };
}

// why: lead with the honest cost split — fresh (full-price input+output, the
// real $ + context-pressure driver) vs cache-read (the static system-prompt +
// tool schemas, re-read each turn but billed ~10%) — plus actual $/task. A
// single collapsed "tokens" number hides which problem a high count is.
/** @param {ReturnType<typeof aggregate>} card */
const scoreLine = (card) => `passRate ${card.passRate}%  (${card.passed}/${card.total})  ·  avg ${card.avgSteps} steps`
  + `  ·  MAIN ${card.avgFreshTokens} fresh + ${card.avgCacheReadTokens} cache`
  + `  ·  RUNNER ${card.avgRunnerTokens} tok  ·  $${card.avgCostUsd}/task  ·  ${(card.avgDurationMs / 1000).toFixed(1)}s`;

// Run the whole suite once and score it. The single-run button AND each A/B leg
// call this; it returns the scorecard + per-task results.
// The selected suite's tasks (simple = the fast 30; robust = +25 precision probes).
const selectedTasks = () => /** @type {Record<string, { tasks: any[] }>} */ (SUITES)[$('suite')?.value || 'simple']?.tasks ?? TASKS;

/** @param {string} [runnerCfg] @param {any[]} [tasksOverride] */
async function runSuite(runnerCfg, tasksOverride) {
  wireListeners();
  await ensureSubject();
  /** @type {any[]} */
  const results = [];
  const tasks = tasksOverride ?? selectedTasks();
  log(`  suite: ${$('suite')?.value || 'simple'} (${tasks.length} tasks)`);
  for (const task of tasks) {
    try { results.push(await runTask(task, runnerCfg)); }
    catch (e) { log(`  ✗ runner error: ${/** @type {{ message?: string }} */ (e)?.message ?? e}`); results.push({ id: task.id, pass: false, detail: 'runner error', error: String(e), steps: 0, tokens: 0, ...ZERO_COST, durationMs: 0, tools: [] }); }
  }
  return { card: aggregate(results), results };
}

async function runAll() {
  $('run').disabled = true; $('ab').disabled = true; $('log').textContent = ''; $('summary').textContent = 'running…';
  const { card, results } = await runSuite();
  lastCard = card;
  $('summary').textContent = scoreLine(card);
  renderDelta(card);
  log(`\n=== SCORECARD ===\n${JSON.stringify(card, null, 2)}`);
  // why: dump to console too so it can be copied/diffed against a baseline.
  console.log('[eval] scorecard', card, results);
  $('run').disabled = false; $('ab').disabled = false;
  refreshBaselineUi();
}

// ---- runner A/B (FEATURE-LOCAL-WEBGPU §3.1 — the M0 decision gate) --------
// Run the WHOLE suite under runner model A, then runner model B, on the SAME
// tasks, and score head-to-head — the decisive "is the local runner as reliable
// as Haiku, and faster?" measurement. Each config is a model id to PIN, or the
// literal 'local' (clears the pin so resolveRunnerModel picks the on-device
// WebGPU runner — it must be downloaded + available).

const readRunnerModel = async () => {
  try { const r = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'state/get' })); return r?.state?.settings?.runnerModel ?? ''; }
  catch { return ''; }
};
/** @param {string} val */
const setRunnerModel = (val) => browser.runtime.sendMessage({ type: 'settings/update', patch: { runnerModel: val } });
const localAvailable = async () => {
  // M1 (the offscreen engine) adds a real status route; until then this is
  // false, so a B='local' run aborts with a clear "download it first" message.
  try { const r = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'local-model/status' })); return !!(r?.available || r?.downloaded); }
  catch { return false; }
};

// Fill the A/B dropdowns from peerd's REAL available models (configured
// providers' catalogs, via models/options — the same source the chat model
// picker uses). We drop local-webgpu's own catalog entries: the runner pins a
// BARE model id, and pinning 'gemma…' would mis-route to the active cloud
// provider — the local runner is the 'local' sentinel (clears the pin →
// resolveRunnerModel step 2). The local model is NOT a static option: it's
// added by name (e.g. "Gemma 4 E2B") only once downloaded (refreshLocalStatus →
// addLocalOption). Needs the vault unlocked; if locked the lists are empty till reload.
async function populateModelSelects() {
  /** @type {any[]} */
  let options = [];
  try {
    const r = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'models/options' }));
    if (r?.ok && Array.isArray(r.options)) options = r.options;
  } catch { /* SW down / vault locked — preflight already warns */ }
  const cloud = options.filter((/** @type {any} */ o) => o.provider !== 'local-webgpu');
  /** @param {string} sel */
  const fill = (sel) => {
    const el = $(sel);
    el.innerHTML = '';
    for (const o of cloud) {
      const opt = document.createElement('option');
      opt.value = o.model; opt.textContent = `cloud api · ${o.providerLabel} · ${o.label}`;
      el.appendChild(opt);
    }
    return el;
  };
  const a = fill('cfgA'); const b = fill('cfgB');
  // Default A to a Haiku-class fast model (the page-reader runner default); B to
  // a different cloud model. If the local model is already downloaded,
  // refreshLocalStatus will add it + switch B to it (the natural local-vs-Haiku A/B).
  const haiku = cloud.find((/** @type {any} */ o) => /haiku/i.test(o.model));
  a.value = haiku ? haiku.model : (cloud[0]?.model ?? '');
  b.value = cloud.find((/** @type {any} */ o) => o.model !== a.value)?.model ?? a.value;
  await refreshLocalStatus();
}

// Add the on-device model to both A/B selects BY NAME, once it's downloaded.
// Idempotent (updates the label if present). On first add, switches B to it so
// the default comparison is local-vs-Haiku.
/** @param {string} label */
function addLocalOption(label) {
  let added = false;
  for (const sel of ['cfgA', 'cfgB']) {
    const el = $(sel);
    if (!el) continue;
    let opt = [...el.options].find((/** @type {any} */ o) => o.value === 'local');
    if (!opt) { opt = document.createElement('option'); opt.value = 'local'; el.appendChild(opt); added = true; }
    opt.textContent = `local · ${label}`;
  }
  if (added && $('cfgB')) $('cfgB').value = 'local';
}

// A config string → the runnerModel value to set (validating 'local').
/** @param {string} [cfg] */
async function configToRunnerModel(cfg) {
  const v = (cfg || '').trim();
  if (v.toLowerCase() === 'local') {
    if (!(await localAvailable())) throw new Error("'local' selected but the on-device model isn't loaded — download it in Settings → Local model first (or use a cloud model id).");
    return ''; // clear the pin → resolveRunnerModel step 2 picks the local runner
  }
  if (!v) throw new Error('empty runner config — enter a model id (e.g. claude-haiku-4-5) or "local".');
  return v; // pin this id
}

/** @param {string} label @param {string} [cfg] */
async function runOneConfig(label, cfg) {
  const rm = await configToRunnerModel(cfg);
  log(`\n──────── ${label}: runner "${cfg}" (runnerModel=${JSON.stringify(rm)}) ────────`);
  await setRunnerModel(rm);
  await sleep(200); // let the SW rebuild tool-contexts with the new runner model
  const { card, results } = await runSuite(cfg);
  return { label, cfg, card, results };
}

async function runAB() {
  $('run').disabled = true; $('ab').disabled = true; $('log').textContent = '';
  $('summary').textContent = 'A/B running…'; $('abresults').style.display = 'none'; $('abresults').textContent = '';
  const saved = await readRunnerModel(); // restore after — don't leave the user's setting changed
  try {
    const a = await runOneConfig('A', $('cfgA').value);
    const b = await runOneConfig('B', $('cfgB').value);
    renderAB(a, b);
  } catch (e) {
    const m = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
    $('summary').textContent = `A/B aborted: ${m}`;
    log(`\nA/B aborted: ${m}`);
  } finally {
    await setRunnerModel(saved);
    log(`\nrestored runnerModel to ${JSON.stringify(saved)}.`);
    $('run').disabled = false; $('ab').disabled = false;
  }
}

/**
 * @param {{ cfg?: string, card: ReturnType<typeof aggregate> }} a
 * @param {{ cfg?: string, card: ReturnType<typeof aggregate> }} b
 */
function renderAB(a, b) {
  const d = compare(a.card, b.card); // before=A, after=B → regressions = A-passed/B-failed
  /** @param {unknown} s */
  const pad = (s) => String(s).padEnd(16);
  /** @param {unknown} s */
  const col = (s) => String(s).padEnd(26);
  /** @param {number} n */
  const rUsd = (n) => (n > 0 ? `$${n}` : 'free'); // local runner reads "free"
  const out = [
    `RUNNER A/B — same ${a.card.total} tasks, two runner models`,
    '',
    `${pad('') + col(`A: ${a.cfg}`)  }B: ${b.cfg}`,
    `${pad('passRate') + col(`${a.card.passRate}%`)  }${b.card.passRate}%   (Δ ${d.passRateDelta >= 0 ? '+' : ''}${d.passRateDelta}%)`,
    `${pad('avg latency') + col(`${(a.card.avgDurationMs / 1000).toFixed(1)}s`)  }${(b.card.avgDurationMs / 1000).toFixed(1)}s`,
    `${pad('runner tok') + col(a.card.avgRunnerTokens)  }${b.card.avgRunnerTokens}`,
    `${pad('runner $/task') + col(rUsd(a.card.avgRunnerCostUsd))  }${rUsd(b.card.avgRunnerCostUsd)}`,
    `${pad('total $/task') + col(`$${a.card.avgTotalCostUsd}`)  }$${b.card.avgTotalCostUsd}`,
    '',
    d.regressions.length ? `⚠ B FAILED these (A passed): ${d.regressions.join(', ')}` : '✓ B matched A on every task A passed',
    d.fixes.length ? `  B fixed (A had failed): ${d.fixes.join(', ')}` : '',
    '',
    'Gate (§3.1): ship B-by-default only if passRate holds within tolerance of A AND avg latency ≤ A.',
  ].join('\n');
  $('abresults').style.display = 'block';
  $('abresults').textContent = out;
  $('summary').textContent = `A/B done — A ${a.card.passRate}% (${(a.card.avgDurationMs / 1000).toFixed(1)}s) vs B ${b.card.passRate}% (${(b.card.avgDurationMs / 1000).toFixed(1)}s)`;
  log(`\n=== A/B SCORECARDS ===\nA "${a.cfg}": ${JSON.stringify(a.card)}\nB "${b.cfg}": ${JSON.stringify(b.card)}\nΔ(B vs A): ${JSON.stringify(d)}`);
  console.log('[eval] A/B', { a, b, delta: d });
}

// Render the regression line against the pinned baseline, if any. This is the
// "what did my change break?" signal — regressions are flagged loudly because
// a newly-failing task is the one thing a pre-merge run must not let slide.
/** @param {ReturnType<typeof aggregate>} card */
function renderDelta(card) {
  const baseline = loadBaseline();
  const el = $('delta');
  if (!baseline) { el.textContent = 'No baseline pinned — run, then "Pin as baseline" to track regressions on the next run.'; el.className = ''; return; }
  const d = compare(baseline, card);
  /** @param {number} n @param {number} [dp] */
  const sign = (n, dp = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(dp)}`;
  const parts = [
    `passRate ${sign(d.passRateDelta, 1)}%`,
    `fresh ${sign(d.freshTokensDelta, 0)} tok`,
    `$/task ${sign(d.costUsdDelta, 5)}`,
    `steps ${sign(d.stepsDelta)}`,
  ];
  const line = `Δ vs baseline:  ${parts.join('  ·  ')}`;
  if (d.regressions.length) {
    el.className = 'regress';
    el.textContent = `⚠ REGRESSIONS (${d.regressions.length}): ${d.regressions.join(', ')}\n${line}`;
  } else {
    el.className = 'ok';
    el.textContent = `✓ no regressions${d.fixes.length ? `  ·  fixed: ${d.fixes.join(', ')}` : ''}\n${line}`;
  }
  log(`\n=== Δ vs baseline ===\n${JSON.stringify(d, null, 2)}`);
}

// Reflect baseline presence in the button labels/state.
function refreshBaselineUi() {
  const has = !!loadBaseline();
  $('pin').disabled = !lastCard;
  $('pin').textContent = has ? 'Re-pin baseline (current run)' : 'Pin as baseline';
  $('clearBaseline').disabled = !has;
}

async function preflight() {
  try {
    const s = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'provider/status' }));
    const hasKey = Array.isArray(s?.providers) ? s.providers.some((/** @type {any} */ p) => p.hasKey) : !!s?.providers?.hasKey;
    if (!s?.ok || !hasKey) {
      $('warn').textContent = '⚠ No provider key detected (or vault locked). Open the peerd side panel, unlock, ensure a key is set, then reload this page.';
    }
  } catch (e) {
    $('warn').textContent = `Could not reach the service worker: ${/** @type {{ message?: string }} */ (e)?.message ?? e}`;
  }
}

$('run').addEventListener('click', () => { runAll().catch((/** @type {unknown} */ e) => log(`fatal: ${/** @type {{ message?: string }} */ (e)?.message ?? e}`)); });
$('ab').addEventListener('click', () => { runAB().catch((/** @type {unknown} */ e) => log(`fatal: ${/** @type {{ message?: string }} */ (e)?.message ?? e}`)); });

// ---- local model download (FEATURE-LOCAL-WEBGPU M1) ----------------------
// Trigger the one-time Gemma download + reflect status here (the proper home is
// a Settings card; this button lives where you're testing). The eval page holds
// a 'sidepanel' port, so it gets the SW's local-model/progress broadcasts live.
// One aggregate progress bar across all weight files (like the HF space): sum
// loaded/total bytes over every file Transformers.js reports. `total` grows as
// new files start streaming, so the bar can step up — honest, and we also show
// GB so it never overstates how much is done.
/** @type {Map<string, { loaded: number, total: number }>} */
const dlBytes = new Map(); // file -> { loaded, total }
/** @param {string} [currentFile] */
function renderDlBar(currentFile) {
  let loaded = 0; let total = 0;
  for (const v of dlBytes.values()) { loaded += v.loaded; total += v.total; }
  if (total <= 0) return;
  const pct = Math.min(100, (loaded / total) * 100);
  const bar = $('dlbar'); const el = $('dlstatus');
  if (bar) { bar.style.display = ''; bar.value = pct; }
  /** @param {number} b */
  const gb = (b) => (b / 1e9).toFixed(2);
  // At 100% the download is done but the model isn't ready: ORT is still building
  // the WebGPU inference session (silent — no progress events). Say so, so a long
  // wait here doesn't read as a stuck download. If it sits >2-3 min it's a real
  // failure (check the offscreen console) — likely a WebGPU buffer-size limit.
  if (pct >= 99.95) { if (el) el.textContent = `downloaded ${gb(total)} GB · compiling for WebGPU (first run, can take a minute)…`; return; }
  const f = currentFile ? ` · ${currentFile.split('/').pop()}` : '';
  if (el) el.textContent = `downloading ${pct.toFixed(0)}% · ${gb(loaded)}/${gb(total)} GB${f}`;
}
/** @param {any} p */
function handleDlProgress(p) {
  const el = $('dlstatus'); const bar = $('dlbar');
  if (p.status === 'error') { if (el) el.textContent = `download error: ${p.message || ''}`; if (bar) bar.style.display = 'none'; return; }
  if (p.status === 'phase') {
    // 'ready' = the model finished loading. Surface it in the menu NOW (don't
    // wait on the 3s poll, which can hang while ORT blocks the offscreen during
    // session compile) — refreshLocalStatus adds the option + flips the UI.
    if (p.phase === 'ready') { refreshLocalStatus(); return; }
    if (el && !el.textContent.startsWith('downloading')) el.textContent = p.phase || '';
    return;
  }
  // Transformers.js file events carry loaded/total bytes; aggregate them.
  if (p.file && typeof p.total === 'number' && p.total > 0) {
    const prev = dlBytes.get(p.file);
    dlBytes.set(p.file, { loaded: p.status === 'done' ? p.total : (p.loaded ?? prev?.loaded ?? 0), total: p.total });
    renderDlBar(p.file);
  }
}
async function refreshLocalStatus() {
  const el = $('dlstatus'); const btn = $('dl'); const bar = $('dlbar');
  /** @type {any} */
  let s = null;
  try { s = await browser.runtime.sendMessage({ type: 'local-model/status' }); } catch { /* SW down */ }
  const name = s?.label || 'local model';
  if (s?.available) {
    if (el) el.textContent = `ready ✓ — ${name}`;
    if (bar) bar.style.display = 'none';
    btn.disabled = true; btn.textContent = `${name} ready`;
    addLocalOption(name);
  } else if (s?.loading) {
    btn.disabled = true; if (el && !el.textContent) el.textContent = 'loading…';
  } else if (s?.downloaded) {
    // cached from a prior session — no re-download; loads from cache on first use
    if (el) el.textContent = `downloaded ✓ — ${name} (loads from cache on first use)`;
    if (bar) bar.style.display = 'none';
    btn.disabled = true; btn.textContent = `${name} downloaded`;
    addLocalOption(name);
  } else {
    if (el) el.textContent = el.textContent || 'not downloaded'; btn.disabled = false;
  }
  return s;
}
async function downloadLocal() {
  const el = $('dlstatus'); const btn = $('dl');
  btn.disabled = true; dlBytes.clear();
  const cap = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'local-model/probe' }).catch(() => null));
  if (!cap?.ok) { el.textContent = `can't run locally: ${cap?.reason ?? 'WebGPU unavailable'}`; btn.disabled = false; return; }
  el.textContent = 'starting download (one-time ~3.1 GB, text-only)…';
  await browser.runtime.sendMessage({ type: 'local-model/init' }).catch(() => {});
  const poll = async () => {
    const s = await refreshLocalStatus();
    if (s?.available) log(`local model ready — "${s.label || 'local'}" is now selectable in the A/B fields.`);
    else setTimeout(poll, 3000);
  };
  poll();
}
$('dl').addEventListener('click', () => { downloadLocal().catch((/** @type {unknown} */ e) => log(`download error: ${/** @type {{ message?: string }} */ (e)?.message ?? e}`)); });
$('pin').addEventListener('click', () => {
  if (!lastCard) return;
  saveBaseline(lastCard);
  log('\n📌 pinned current run as baseline.');
  renderDelta(lastCard); // now compares to itself → 0 deltas, no regressions
  refreshBaselineUi();
});
$('clearBaseline').addEventListener('click', () => {
  clearBaseline();
  log('\n🗑 cleared baseline.');
  if (lastCard) renderDelta(lastCard);
  refreshBaselineUi();
});

// ---- programmatic driver hook (build-over-build benchmark loop) -----------
// why: the in-house CDP harness (scripts/cdp/run-eval-bench.mjs) needs to START
// a run and READ the structured scorecard WITHOUT scraping the DOM, so it can
// score one BUILD against a baseline in default settings — "drive eval/lab to
// measure builds, not just models." The buttons stay the human path; this is the
// one automation seam. A full suite outlasts a single awaited CDP call, so the
// driver fires run() then POLLS lastCard/lastError — hence the result lands on
// the object, not a return value. `taskIds` runs an exact subset (deterministic
// smoke); `limit` runs a first-N subset (cost control). No-ops if a run is
// already in flight.
const evalDriver = {
  ready: true,
  running: false,
  /** @type {ReturnType<typeof aggregate> | null} */
  lastCard: null,
  /** @type {any[] | null} */
  lastResults: null,
  /** @type {string | null} */
  lastError: null,
  /** @param {{ suite?: string, limit?: number, taskIds?: string[], runnerCfg?: string }} [opts] */
  run(opts = {}) {
    if (evalDriver.running) return;
    const { suite, limit, taskIds, runnerCfg } = opts;
    evalDriver.running = true;
    evalDriver.lastCard = null; evalDriver.lastResults = null; evalDriver.lastError = null;
    if (suite) { const sel = $('suite'); if (sel) sel.value = suite; }
    void (async () => {
      try {
        /** @type {any[] | undefined} */
        let tasks;
        if (Array.isArray(taskIds) && taskIds.length) {
          const all = selectedTasks();
          tasks = taskIds.map((id) => all.find((t) => t.id === id)).filter(Boolean);
        } else if (typeof limit === 'number' && limit > 0) {
          tasks = selectedTasks().slice(0, limit);
        }
        const { card, results } = await runSuite(runnerCfg, tasks);
        lastCard = card; // module-level too → the Pin button can pin a driver run
        evalDriver.lastResults = results;
        evalDriver.lastCard = card;
        refreshBaselineUi();
      } catch (e) {
        evalDriver.lastError = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
      } finally {
        evalDriver.running = false;
      }
    })();
  },
};
/** @type {any} */ (window).__peerdEval = evalDriver;

preflight();
populateModelSelects(); // fills cloud models, then refreshLocalStatus() adds the local model if downloaded
refreshBaselineUi();
