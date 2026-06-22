// @ts-check
// The Lab — the home page's model-testing bench. Pit two CONFIGS head-to-head on
// the same real web tasks (the actual agent loop, tools, and gates — not a mock).
//
// A config is a PAIR of models, because that's what actually runs a task:
//   • the MAIN model — the chat agent that plans + orchestrates do/get/check
//   • the RUNNER model — the disposable sub-agent that reads/acts on pages
// Both are configurable per side, so you can compare e.g. "cloud main + cloud
// runner" vs "fully on-device (local main + local runner)" — and the cost is
// honest: a fully-local config reads $0 total.
//
// Brand rule: monochrome; pass/fail by glyph (✓/✗) + the lone semantic red.
// The engine (eval/eval-engine.js) owns the SW port + run loop; this is the view.
//
// NB: a run takes over the agent session (session/reset) + drives a hidden window.

import m from '/vendor/mithril/mithril.js';
import browser from '/vendor/browser-polyfill.js';
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
  suiteId: 'simple', showTabs: false, showTasks: false,
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
  return { mainProvider: provider, mainModel: model, runnerCfg: side === 'A' ? ui.runnerA : ui.runnerB };
};

async function loadModels() {
  const e = ensureEngine();
  const [opts, ls, ps] = await Promise.all([e.modelsOptions(), e.localStatus(), e.providerStatus()]);
  ui.allOptions = opts || [];                                                    // MAIN selects: every model (incl. local once downloaded)
  ui.cloudOptions = ui.allOptions.filter((o) => o.provider !== 'local-webgpu');  // RUNNER selects: cloud ids + the 'local' sentinel
  ui.localLabel = (ls?.available || ls?.downloaded) ? (ls.label || 'Local model') : null;
  const hasKey = Array.isArray(ps?.providers) ? ps.providers.some((/** @type {any} */ p) => p.hasKey) : !!ps?.providers?.hasKey;
  ui.warn = (!ps?.ok || !hasKey) ? 'No provider key detected (or the vault is locked). Add a key + unlock in Settings, then reopen the Lab.' : '';
  // Defaults: A = a cloud pair (cloud main + Haiku runner); B = on-device where
  // possible (local main + local runner) so the headline comparison is cloud-vs-local.
  const haiku = ui.cloudOptions.find((o) => /haiku/i.test(o.model));
  const firstCloud = ui.cloudOptions[0];
  const localMain = ui.allOptions.find((o) => o.provider === 'local-webgpu');
  if (!ui.mainA) ui.mainA = firstCloud?.value ?? ui.allOptions[0]?.value ?? '';
  if (!ui.runnerA) ui.runnerA = haiku ? haiku.model : (ui.cloudOptions[0]?.model ?? '');
  if (!ui.mainB) ui.mainB = localMain?.value ?? ui.mainA;
  if (!ui.runnerB) ui.runnerB = ui.localLabel ? 'local' : (ui.cloudOptions.find((o) => o.model !== ui.runnerA)?.model ?? ui.runnerA);
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

/** @param {number} ms */
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
/** @param {number} [n] */
const usd = (n) => `$${(n ?? 0).toFixed(5)}`;
/** @param {number} [n] */
const runnerUsd = (n) => ((n ?? 0) > 0 ? usd(n) : 'free'); // local runner reads "free"
/** @param {string} id */
const shortModel = (id) => String(id).replace(/^[a-z-]+\//, '').replace(/-\d{8}$/, ''); // strip provider/ + date
/** @param {{ mainModel: string, runnerCfg: string }} cfg */
const pairLabel = (cfg) => `${shortModel(cfg.mainModel)} / ${cfg.runnerCfg === 'local' ? 'local' : shortModel(cfg.runnerCfg)}`;

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
  m('label.eval-field', ['page runner', m('select', { value: side === 'A' ? ui.runnerA : ui.runnerB, disabled: ui.running, onchange: (/** @type {{ target: HTMLSelectElement }} */ e) => { ui[side === 'A' ? 'runnerA' : 'runnerB'] = e.target.value; } }, runnerOptionEls())]),
]);

// The selected suite (the id is a free string in state; SUITES is keyed).
const suite = () => SUITES[/** @type {keyof typeof SUITES} */ (ui.suiteId)];

export const EvalSection = {
  oninit() { if (!ui.loaded) loadModels().catch(() => {}); },
  view() {
    return m('div.eval-lab', [
      m('h2', 'Lab'),
      m('p.muted', ['Pit two model configs head-to-head on real web tasks — the same agent loop, tools, and gates a live chat uses. Each config is a pair: a ',
        m('strong', 'main'), ' model (plans + orchestrates) and a ', m('strong', 'page runner'), ' (reads/acts on pages). ',
        m('a.eval-link', { href: '#', onclick: (/** @type {Event} */ e) => { e.preventDefault(); openOptions('providers'); } }, 'Configure models →')]),
      ui.warn ? m('p.error', ui.warn) : null,
      m('p.eval-note', 'A run takes over the agent session (your current chat resets) and drives a hidden browser window — don\'t start a chat while it runs.'),
      m('.eval-controls', [
        m('label.eval-field', ['suite', m('select', { value: ui.suiteId, disabled: ui.running, onchange: (/** @type {{ target: HTMLSelectElement }} */ e) => { ui.suiteId = e.target.value; } },
          [m('option', { value: 'simple' }, 'Simple · 30 tasks'), m('option', { value: 'robust' }, 'Robust · 55 tasks')])]),
        m('label.eval-check', {
          title: 'Off: the agent runs in a hidden, background window. On: a visible window (its own tab bar) you can watch — it never takes focus either way.',
        }, [m('input', { type: 'checkbox', checked: ui.showTabs, disabled: ui.running, onchange: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.showTabs = e.target.checked; } }), 'show tabs']),
      ]),
      m('.eval-pairs', [pairCol('A'), m('.eval-pair-vs', 'vs'), pairCol('B')]),
      m('.eval-controls', [
        m('button.eval-btn.primary', { disabled: ui.running || !ui.mainA || !ui.mainB, onclick: runAB }, 'Run A/B'),
        m('button.eval-btn', { disabled: ui.running || !ui.mainA, onclick: runSingle }, 'Run A only'),
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
