// @ts-check
// Todo card — the chat view's live window onto the goal run's plan-of-record
// (session.todos, written by the todo_* tools during a goal run).
//
// This is the "is it actually working?" answer for goal mode: the agent
// commits its plan as a checklist and the card ticks items off as the run
// progresses — no event plumbing of its own, it just renders the session
// snapshots the panel already receives. Self-hiding when the session has no
// list. It stays visible after a run ends: a finished checklist is the
// run's receipt, not chrome to clean up. Grayscale per the brand rule.

import m from '/vendor/mithril/mithril.js';

/** @typedef {import('/peerd-runtime/todo/core.js').TodoItem} TodoItem */

export const TodoCard = {
  /** @param {{ attrs: { todos?: TodoItem[] | null, active?: boolean } }} vnode */
  view: ({ attrs: { todos, active } }) => {
    if (!Array.isArray(todos) || todos.length === 0) return null;
    const done = todos.filter((t) => t.status === 'done').length;
    const next = todos.find((t) => t.status !== 'done') ?? null;
    return m('.todo-card', { role: 'status', 'aria-label': `Plan: ${done} of ${todos.length} steps done` }, [
      m('.todo-card-head', [
        m('span.todo-card-title', 'Plan'),
        m('span.todo-card-meta', `${done}/${todos.length}`),
        // The run's liveness is the GoalBar's job; here just a soft hint
        // that the list is still being worked (vs a finished receipt).
        active && next ? m('span.todo-card-live', 'in progress') : null,
      ]),
      m('ul.todo-list', todos.map((t) => {
        const isDone = t.status === 'done';
        const isNext = !!next && t.id === next.id;
        return m('li.todo-item', {
          key: t.id,
          class: [isDone ? 'is-done' : '', isNext ? 'is-next' : ''].filter(Boolean).join(' '),
          title: t.validation ? `verify: ${t.validation}` : undefined,
        }, [
          m('span.todo-box', { 'aria-hidden': 'true' }, isDone ? '✓' : ''),
          m('span.todo-text', t.text),
        ]);
      })),
    ]);
  },
};
