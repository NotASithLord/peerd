// @ts-check
// Goal bar — the chat view's window onto an active Goal run (the mode-row Goal
// toggle → loop/goal-runner.js). Goal mode keeps taking turns toward the goal,
// so the WORK already renders in the transcript like a normal session; this bar
// is just the persistent "still running (turn N) — Stop" affordance for the
// brief gaps BETWEEN turns, where the input bar's streaming Stop isn't shown.
//
// Self-hiding: renders only while state.goal.active. Stop maps to agent/stop,
// which the SW routes to halt the whole run (not just the in-flight turn).
// Calm + monochrome per the brand rule; the spinning orb is the only color.

import m from '/vendor/mithril/mithril.js';

/** @typedef {(msg: object) => Promise<any>} Send */
/** @typedef {{ active: boolean, iteration: number, maxIterations: number, goal: string } | null | undefined} GoalState */

export const GoalBar = {
  /** @param {{ attrs: { goal?: GoalState, send: Send } }} vnode */
  view: ({ attrs: { goal, send } }) => {
    if (!goal || !goal.active) return null;
    const stop = () => send({ type: 'agent/stop' });
    const turns = `turn ${goal.iteration}${goal.maxIterations ? ` / ${goal.maxIterations}` : ''}`;
    return m('.goal-bar', { role: 'status', 'aria-live': 'polite' }, [
      m('span.peerd-spinner.peerd-spinner--sm', { 'aria-hidden': 'true' }),
      m('span.goal-bar-label', 'Goal'),
      m('span.goal-bar-meta', turns),
      goal.goal ? m('span.goal-bar-text', { title: goal.goal }, goal.goal) : null,
      m('.spacer'),
      m('button.secondary.goal-bar-stop', {
        onclick: stop,
        title: 'Stop the goal run',
      }, 'Stop'),
    ]);
  },
};
