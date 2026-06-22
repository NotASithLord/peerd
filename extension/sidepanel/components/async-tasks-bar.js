// @ts-check
// In-flight async-subagent status bar (DESIGN-11). When the agent kicks off
// async subagents (spawn_subagent), their work runs in the SW and lands later
// as a synthetic wake turn — so without a surface the user has no idea anything
// is cooking. The SW pushes the orchestrator's per-parent task snapshot
// (async-tasks/update); this pins a calm, self-hiding bar at the top of the
// chat showing what's still in flight.
//
// Scope: an INDICATOR, not a control surface. The finished result appears in
// the transcript (the wake turn) and a desktop notification; this bar only
// answers "what's running right now". It self-hides when nothing is in flight,
// and never steals focus (role=status / aria-live=polite, DECISIONS #20).
//
// Monochrome per the brand rule — the spinning orb (.peerd-spinner) is the
// only color, exactly like RalphPanel.

import m from '/vendor/mithril/mithril.js';

// `running` = the child loop is going; `done` = finished but its result hasn't
// re-entered the chat yet (drain pending / vault locked). Both read as "still
// cooking" to the user. `delivered`/`cancelled` are terminal (result is in the
// transcript, or it was dropped) — drop them so the bar reflects only live work.
const ACTIVE = new Set(['running', 'done']);

/**
 * One in-flight async-subagent task snapshot pushed by the orchestrator.
 * @typedef {Object} AsyncTask
 * @property {string} taskId
 * @property {string} status      running | done | delivered | cancelled
 * @property {string} [task]      the task description
 * @property {string} [lastOutput] live output tail
 */

export const AsyncTasksBar = {
  /** @param {{ attrs: { tasks?: AsyncTask[] } }} vnode */
  view: ({ attrs: { tasks } }) => {
    const live = (tasks ?? []).filter((t) => ACTIVE.has(t.status));
    if (live.length === 0) return null;

    return m('.async-task-bar', { role: 'status', 'aria-live': 'polite' }, [
      m('.async-task-head', [
        m('span.peerd-spinner.peerd-spinner--sm', { 'aria-hidden': 'true' }),
        m('span.async-task-title',
          live.length === 1 ? '1 background task' : `${live.length} background tasks`),
      ]),
      m('.async-task-rows', live.map((t) =>
        m('.async-task-row', { key: t.taskId }, [
          m('span.async-task-name', { title: t.task }, t.task || '(subagent)'),
          // The live output tail is a sense-of-progress signal; fall back to a
          // plain status word before any output lands.
          t.lastOutput
            ? m('span.async-task-tail', { title: t.lastOutput }, t.lastOutput)
            : m('span.async-task-status', t.status === 'done' ? 'finishing…' : 'working…'),
        ]))),
    ]);
  },
};
