// @ts-check
// The Lab — the home page's model-testing bench. Pit two CONFIGS head-to-head on
// the same real web tasks (the actual agent loop, tools, and gates — not a mock).
//
// A config is a PAIR of models, because that's what actually runs a task:
//   • the MAIN model — the chat agent that plans + orchestrates
//   • the WEB ACTOR model — the actor that reads/acts on pages
// Both are configurable per side, so you can compare e.g. "cloud main + cloud
// web actor" vs "fully on-device (local main + local web actor)" — and the cost
// is honest: a fully-local config reads $0 total.
//
// Brand rule: monochrome; pass/fail by glyph (✓/✗) + the lone semantic red.
// The engine (eval/eval-engine.js) owns the SW port + run loop; this is the view.
//
// NB: a run takes over the agent session (session/reset) + drives a hidden window.

import m from '/vendor/mithril/mithril.js';
import browser from '/shared/browser-api.js';
import { openOptions } from '/shared/open-options.js';
import { createEvalEngine } from '../eval/eval-engine.js';
import { SUITES } from '../eval/tasks.js';

/** @typedef {import('../options/sections/reset-row.js').Send} Send */
/** @typedef {{ value: string, model: string, provider: string, providerLabel: string, label: string }} ModelOption */
/**
 * @typedef {object} EvalUi
 * @property {boolean} loaded
 * @property {string} warn
 * @property {boolean} running
 * @property {any} progress
 * @property {string} suiteId
 * @property {boolean} showTabs
 * @property {boolean} goalRuns
 * @property {boolean} showTasks
 * @property {string} mainA
 * @property {string} runnerA
 * @property {string} mainB
 * @property {string} runnerB
 * @property {ModelOption[]} allOptions
 * @property {ModelOption[]} cloudOptions
 * @property {string | null} localLabel
 * @property {any} ab
 * @property {any} single
 * @property {string[]} log
 */

// Module-level singleton: ONE SW port for the session; run state survives tab switches.
/** @type {any} */
let engine = null;
/** @type {EvalUi} */
const ui = {
  loaded: false, warn: '', running: false, progress: null,
  suiteId: 'simple', showTabs: false, goalRuns: false, showTasks: false,
  mainA: '', runnerA: '', mainB: '', runnerB: '',
  allOptions: [], cloudOptions: [], localLabel: null,
  ab: null, single: null, log: [],
};

/** @param {string} s */
const pushLog = (s) => { ui.log.push(s); if (ui.log.length > 240) ui.log = ui.log.slice(-240); m.redraw(); };
const ensureEngine = () => (engine ??= createEvalEngine({ browser, log: pushLog, onProgress: () => {} }));

// Main-model select values are 'provider::model' (from models/options); split them.
/** @param {string} val */
const parseMain = (val) => { const i = String(val).indexOf('::'); return i < 0 ? { provider: '', model: String(val) } : { provider: val.slice(0, i), model: val.slice(i + 2) }; };
/** @param {'A' | 'B'} side */
const configFor = (side) => {
  const { provider, model } = parseMain(side === 'A' ? ui.mainA : ui.mainB);
  return { mainProvider: provider, mainModel: model, runnerCfg: side === 'A' ? ui.runnerA : ui.runnerB, goal: ui.goalRuns };
};

async function loadModels() {
  const e = ensureEngine();
  const [opts, ls, ps] = await Promise.all([e.modelsOptions(), e.localStatus(), e.providerStatus()]);
  ui.allOptions = opts || [];                                                    // MAIN selects: every model (incl. local once downloaded)
  ui.cloudOptions = ui.allOptions.filter((o) => o.provider !== 'local-webgpu');  // RUNNER selects: cloud ids + the 'local' sentinel
  ui.localLabel = (ls?.available || ls?.downloaded) ? (ls.label || 'Local model') : null;
  const hasKey = Array.isArray(ps?.providers) ? ps.providers.some((/** @type {any} */ p) => p.hasKey) : !!ps?.providers?.hasKey;
  ui.warn = (!ps?.ok || !hasKey) ? 'No provider key detected (or the vault is locked). Add a key + unlock in Settings, then reopen the Lab.' : '';
  // Defaults: A = a cloud pair (cloud main + the real WEB ACTOR default, Haiku); B =
  // on-device where possible (local main + local web actor) so the headline comparison
  // is cloud-vs-local.
  const firstCloud = ui.cloudOptions[0];
  const localMain = ui.allOptions.find((o) => o.provider === 'local-webgpu');
  // The web actor's TRUE default model is the active provider's defaultRunnerModel
  // (Haiku on OpenRouter/Anthropic) — resolved from provider/status, NOT a /haiku/
  // guess over the user's curated list. That id often isn't in the curated set (an
  // OR user commonly curates only their main model), so surface it as a selectable
  // option; otherwise the <select> falls back to GLM and misrepresents what runs.
  const providers = Array.isArray(ps?.providers) ? ps.providers : [];
  const activeProv = providers.find((/** @type {any} */ p) => p.name === firstCloud?.provider)
    ?? providers.find((/** @type {any} */ p) => p.hasKey && p.name !== 'local-webgpu');
  const webActorDefault = activeProv?.defaultRunnerModel || '';
  if (webActorDefault && !ui.cloudOptions.some((o) => o.model === webActorDefault)) {
    ui.cloudOptions = [
      { value: `${activeProv.name}::${webActorDefault}`, model: webActorDefault, provider: activeProv.name, providerLabel: activeProv.label ?? activeProv.name, label: `${webActorDefault} (web actor default)` },
      ...ui.cloudOptions,
    ];
  }
  if (!ui.mainA) ui.mainA = firstCloud?.value ?? ui.allOptions[0]?.value ?? '';
  if (!ui.runnerA) ui.runnerA = webActorDefault || (ui.cloudOptions[0]?.model ?? '');
  if (!ui.mainB) ui.mainB = localMain?.value ?? ui.mainA;
  if (!ui.runnerB) ui.runnerB = ui.localLabel ? 'local' : (webActorDefault || ui.runnerA);
  ui.loaded = true;
  m.redraw();
}

const mainOptionEls = () => ui.allOptions.map((o) => m('option', { value: o.value }, `${o.providerLabel} · ${o.label}`));
const runnerOptionEls = () => [
  ...ui.cloudOptions.map((o) => m('option', { value: o.model }, `${o.providerLabel} · ${o.label}`)),
  ui.localLabel ? m('option', { value: 'local' }, `local · ${ui.localLabel}`) : null,
];

async function runAB() {
  if (ui.running) return;
  ui.running = true; ui.ab = null; ui.single = null; ui.log = []; ui.progress = null; m.redraw();
  try {
    ui.ab = await ensureEngine().runAB(configFor('A'), configFor('B'), ui.suiteId, ui.showTabs, (/** @type {any} */ p) => { ui.progress = p; m.redraw(); });
  } catch (e) { pushLog(`A/B aborted: ${/** @type {{ message?: string }} */ (e)?.message ?? e}`); }
  finally { ui.running = false; ui.progress = null; m.redraw(); }
}

async function runSingle() {
  if (ui.running) return;
  ui.running = true; ui.ab = null; ui.single = null; ui.log = []; ui.progress = null; m.redraw();
  try {
    ui.single = await ensureEngine().runOne(configFor('A'), ui.suiteId, ui.showTabs, (/** @type {any} */ p) => { ui.progress = p; m.redraw(); });
  } catch (err) { pushLog(`run aborted: ${/** @type {{ message?: string }} */ (err)?.message ?? err}`); }
  finally { ui.running = false; ui.progress = null; m.redraw(); }
}

// Baseline vs prewalk — the SAME config (side A's pair), both legs as goal
// runs; the only variable is the prewalk handoff. This is THE gate for
// flipping prewalkEnabled on by default: it must hold pass rate while
// cutting $ and time (compare stencil.so/blog/prewalk's receipts).
async function runPrewalkAB() {
  if (ui.running) return;
  ui.running = true; ui.ab = null; ui.single = null; ui.log = []; ui.progress = null; m.redraw();
  try {
    const base = { ...configFor('A'), goal: true };
    ui.ab = await ensureEngine().runAB(
      { ...base, prewalk: false },
      { ...base, prewalk: true },
      ui.suiteId, ui.showTabs,
      (/** @type {any} */ p) => { ui.progress = p; m.redraw(); },
    );
  } catch (e) { pushLog(`prewalk A/B aborted: ${/** @type {{ message?: string }} */ (e)?.message ?? e}`); }
  finally { ui.running = false; ui.progress = null; m.redraw(); }
}

// Engine-actor A/B — side A's config, both legs NORMAL turns (not goal), on the
// engine-actor suite; the only variable is enginePrewalk. The gate for flipping
// enginePrewalkEnabled on: pass rate holds while runner-$ (the engine actor's
// spend) drops. Forces the engine-actor suite so there's multi-turn actor work
// to swap on.
async function runEnginePrewalkAB() {
  if (ui.running) return;
  ui.running = true; ui.ab = null; ui.single = null; ui.log = []; ui.progress = null;
  const suiteId = 'engine-actor';
  m.redraw();
  try {
    // Force normal turns (not goal) whatever the 'goal runs' checkbox says — this
    // A/B isolates the engine-actor swap on plain message_actor turns, per the
    // contract note above. (runPrewalkAB is the goal-run counterpart.)
    const base = { ...configFor('A'), goal: false };
    ui.ab = await ensureEngine().runAB(
      { ...base, enginePrewalk: false },
      { ...base, enginePrewalk: true },
      suiteId, ui.showTabs,
      (/** @type {any} */ p) => { ui.progress = p; m.redraw(); },
    );
  } catch (e) { pushLog(`engine-actor A/B aborted: ${/** @type {{ message?: string }} */ (e)?.message ?? e}`); }
  finally { ui.running = false; ui.progress = null; m.redraw(); }
}

/** @param {number} ms */
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
/** @param {number} [n] */
const usd = (n) => `$${(n ?? 0).toFixed(5)}`;
/** @param {number} [n] */
const runnerUsd = (n) => ((n ?? 0) > 0 ? usd(n) : 'free'); // local runner reads "free"
/** @param {string} id */
const shortModel = (id) => String(id).replace(/^[a-z-]+\//, '').replace(/-\d{8}$/, ''); // strip provider/ + date
/** @param {{ mainModel: string, runnerCfg: string, goal?: boolean, prewalk?: boolean, enginePrewalk?: boolean }} cfg */
const pairLabel = (cfg) => `${shortModel(cfg.mainModel)} / ${cfg.runnerCfg === 'local' ? 'local' : shortModel(cfg.runnerCfg)}`
  + `${cfg.goal ? ' · goal' : ''}${cfg.prewalk ? ' · prewalk' : ''}${cfg.enginePrewalk ? ' · engine-prewalk' : ''}`;

/** @param {{ a: any, b: any, delta: any }} result */
function abBoard({ a, b, delta }) {
  /**
   * @param {string} label
   * @param {string | number} av
   * @param {string | number} bv
   * @param {string} [dv]
   */
  const row = (label, av, bv, dv) => m('.eval-row', [
    m('.eval-cell.lab', label), m('.eval-cell', String(av)), m('.eval-cell', String(bv)), m('.eval-cell.delta', dv ?? ''),
  ]);
  return m('.eval-board', [
    m('.eval-row.head', [m('.eval-cell.lab', 'main / runner'), m('.eval-cell', `A · ${pairLabel(a.config)}`), m('.eval-cell', `B · ${pairLabel(b.config)}`), m('.eval-cell.delta', 'Δ')]),
    row('pass rate', `${a.card.passRate}% (${a.card.passed}/${a.card.total})`, `${b.card.passRate}% (${b.card.passed}/${b.card.total})`, `${delta.passRateDelta >= 0 ? '+' : ''}${delta.passRateDelta}%`),
    row('avg latency', secs(a.card.avgDurationMs), secs(b.card.avgDurationMs)),
    row('runner tokens', a.card.avgRunnerTokens, b.card.avgRunnerTokens),
    row('runner $/task', runnerUsd(a.card.avgRunnerCostUsd), runnerUsd(b.card.avgRunnerCostUsd)),
    row('main $/task', usd(a.card.avgCostUsd), usd(b.card.avgCostUsd)),
    row('total $/task', usd(a.card.avgTotalCostUsd), usd(b.card.avgTotalCostUsd)),
    delta.regressions.length
      ? m('p.error.eval-verdict', `B failed these (A passed): ${delta.regressions.join(', ')}`)
      : m('p.eval-ok.eval-verdict', '✓ B matched A on every task A passed'),
    delta.fixes.length ? m('p.muted.eval-verdict', `B fixed (A had failed): ${delta.fixes.join(', ')}`) : null,
  ]);
}

/** @param {{ config: any, card: any }} result */
function singleBoard({ config, card }) {
  return m('.eval-board', [
    m('.eval-row.head', [m('.eval-cell.lab', pairLabel(config)), m('.eval-cell', `${card.passRate}% (${card.passed}/${card.total})`), m('.eval-cell', secs(card.avgDurationMs)), m('.eval-cell.delta', '')]),
    m('p.muted.eval-verdict', `runner ${card.avgRunnerTokens} tok (${runnerUsd(card.avgRunnerCostUsd)}) · main ${usd(card.avgCostUsd)} · total ${usd(card.avgTotalCostUsd)}/task · ${card.avgSteps} avg steps`),
  ]);
}

/** @param {'A' | 'B'} side */
const pairCol = (side) => m('.eval-pair', [
  m('.eval-pair-head', side),
  m('label.eval-field', ['main model', m('select', { value: side === 'A' ? ui.mainA : ui.mainB, disabled: ui.running, onchange: (/** @type {{ target: HTMLSelectElement }} */ e) => { ui[side === 'A' ? 'mainA' : 'mainB'] = e.target.value; } }, mainOptionEls())]),
  m('label.eval-field', ['web actor', m('select', { value: side === 'A' ? ui.runnerA : ui.runnerB, disabled: ui.running, onchange: (/** @type {{ target: HTMLSelectElement }} */ e) => { ui[side === 'A' ? 'runnerA' : 'runnerB'] = e.target.value; } }, runnerOptionEls())]),
]);

// The selected suite (the id is a free string in state; SUITES is keyed).
const suite = () => SUITES[/** @type {keyof typeof SUITES} */ (ui.suiteId)];

// Suites the home Lab can actually run. The web-actor suite uses the __FIXTURE__
// sentinel that ONLY eval/runner.js (the CDP bench, fed by a local fixture server)
// substitutes — the home Lab's eval-engine has no fixture server, so those tasks
// would all-fail here. Hide any suite whose tasks carry the sentinel (self-
// maintaining: a new fixture suite is filtered automatically). why detect the
// sentinel, not the id: keeps the two surfaces from drifting.
const usesFixture = (/** @type {any} */ s) => (s.tasks ?? []).some((/** @type {any} */ t) =>
  String(t.startUrl ?? '').includes('__FIXTURE__') || String(t.prompt ?? '').includes('__FIXTURE__'));
const labSuites = Object.values(SUITES).filter((/** @type {any} */ s) => !usesFixture(s));

export const EvalSection = {
  oninit() { if (!ui.loaded) loadModels().catch(() => {}); },
  view() {
    return m('div.eval-lab', [
      m('h2', 'Lab'),
      m('p.muted', ['Pit two model configs head-to-head on real web tasks — the same agent loop, tools, and gates a live chat uses. Each config is a pair: a ',
        m('strong', 'main'), ' model (plans + orchestrates) and a ', m('strong', 'web actor'), ' (reads/acts on pages). ',
        m('a.eval-link', { href: '#', onclick: (/** @type {Event} */ e) => { e.preventDefault(); openOptions('providers'); } }, 'Configure models →')]),
      ui.warn ? m('p.error', ui.warn) : null,
      m('p.eval-note', 'A run takes over the agent session (your current chat resets) and drives a hidden browser window — don\'t start a chat while it runs.'),
      m('.eval-controls', [
        m('label.eval-field', ['suite', m('select', { value: ui.suiteId, disabled: ui.running, onchange: (/** @type {{ target: HTMLSelectElement }} */ e) => { ui.suiteId = e.target.value; } },
          labSuites.map((/** @type {any} */ s) => m('option', { value: s.id }, `${s.label} · ${s.tasks.length} tasks`)))]),
        m('label.eval-check', {
          title: 'Off: the agent runs in a hidden, background window. On: a visible window (its own tab bar) you can watch — it never takes focus either way.',
        }, [m('input', { type: 'checkbox', checked: ui.showTabs, disabled: ui.running, onchange: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.showTabs = e.target.checked; } }), 'show tabs']),
        m('label.eval-check', {
          title: 'Run every task as an autonomous GOAL run (plan → todo checklist → turns until complete_goal) instead of a single chat turn. Slower per task; exercises the goal loop the prewalk A/B measures.',
        }, [m('input', { type: 'checkbox', checked: ui.goalRuns, disabled: ui.running, onchange: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.goalRuns = e.target.checked; } }), 'goal runs']),
      ]),
      m('.eval-pairs', [pairCol('A'), m('.eval-pair-vs', 'vs'), pairCol('B')]),
      m('.eval-controls', [
        m('button.eval-btn.primary', { disabled: ui.running || !ui.mainA || !ui.mainB, onclick: runAB }, 'Run A/B'),
        m('button.eval-btn', { disabled: ui.running || !ui.mainA, onclick: runSingle }, 'Run A only'),
        m('button.eval-btn', {
          disabled: ui.running || !ui.mainA,
          title: 'Side A\'s config, two legs of goal runs: baseline vs prewalk (plan on the main model, hand the live context to a cheap executor at the first landed action). The gate for turning the prewalk setting on: pass rate must hold while $ and time drop.',
          onclick: runPrewalkAB,
        }, 'Run prewalk A/B'),
        m('button.eval-btn', {
          disabled: ui.running || !ui.mainA,
          title: 'Side A\'s config on the engine-actor suite (multi-turn VM/Notebook work): baseline vs engine-prewalk (VM/Notebook/App actors run turn 1 on the main model, then swap to the cheap executor). The gate for turning engine-actor prewalk on: pass rate holds while the runner-$ (the actor\'s spend) drops.',
          onclick: runEnginePrewalkAB,
        }, 'Run engine A/B'),
      ]),
      m('button.eval-disclosure', { onclick: () => { ui.showTasks = !ui.showTasks; } },
        `${ui.showTasks ? '▾' : '▸'} exactly what the ${suite()?.tasks.length ?? 0} ${ui.suiteId} tasks run`),
      ui.showTasks ? m('.eval-tasks', (suite()?.tasks ?? []).map((/** @type {any} */ t) =>
        m('.eval-task', [
          m('span.eval-task-title', t.title),
          m('span.eval-task-prompt', t.prompt),
          m('span.eval-task-url', t.startUrl || 'no web page (compute / agent task)'),
        ]))) : null,
      ui.running ? m('p.eval-running', ui.progress ? `running ${ui.progress.id} — ${ui.progress.index + 1}/${ui.progress.total}…` : 'starting…') : null,
      ui.ab ? abBoard(ui.ab) : null,
      ui.single ? singleBoard(ui.single) : null,
      ui.log.length ? m('pre.eval-log', ui.log.join('\n')) : null,
    ]);
  },
};
