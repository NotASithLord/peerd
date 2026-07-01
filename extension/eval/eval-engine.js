// @ts-check
// eval/eval-engine — the DOM-free eval orchestration, shared by the home "Lab"
// section. Inject `browser` + a `log` callback; the engine owns the SW port, a
// dedicated hidden subject window, and the run loop, and returns scorecards as
// DATA (not DOM). Both a single suite run and a head-to-head A/B go through here.
//
// It connects the same 'sidepanel' port the eval page uses (turn/* push events)
// and drives the REAL agent via agent/send — so a Lab score reflects the actual
// loop, gates, tools, and model. NB: a run does `session/reset` + takes over the
// agent session; surfaces must warn before starting (your current chat resets).
//
// ponytail: extension/eval/runner.js still carries its own inline copy of this
// orchestration — it's the proven standalone dev surface and I won't refactor it
// onto this engine until the Lab is field-verified. Deliberate transitional debt.

import { SUITES, TASKS } from './tasks.js';
import { aggregate, compare } from './score.js';
import { costOf } from '/peerd-provider/index.js';
import { sleep } from '/shared/util.js';

/**
 * @typedef {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, cost?: number }} Usage
 * @typedef {{ session: any, tools: string[], tokens: number, cost: Usage | null, runner: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }, error: string | null, started: boolean, resolveDone: ((value?: any) => void) | null }} Turn
 */

// The runner's own $ for a task. 'local' (the on-device runner) is FREE; a cloud
// runner is priced from its tokens × the model's rate (costOf → $0 for an unpriced
// id). This is what makes "local is free" show up — B's runner reads $0.
/** @param {string} [cfg] @param {Usage} [usage] */
const priceRunnerUsd = (cfg, usage) => {
  if (!cfg || String(cfg).toLowerCase() === 'local') return 0;
  // why the cast: costOf wants a TokenUsage; our runner tally is the same shape
  // (and costOf guards `!usage` internally), so the optional is safe here.
  try { return costOf(cfg, /** @type {any} */ (usage))?.cost ?? 0; } catch { return 0; }
};

const ZERO_COST = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, runnerTokens: 0 };
/** @param {Usage | null | undefined} t */
const tally = (t) => t ? (t.inputTokens || 0) + (t.outputTokens || 0) + (t.cacheReadTokens || 0) + (t.cacheWriteTokens || 0) : 0;
/** @param {Usage | null | undefined} c */
const costFields = (c) => c ? {
  inputTokens: c.inputTokens || 0, outputTokens: c.outputTokens || 0,
  cacheReadTokens: c.cacheReadTokens || 0, cacheWriteTokens: c.cacheWriteTokens || 0,
  costUsd: typeof c.cost === 'number' ? c.cost : 0,
} : { ...ZERO_COST };
/** @returns {Turn} */
const newTurn = () => ({ session: null, tools: [], tokens: 0, cost: null, runner: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, error: null, started: false, resolveDone: null });

/** @param {any} session */
const finalAnswer = (session) => {
  const msgs = session?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return '';
};

/**
 * @param {{ browser: any, log?: (s: string) => void, onProgress?: (p: object) => void }} deps
 */
export function createEvalEngine({ browser, log = () => {}, onProgress = () => {} }) {
  let turn = newTurn();
  /** @type {number | null} */
  let subjectId = null;
  /** @type {number | null} */
  let subjectWin = null;
  /** @type {number | null} */
  let runnerTabId = null;
  /** @type {Set<number>} */
  const agentTabs = new Set();
  let listenersWired = false;

  // 'eval' (NOT 'sidepanel') — joins uiPorts for the turn/* stream but does NOT
  // count as "the side panel is open". The Lab runs inside the home page, so a
  // 'sidepanel'-named port here would make the home think the panel popped out.
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
      case 'local-model/progress': onProgress(msg.progress || {}); break;
      default: break;
    }
  });

  // A dedicated window the agent drives — never the Lab's own page. Off (default):
  // MINIMIZED, so it's hidden/background — you never see the eval tabs. On ('show
  // tabs'): a NORMAL, visible window with its own tab bar — but `focused: false`
  // everywhere, so it NEVER steals focus (you can click to it to watch). Targeted
  // by id (agent/send activeTabId), so it never needs focus to work.
  /** @param {boolean} showTabs */
  async function ensureSubject(showTabs) {
    if (runnerTabId == null) {
      try { runnerTabId = (await browser.tabs.getCurrent())?.id ?? -1; } catch { runnerTabId = -1; }
    }
    const wantState = showTabs ? 'normal' : 'minimized';
    // focused:false on the restore too — restoring a minimized window otherwise
    // brings it to the front (the focus-steal in visible mode).
    const upd = wantState === 'normal' ? { state: 'normal', focused: false } : { state: 'minimized' };
    if (subjectId != null) {
      try {
        await browser.tabs.get(subjectId);
        await browser.windows.update(subjectWin, upd).catch(() => {});
        return;
      } catch { subjectId = null; }
    }
    const w = await browser.windows.create({ url: 'about:blank', focused: false, state: wantState });
    subjectId = w.tabs?.[0]?.id; subjectWin = w.id;
    log(`  (eval window ${subjectWin} — ${wantState}; agent drives tab ${subjectId})`);
  }

  /** @param {any} tab */
  function onAgentTabCreated(tab) {
    if (subjectWin == null || tab.windowId !== subjectWin) return;
    if (tab.id === subjectId || tab.id === runnerTabId) return;
    agentTabs.add(tab.id);
  }
  function wireListeners() {
    if (listenersWired) return;
    browser.tabs.onCreated.addListener(onAgentTabCreated);
    listenersWired = true;
  }
  async function closeAgentTabs() {
    for (const id of agentTabs) {
      if (id === subjectId || id === runnerTabId) continue;
      try { await browser.tabs.remove(id); } catch { /* gone */ }
    }
    agentTabs.clear();
  }
  // The tab the agent ended on — EXCLUDE the Lab's own page (it would score a
  // chrome-extension:// URL); among the rest pick active → most-recent → subject.
  async function resolveEndTab() {
    /** @type {any[]} */
    let tabs = [];
    try { tabs = await browser.tabs.query({ windowId: subjectWin }); } catch { /* gone */ }
    const candidates = tabs.filter((/** @type {any} */ t) => t.id != null && t.id !== runnerTabId);
    if (candidates.length) {
      candidates.sort((/** @type {any} */ a, /** @type {any} */ b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      return candidates.find((/** @type {any} */ t) => t.active) || candidates[0];
    }
    try { return await browser.tabs.get(subjectId); } catch { return null; }
  }
  // Let a terminal navigation finish before scoring (a submit ends the turn
  // while the new page is still loading).
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
      text = r?.[0]?.result || '';
    } catch { /* restricted page */ }
    return { url, title, text };
  }

  /** @param {any} task @param {string} [runnerCfg] */
  async function runTask(task, runnerCfg) {
    turn = newTurn();
    log(`\n▶ ${task.id} — ${task.title}`);
    await browser.runtime.sendMessage({ type: 'session/reset' });
    await closeAgentTabs();
    // subjectId is set by ensureSubject before any task runs; cast off the null.
    const subjId = /** @type {number} */ (subjectId);
    if (task.startUrl) { log(`  nav → ${task.startUrl}`); await navigateTab(subjId, task.startUrl); }
    /** @type {Promise<void>} */
    const donePromise = new Promise((res) => { turn.resolveDone = res; });
    const start = Date.now();
    const reply = await browser.runtime.sendMessage({ type: 'agent/send', text: task.prompt, activeTabId: subjId });
    if (!reply?.ok) {
      const detail = `agent/send rejected: ${reply?.error}`;
      log(`  ✗ ${detail}`);
      return { id: task.id, pass: false, detail, error: reply?.error, steps: 0, tokens: 0, ...ZERO_COST, runnerTokens: 0, runnerCostUsd: 0, durationMs: 0, tools: [] };
    }
    await Promise.race([donePromise, sleep(task.timeoutMs ?? 90_000)]);
    const durationMs = Date.now() - start;
    const timedOut = !!turn.resolveDone;
    turn.resolveDone = null;
    if (timedOut) log('  ⏱ timed out (still scoring end state)');
    await settleSubject();
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
    const freshTok = cost.inputTokens + cost.outputTokens;
    const runnerTokens = turn.runner.inputTokens + turn.runner.outputTokens + turn.runner.cacheReadTokens + turn.runner.cacheWriteTokens;
    const runnerCostUsd = priceRunnerUsd(runnerCfg, turn.runner);
    log(`  ${res.pass ? '✓ PASS' : '✗ FAIL'} — ${res.detail}  [${state.steps} steps · ${(durationMs / 1000).toFixed(1)}s · runner ${runnerTokens} tok · $${runnerCostUsd.toFixed(4)} runner + $${cost.costUsd.toFixed(4)} main]`);
    if (!res.pass && state.answer) log(`       agent said: "${state.answer.slice(0, 200).replace(/\s+/g, ' ')}"`);
    return { id: task.id, pass: res.pass, detail: res.detail, error: state.error, steps: state.steps, tokens: state.tokens, ...cost, runnerTokens, runnerCostUsd, durationMs, tools: state.tools };
  }

  // onTask({ index, total, id }) lets the UI show live progress per task.
  // runnerCfg = the runner model under test ('local' or a cloud id) — used to
  // price each task's runner cost ($0 for local). Omitted (single runs that don't
  // pin a runner) → runner cost is reported as 0.
  /**
   * @param {string} suiteId @param {boolean} showTabs
   * @param {(p: { index: number, total: number, id: string }) => void} [onTask]
   * @param {string} [runnerCfg]
   */
  async function runSuite(suiteId, showTabs, onTask = () => {}, runnerCfg) {
    wireListeners();
    await ensureSubject(showTabs);
    const tasks = /** @type {Record<string, { tasks: any[] }>} */ (SUITES)[suiteId]?.tasks ?? TASKS;
    log(`  suite: ${suiteId} (${tasks.length} tasks)`);
    /** @type {any[]} */
    const results = [];
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      onTask({ index: i, total: tasks.length, id: task.id });
      try { results.push(await runTask(task, runnerCfg)); }
      catch (e) { log(`  ✗ runner error: ${/** @type {{ message?: string }} */ (e)?.message ?? e}`); results.push({ id: task.id, pass: false, detail: 'runner error', error: String(e), steps: 0, tokens: 0, ...ZERO_COST, runnerTokens: 0, runnerCostUsd: 0, durationMs: 0, tools: [] }); }
    }
    return { card: aggregate(results), results };
  }

  // ---- model + A/B helpers --------------------------------------------------
  const readRunnerModel = async () => { try { const r = await browser.runtime.sendMessage({ type: 'state/get' }); return r?.state?.settings?.runnerModel ?? ''; } catch { return ''; } };
  /** @param {string} val */
  const setRunnerModel = (val) => browser.runtime.sendMessage({ type: 'settings/update', patch: { runnerModel: val } });
  const localAvailable = async () => { try { const r = await browser.runtime.sendMessage({ type: 'local-model/status' }); return !!(r?.available || r?.downloaded); } catch { return false; } };
  // A config string → the runnerModel value to set. '' or 'local' clears the pin
  // (→ resolveRunnerModel: local when available, else the provider default).
  /** @param {string} [cfg] */
  const configToRunnerModel = async (cfg) => {
    const v = (cfg || '').trim();
    if (v.toLowerCase() === 'local') {
      if (!(await localAvailable())) throw new Error("'local' selected but the on-device model isn't downloaded — get it in Settings → WebGPU models first.");
      return '';
    }
    if (!v) throw new Error('pick a runner model for each side.');
    return v;
  };
  // The MAIN (chat agent) model — the other half of a config. A config is a PAIR:
  // the main model that orchestrates + the web actor model that reads pages.
  // setMainModel writes providerName+providerModel.
  /** @param {string} provider @param {string} model */
  const setMainModel = (provider, model) => browser.runtime.sendMessage({ type: 'settings/update', patch: { providerName: provider, providerModel: model } });
  const readMainModel = async () => { try { const r = await browser.runtime.sendMessage({ type: 'state/get' }); const s = r?.state?.settings; return { provider: s?.providerName ?? '', model: s?.providerModel ?? '' }; } catch { return { provider: '', model: '' }; } };

  // config = { mainProvider, mainModel, runnerCfg }. Sets BOTH models, runs the
  // suite, returns the scorecard. (The caller restores the user's settings.)
  /**
   * @param {string} label
   * @param {{ mainProvider?: string, mainModel?: string, runnerCfg?: string }} config
   * @param {string} suiteId @param {boolean} showTabs
   * @param {(p: { index: number, total: number, id: string }) => void} [onTask]
   */
  async function runOneConfig(label, config, suiteId, showTabs, onTask) {
    const rm = await configToRunnerModel(config.runnerCfg);
    if (config.mainProvider && config.mainModel) await setMainModel(config.mainProvider, config.mainModel);
    await setRunnerModel(rm);
    await sleep(200); // let the SW rebuild the session + tool-contexts with the new models
    log(`\n──────── ${label}: main "${config.mainModel}" · runner "${config.runnerCfg}" ────────`);
    const { card, results } = await runSuite(suiteId, showTabs, onTask, config.runnerCfg);
    return { label, config, card, results };
  }

  // Save the user's models, run, restore — the Lab never leaves your chat on a
  // different model than you set.
  /** @param {() => Promise<any>} fn */
  async function withSavedModels(fn) {
    const savedMain = await readMainModel();
    const savedRunner = await readRunnerModel();
    try { return await fn(); }
    finally {
      await setMainModel(savedMain.provider, savedMain.model);
      await setRunnerModel(savedRunner);
      log(`\nrestored your models (main ${JSON.stringify(savedMain.model)}, runner ${JSON.stringify(savedRunner)}).`);
    }
  }
  /**
   * @param {{ mainProvider?: string, mainModel?: string, runnerCfg?: string }} config
   * @param {string} suiteId @param {boolean} showTabs
   * @param {(p: { index: number, total: number, id: string }) => void} [onTask]
   */
  const runOne = (config, suiteId, showTabs, onTask = () => {}) =>
    withSavedModels(() => runOneConfig('A', config, suiteId, showTabs, onTask));
  // Run the suite under config A, then config B (each a main+runner pair).
  /**
   * @param {{ mainProvider?: string, mainModel?: string, runnerCfg?: string }} configA
   * @param {{ mainProvider?: string, mainModel?: string, runnerCfg?: string }} configB
   * @param {string} suiteId @param {boolean} showTabs
   * @param {(p: { index: number, total: number, id: string }) => void} [onTask]
   */
  const runAB = (configA, configB, suiteId, showTabs, onTask = () => {}) =>
    withSavedModels(async () => {
      const a = await runOneConfig('A', configA, suiteId, showTabs, onTask);
      const b = await runOneConfig('B', configB, suiteId, showTabs, onTask);
      return { a, b, delta: compare(a.card, b.card) };
    });

  const modelsOptions = async () => { try { const r = await browser.runtime.sendMessage({ type: 'models/options' }); return (r?.ok && Array.isArray(r.options)) ? r.options : []; } catch { return []; } };
  const localStatus = async () => { try { return await browser.runtime.sendMessage({ type: 'local-model/status' }); } catch { return null; } };
  const providerStatus = async () => { try { return await browser.runtime.sendMessage({ type: 'provider/status' }); } catch { return null; } };

  return { runAB, runOne, modelsOptions, localStatus, providerStatus };
}

export { aggregate, compare };
