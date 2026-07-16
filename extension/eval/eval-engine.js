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
 * @typedef {{ session: any, tools: string[], tokens: number, cost: Usage | null, runner: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }, runnerUsd: number, error: string | null, started: boolean, resolveDone: ((value?: any) => void) | null, goalMode: boolean, modelsSeen: Set<string> }} Turn
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
const newTurn = () => ({ session: null, tools: [], tokens: 0, cost: null, runner: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, runnerUsd: 0, error: null, started: false, resolveDone: null, goalMode: false, modelsSeen: new Set() });

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
  // A push belongs to the CURRENT task's subject session. turn/state carries
  // the subject record (actors use turn/actor-state, never turn/state), so
  // turn.session.sessionId is the subject id — set before the subject's own
  // cost/goal events. Requiring it to be KNOWN and to MATCH rejects both
  // background-session pushes and a prior task's late "zombie" events.
  /** @param {{ sessionId?: string }} msg */
  const isSubject = (msg) => !!turn.session?.sessionId && msg.sessionId === turn.session.sessionId;

  const port = browser.runtime.connect({ name: 'eval' });
  port.onMessage.addListener((/** @type {any} */ msg) => {
    switch (msg?.type) {
      case 'turn/state':
        turn.session = msg.session; turn.started = true;
        // Which model(s) actually ran this task — the prewalk arm's "did the
        // swap happen" signal (planner then executor both show up here).
        if (msg.session?.model) turn.modelsSeen.add(msg.session.model);
        break;
      case 'turn/delta': turn.started = true; break;
      case 'turn/tool-use': turn.started = true; turn.tools.push(msg.name); break;
      case 'turn/cost':
        // why msg.session (cumulative) not msg.turn (last-turn-only): a GOAL
        // run spans many turns, and prewalk makes the LAST turn the cheap
        // executor while baseline's last turn is the frontier model — reading
        // msg.turn would drop the expensive planning turns and bias the A/B
        // toward prewalk. msg.session is the run total (same CostTally shape).
        // why the sessionId guard: the 'eval' port receives turn/cost for
        // EVERY session incl. web-actor turns; without it an actor turn's tally
        // clobbers the subject's. Actor spend rides turn/spawned-cost below.
        if (isSubject(msg) && msg.session) { turn.tokens = tally(msg.session); turn.cost = msg.session; }
        break;
      case 'turn/spawned-cost':
        if (msg.usage) {
          turn.runner.inputTokens += msg.usage.inputTokens || 0;
          turn.runner.outputTokens += msg.usage.outputTokens || 0;
          turn.runner.cacheReadTokens += msg.usage.cacheReadTokens || 0;
          turn.runner.cacheWriteTokens += msg.usage.cacheWriteTokens || 0;
        }
        break;
      // message_actor-driven actors (WEB + the engine VM/Notebook/App actors)
      // broadcast turn/actor-cost, NOT turn/spawned-cost (which is the
      // actor_create/spawn path). Fold it into the SAME runner bucket — without
      // this an engine actor's spend is invisible here, so the engine-actor
      // prewalk down-shift wouldn't register in the A/B. Tokens ride msg.usage
      // (absent on the in-SW fallback, which sends cost only); the SW-priced USD
      // (msg.cost.cost) is accumulated so the row reports the actor's REAL spend.
      case 'turn/actor-cost':
        if (msg.usage) {
          turn.runner.inputTokens += msg.usage.inputTokens || 0;
          turn.runner.outputTokens += msg.usage.outputTokens || 0;
          turn.runner.cacheReadTokens += msg.usage.cacheReadTokens || 0;
          turn.runner.cacheWriteTokens += msg.usage.cacheWriteTokens || 0;
        }
        if (typeof msg.cost?.cost === 'number') turn.runnerUsd += msg.cost.cost;
        break;
      // An actor turn's session snapshot — its model(s) show the planner→
      // executor handoff (engine-actor prewalk). turn/actor-state, not
      // turn/state (which is the subject/main session only).
      case 'turn/actor-state':
        if (msg.session?.model) turn.modelsSeen.add(msg.session.model);
        break;
      case 'turn/error': turn.error = msg.error; break;
      case 'turn/streaming':
        if (msg.streaming) turn.started = true;
        // Goal-mode tasks span MANY turns — streaming:false fires between every
        // iteration, so only the goal/state terminal below may resolve them.
        else if (!turn.goalMode && turn.started && turn.resolveDone) { const r = turn.resolveDone; turn.resolveDone = null; r(); }
        break;
      case 'goal/state':
        // why isSubject: a timed-out prior task's run can emit a late terminal
        // AFTER this task started (its aborted turn tail settles whenever). Only
        // the CURRENT subject's terminal may resolve THIS task — else task N's
        // zombie resolves task N+1 mid-run and contaminates the A/B.
        if (!isSubject(msg)) break;
        turn.started = true;
        if (turn.goalMode && msg.active === false && turn.resolveDone) {
          const r = turn.resolveDone; turn.resolveDone = null; r();
        }
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

  // goal=true runs the task as a GOAL RUN (agent/send goal:true): the agent
  // keeps taking turns until complete_goal / cap / stop — the arc the prewalk
  // arm exercises (prewalk only engages on goal runs). Completion is the
  // run's terminal goal/state, not turn/streaming; timeouts stop the run so
  // it can't keep driving turns into the NEXT task's session.
  /** @param {any} task @param {string} [runnerCfg] @param {{ goal?: boolean }} [opts] */
  async function runTask(task, runnerCfg, opts = {}) {
    turn = newTurn();
    turn.goalMode = !!opts.goal;
    log(`\n▶ ${task.id} — ${task.title}`);
    await browser.runtime.sendMessage({ type: 'session/reset' });
    await closeAgentTabs();
    // subjectId is set by ensureSubject before any task runs; cast off the null.
    const subjId = /** @type {number} */ (subjectId);
    if (task.startUrl) { log(`  nav → ${task.startUrl}`); await navigateTab(subjId, task.startUrl); }
    /** @type {Promise<void>} */
    const donePromise = new Promise((res) => { turn.resolveDone = res; });
    const start = Date.now();
    const reply = await browser.runtime.sendMessage({
      type: 'agent/send', text: task.prompt, activeTabId: subjId,
      ...(turn.goalMode ? { goal: true } : {}),
    });
    if (!reply?.ok) {
      const detail = `agent/send rejected: ${reply?.error}`;
      log(`  ✗ ${detail}`);
      return { id: task.id, pass: false, detail, error: reply?.error, steps: 0, tokens: 0, ...ZERO_COST, runnerTokens: 0, runnerCostUsd: 0, durationMs: 0, tools: [] };
    }
    // A goal run is many turns; give it more wall clock than a single turn.
    const timeoutMs = task.timeoutMs ?? (turn.goalMode ? 300_000 : 90_000);
    await Promise.race([donePromise, sleep(timeoutMs)]);
    const durationMs = Date.now() - start;
    const timedOut = !!turn.resolveDone;
    turn.resolveDone = null;
    if (timedOut) {
      log('  ⏱ timed out (still scoring end state)');
      // A live goal run would keep driving turns past this task — halt it.
      if (turn.goalMode) await browser.runtime.sendMessage({ type: 'agent/stop' }).catch(() => {});
    }
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
    // Prefer the ACTUAL accumulated actor spend (turn/actor-cost, SW-priced from
    // the actor's real model — so an engine-actor prewalk down-shift shows here)
    // over re-pricing by runnerCfg, which exists for the runner-model A/B and
    // reads 'local' (=$0) otherwise.
    const runnerCostUsd = turn.runnerUsd > 0 ? turn.runnerUsd : priceRunnerUsd(runnerCfg, turn.runner);
    const models = [...turn.modelsSeen];
    log(`  ${res.pass ? '✓ PASS' : '✗ FAIL'} — ${res.detail}  [${state.steps} steps · ${(durationMs / 1000).toFixed(1)}s · runner ${runnerTokens} tok · $${runnerCostUsd.toFixed(4)} runner + $${cost.costUsd.toFixed(4)} main${models.length > 1 ? ` · models ${models.join(' → ')}` : ''}]`);
    if (!res.pass && state.answer) log(`       agent said: "${state.answer.slice(0, 200).replace(/\s+/g, ' ')}"`);
    return { id: task.id, pass: res.pass, detail: res.detail, error: state.error, steps: state.steps, tokens: state.tokens, ...cost, runnerTokens, runnerCostUsd, durationMs, tools: state.tools, models };
  }

  // onTask({ index, total, id }) lets the UI show live progress per task.
  // runnerCfg = the runner model under test ('local' or a cloud id) — used to
  // price each task's runner cost ($0 for local). Omitted (single runs that don't
  // pin a runner) → runner cost is reported as 0.
  /**
   * @param {string} suiteId @param {boolean} showTabs
   * @param {(p: { index: number, total: number, id: string }) => void} [onTask]
   * @param {string} [runnerCfg]
   * @param {{ goal?: boolean }} [opts]  goal:true runs every task as a goal run
   */
  async function runSuite(suiteId, showTabs, onTask = () => {}, runnerCfg, opts = {}) {
    wireListeners();
    await ensureSubject(showTabs);
    const tasks = /** @type {Record<string, { tasks: any[] }>} */ (SUITES)[suiteId]?.tasks ?? TASKS;
    log(`  suite: ${suiteId} (${tasks.length} tasks${opts.goal ? ' · goal mode' : ''})`);
    /** @type {any[]} */
    const results = [];
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      onTask({ index: i, total: tasks.length, id: task.id });
      try { results.push(await runTask(task, runnerCfg, opts)); }
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

  // Prewalk arm control — the benchmarking switch for the goal-run handoff
  // (loop/prewalk.js). Set per config leg, saved/restored with the models.
  const readPrewalk = async () => { try { const r = await browser.runtime.sendMessage({ type: 'state/get' }); return r?.state?.settings?.prewalkEnabled === true; } catch { return false; } };
  /** @param {boolean} val */
  const setPrewalk = (val) => browser.runtime.sendMessage({ type: 'settings/update', patch: { prewalkEnabled: !!val } });
  // Engine-actor prewalk arm — the switch for the VM/Notebook/App handoff.
  const readEnginePrewalk = async () => { try { const r = await browser.runtime.sendMessage({ type: 'state/get' }); return r?.state?.settings?.enginePrewalkEnabled === true; } catch { return false; } };
  /** @param {boolean} val */
  const setEnginePrewalk = (val) => browser.runtime.sendMessage({ type: 'settings/update', patch: { enginePrewalkEnabled: !!val } });

  // config = { mainProvider, mainModel, runnerCfg, goal?, prewalk?, enginePrewalk? }.
  // Sets the models + both prewalk arms, runs the suite (as goal runs when
  // goal:true), returns the scorecard. (The caller restores the user's settings.)
  /**
   * @param {string} label
   * @param {{ mainProvider?: string, mainModel?: string, runnerCfg?: string, goal?: boolean, prewalk?: boolean, enginePrewalk?: boolean }} config
   * @param {string} suiteId @param {boolean} showTabs
   * @param {(p: { index: number, total: number, id: string }) => void} [onTask]
   */
  async function runOneConfig(label, config, suiteId, showTabs, onTask) {
    const rm = await configToRunnerModel(config.runnerCfg);
    if (config.mainProvider && config.mainModel) await setMainModel(config.mainProvider, config.mainModel);
    await setRunnerModel(rm);
    // Set BOTH prewalk arms explicitly per leg so an A/B is always a controlled
    // comparison, whatever the user's own settings are.
    await setPrewalk(!!config.prewalk);
    await setEnginePrewalk(!!config.enginePrewalk);
    await sleep(200); // let the SW rebuild the session + tool-contexts with the new models
    log(`\n──────── ${label}: main "${config.mainModel}" · runner "${config.runnerCfg}"${config.goal ? ' · goal' : ''}${config.prewalk ? ' · prewalk' : ''}${config.enginePrewalk ? ' · engine-prewalk' : ''} ────────`);
    const { card, results } = await runSuite(suiteId, showTabs, onTask, config.runnerCfg, { goal: !!config.goal });
    return { label, config, card, results };
  }

  // Save the user's models + both prewalk arms, run, restore — the Lab never
  // leaves your chat on a different model (or a flipped experiment) than you set.
  /** @param {() => Promise<any>} fn */
  async function withSavedModels(fn) {
    const savedMain = await readMainModel();
    const savedRunner = await readRunnerModel();
    const savedPrewalk = await readPrewalk();
    const savedEnginePrewalk = await readEnginePrewalk();
    try { return await fn(); }
    finally {
      await setMainModel(savedMain.provider, savedMain.model);
      await setRunnerModel(savedRunner);
      await setPrewalk(savedPrewalk);
      await setEnginePrewalk(savedEnginePrewalk);
      log(`\nrestored your settings (main ${JSON.stringify(savedMain.model)}, runner ${JSON.stringify(savedRunner)}, prewalk ${savedPrewalk ? 'on' : 'off'}, engine-prewalk ${savedEnginePrewalk ? 'on' : 'off'}).`);
    }
  }
  /** @typedef {{ mainProvider?: string, mainModel?: string, runnerCfg?: string, goal?: boolean, prewalk?: boolean, enginePrewalk?: boolean }} ArmConfig */
  /**
   * @param {ArmConfig} config
   * @param {string} suiteId @param {boolean} showTabs
   * @param {(p: { index: number, total: number, id: string }) => void} [onTask]
   */
  const runOne = (config, suiteId, showTabs, onTask = () => {}) =>
    withSavedModels(() => runOneConfig('A', config, suiteId, showTabs, onTask));
  // Run the suite under config A, then config B. Each config is a main+runner
  // pair plus the run-shape flags (goal / prewalk) — so the same helper drives
  // a model A/B or a baseline-vs-prewalk arm comparison.
  /**
   * @param {ArmConfig} configA
   * @param {ArmConfig} configB
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
