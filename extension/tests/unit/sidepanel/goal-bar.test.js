// @ts-check
// GoalBar — the self-hiding "Goal · running · turn N · Stop" strip shown while
// THIS chat's autonomous goal run is live (loop/goal-runner.js). These tests pin
// the visibility rule (hidden unless an active run), the turn-count readout, and
// that Stop dispatches agent/stop (which the SW routes to halt the whole run).

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { GoalBar } from '/sidepanel/components/goal-bar.js';

/** @typedef {{ active: boolean, iteration: number, maxIterations: number, goal: string } | null} GoalState */

/**
 * Fake send(): records the messages dispatched.
 * @returns {((msg: object) => Promise<any>) & { calls: object[] }}
 */
const makeSend = () => {
  /** @type {object[]} */
  const calls = [];
  return Object.assign(/** @param {object} msg */ async (msg) => { calls.push(msg); return { ok: true }; }, { calls });
};

/**
 * @param {GoalState} goal
 * @param {((msg: object) => Promise<any>)} send
 */
const mount = (goal, send) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(GoalBar, { goal, send }) });
  m.redraw.sync();
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

describe('GoalBar (active goal run strip)', () => {
  it('renders nothing when there is no run', () => {
    const a = mount(null, makeSend());
    try { expect(a.root.querySelector('.goal-bar')).toBe(null); } finally { a.unmount(); }
  });

  it('renders nothing when the run is not active', () => {
    const a = mount({ active: false, iteration: 3, maxIterations: 40, goal: 'g' }, makeSend());
    try { expect(a.root.querySelector('.goal-bar')).toBe(null); } finally { a.unmount(); }
  });

  it('shows the label, turn count, and goal text while active', () => {
    const { root, unmount } = mount({ active: true, iteration: 3, maxIterations: 40, goal: 'build a drum machine' }, makeSend());
    try {
      const bar = root.querySelector('.goal-bar');
      expect(!!bar).toBe(true);
      expect(root.querySelector('.goal-bar-label')?.textContent).toBe('Goal');
      expect(root.querySelector('.goal-bar-meta')?.textContent).toBe('turn 3 / 40');
      expect(root.querySelector('.goal-bar-text')?.textContent).toBe('build a drum machine');
    } finally { unmount(); }
  });

  it('Stop dispatches agent/stop (halts the whole run)', () => {
    const send = makeSend();
    const { root, unmount } = mount({ active: true, iteration: 1, maxIterations: 40, goal: 'g' }, send);
    try {
      const stop = root.querySelector('.goal-bar-stop');
      expect(!!stop).toBe(true);
      /** @type {HTMLButtonElement} */ (stop).click();
      expect(send.calls).toEqual([{ type: 'agent/stop' }]);
    } finally { unmount(); }
  });
});
