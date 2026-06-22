// @ts-check
// Ralph status panel — component tests over fixture loop state.
//
// The panel is a projection of state.ralph (the port-fed LoopState +
// plan summary sidepanel.js has folded since the loop shipped) plus a
// one-shot ralph/status seed fetch. These tests render the real
// component against fixtures and assert the visibility rules (live
// active → shown; stale terminal → hidden; mid-run seed → shown) and
// that Stop dispatches the existing ralph/halt route — the panel's only
// mutation.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { RalphPanel } from '/sidepanel/components/ralph-panel.js';

/** @typedef {import('/sidepanel/components/ralph-panel.js').LoopState} LoopState */
/** @typedef {{ type: string } & Record<string, any>} Msg */
/** @typedef {((msg: Msg) => Promise<any>) & { calls: Msg[] }} FakeSend */
/** @typedef {{ ralph?: { state?: LoopState|null, summary?: any, log?: any[] }, send: FakeSend }} PanelAttrs */

// Query that asserts presence — a null here is a real test failure.
/**
 * @template {HTMLElement} [T=HTMLElement]
 * @param {ParentNode} root
 * @param {string} sel
 * @returns {T}
 */
const need = (root, sel) => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return /** @type {T} */ (el);
};

const NOW = () => Date.now();

// A richer fixture than LoopState (the SW pushes maxIterations/
// currentTaskId/updatedAt too); cast to the production type it stands in
// for. `lastError: null` mirrors the real port payload's empty state.
/**
 * @param {Partial<LoopState>} [over]
 * @returns {LoopState}
 */
const activeState = (over = {}) => /** @type {LoopState} */ ({
  runId: 'ralph-1',
  status: 'building',
  iteration: 3,
  maxIterations: 200,
  currentTaskId: 't1-wire-the-panel',
  lastError: null,
  startedAt: NOW() - 65_000,
  updatedAt: NOW(),
  ...over,
});

const SUMMARY = { total: 5, pending: 2, 'in-progress': 1, done: 2, blocked: 0 };

// Fake send(): records calls; ralph/status answers with a configurable
// snapshot (the seed path) so tests can model both "active run in
// storage" and "stale terminal run in storage".
/** @param {object} [statusReply] */
const makeSend = (statusReply) => {
  /** @type {Msg[]} */
  const calls = [];
  /** @type {FakeSend} */
  const send = Object.assign(
    /** @param {Msg} msg */
    async (msg) => {
      calls.push(msg);
      if (msg.type === 'ralph/status') {
        return statusReply ?? { ok: true, state: null, plan: { goal: '' }, summary: null };
      }
      return { ok: true };
    },
    { calls },
  );
  return send;
};

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  m.redraw.sync();
};

// Mount with a MUTABLE attrs holder so tests can simulate new port
// pushes (sidepanel.js replacing state.ralph) between redraws.
/** @param {PanelAttrs} attrs */
const mountPanel = async (attrs) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(RalphPanel, attrs) });
  await flush();
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

describe('sidepanel.ralph-panel', () => {
  it('renders goal, iteration, progress, elapsed and the spinner while running', async () => {
    const send = makeSend({
      ok: true, state: activeState(), plan: { goal: 'Ship the widget' }, summary: SUMMARY,
    });
    const attrs = {
      ralph: { state: activeState(), summary: SUMMARY, log: [{ type: 'ralph/committed', title: 'wire the panel' }] },
      send,
    };
    const { root, unmount } = await mountPanel(attrs);
    try {
      const panel = need(root, '.ralph-panel');
      expect(panel).toBeTruthy();
      const text = panel.textContent;
      expect(text).toContain('Ship the widget');
      expect(text).toContain('running');
      expect(text).toContain('iteration 3');
      expect(text).toContain('2/5 tasks');
      expect(text).toContain('1m'); // elapsed ≈ 65s
      expect(text).toContain('committed: wire the panel');
      // The spinner orb is the panel's only color while live.
      expect(panel.querySelector('.peerd-spinner')).toBeTruthy();
      expect([...panel.querySelectorAll('button')].some((b) => b.textContent === 'Stop')).toBe(true);
    } finally { unmount(); }
  });

  it('Stop dispatches the existing ralph/halt route', async () => {
    const send = makeSend({
      ok: true, state: activeState(), plan: { goal: 'Ship it' }, summary: SUMMARY,
    });
    const attrs = { ralph: { state: activeState(), summary: SUMMARY, log: [] }, send };
    const { root, unmount } = await mountPanel(attrs);
    try {
      const stop = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Stop');
      if (!stop) throw new Error('missing Stop button');
      stop.click();
      await flush();
      expect(send.calls.some((c) => c.type === 'ralph/halt')).toBe(true);
    } finally { unmount(); }
  });

  it('a live terminal state shows stopped + dismiss (no Stop, no spinner)', async () => {
    const halted = activeState({ status: 'halted' });
    const send = makeSend({ ok: true, state: halted, plan: { goal: 'Ship it' }, summary: SUMMARY });
    const attrs = { ralph: { state: halted, summary: SUMMARY, log: [{ type: 'ralph/halted' }] }, send };
    const { root, unmount } = await mountPanel(attrs);
    try {
      const panel = need(root, '.ralph-panel');
      expect(panel.textContent).toContain('stopped');
      expect(panel.querySelector('.peerd-spinner')).toBe(null);
      expect([...panel.querySelectorAll('button')].some((b) => b.textContent === 'Stop')).toBe(false);
      need(panel, 'button[aria-label="Dismiss"]').click();
      await flush();
      expect(root.querySelector('.ralph-panel')).toBe(null);
    } finally { unmount(); }
  });

  it('an error state surfaces lastError in red text', async () => {
    const errored = activeState({ status: 'error', lastError: 'hit maxIterations (200)' });
    const send = makeSend({ ok: true, state: errored, plan: { goal: 'Ship it' }, summary: SUMMARY });
    const attrs = { ralph: { state: errored, summary: SUMMARY, log: [] }, send };
    const { root, unmount } = await mountPanel(attrs);
    try {
      const panel = need(root, '.ralph-panel');
      expect(panel.textContent).toContain('error');
      expect(panel.querySelector('.ralph-note.is-error')?.textContent)
        .toContain('hit maxIterations (200)');
    } finally { unmount(); }
  });

  it('seeds from ralph/status when the panel opens mid-run (no live state yet)', async () => {
    const send = makeSend({
      ok: true, state: activeState(), plan: { goal: 'Resume me' }, summary: SUMMARY,
    });
    const attrs = { ralph: { state: null, summary: null, log: [] }, send };
    const { root, unmount } = await mountPanel(attrs);
    try {
      const panel = need(root, '.ralph-panel');
      expect(panel).toBeTruthy();
      expect(panel.textContent).toContain('Resume me');
    } finally { unmount(); }
  });

  it('stays hidden for a stale terminal run in storage', async () => {
    const send = makeSend({
      ok: true,
      state: activeState({ status: 'done' }),
      plan: { goal: 'Old goal' },
      summary: SUMMARY,
    });
    const attrs = { ralph: { state: null, summary: null, log: [] }, send };
    const { root, unmount } = await mountPanel(attrs);
    try {
      expect(root.querySelector('.ralph-panel')).toBe(null);
    } finally { unmount(); }
  });

  it('stays hidden when there is no loop state at all', async () => {
    const send = makeSend({ ok: true, state: null, plan: { goal: '' }, summary: null });
    const attrs = { ralph: { state: null, summary: null, log: [] }, send };
    const { root, unmount } = await mountPanel(attrs);
    try {
      expect(root.querySelector('.ralph-panel')).toBe(null);
    } finally { unmount(); }
  });
});
