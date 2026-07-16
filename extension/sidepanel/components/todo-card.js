// @ts-check
// Todo card — the chat view's live window onto the goal run's plan-of-record
// (session.todos, written by the todo_* tools during a goal run).
//
// This is the "is it actually working?" answer for goal mode: the agent
// commits its plan as a checklist and the card ticks items off as the run
// progresses — no event plumbing of its own, it just renders the session
// snapshots the panel already receives. Two shapes:
//   - WHILE the run is active: the full ticking checklist.
//   - AFTER the run ends: a collapsed one-line receipt ("Plan ✓ 6/8"), so a
//     finished plan stays as a record without permanently eating ~190px above
//     an unrelated later conversation in the narrow side panel.
// Self-hiding when the session has no list. Grayscale per the brand rule;
// done/pending is carried in the accessibility tree (not just the ✓ glyph +
// strikethrough), and each row exposes its full (possibly-ellipsized) text.

import m from '/vendor/mithril/mithril.js';

/** @typedef {import('/peerd-runtime/todo/core.js').TodoItem} TodoItem */

export const TodoCard = {
  /** @param {{ attrs: { todos?: TodoItem[] | null, active?: boolean } }} vnode */
  view: ({ attrs: { todos, active } }) => {
    if (!Array.isArray(todos) || todos.length === 0) return null;
    const done = todos.filter((t) => t.status === 'done').length;
    const total = todos.length;
    const complete = done === total;
    const next = todos.find((t) => t.status !== 'done') ?? null;

    // why aria-live only on the count (not the whole card): every todo_check
    // mutates the list, and a card-wide live region would re-announce all N
    // rows on each tick. Scoping it to "N/M done" keeps screen readers quiet;
    // the GoalBar already narrates run liveness.
    const meta = m('span.todo-card-meta', {
      'aria-live': active ? 'polite' : 'off',
      'aria-label': `${done} of ${total} steps done`,
    }, `${complete ? '✓ ' : ''}${done}/${total}`);

    // Ended run → collapsed receipt. No list, no "next" emphasis (nothing is
    // being worked), no live region churn.
    if (!active) {
      return m('.todo-card.todo-card--done', [
        m('.todo-card-head', [
          m('span.todo-card-title', 'Plan'),
          meta,
          complete ? null : m('span.todo-card-live', 'ended'),
        ]),
      ]);
    }

    return m('.todo-card', [
      m('.todo-card-head', [
        m('span.todo-card-title', 'Plan'),
        meta,
        next ? m('span.todo-card-live', 'in progress') : null,
      ]),
      m('ul.todo-list', todos.map((t) => {
        const isDone = t.status === 'done';
        const isNext = !!next && t.id === next.id;
        // Full text in the title so an ellipsized row is recoverable on hover
        // (the DOM text already gives it to screen readers); fold validation in.
        const title = t.validation ? `${t.text} — verify: ${t.validation}` : t.text;
        return m('li.todo-item', {
          key: t.id,
          class: [isDone ? 'is-done' : '', isNext ? 'is-next' : ''].filter(Boolean).join(' '),
          title,
          // done/pending carried in the a11y tree, not only the ✓ + strikethrough.
          'aria-label': `${t.text} — ${isDone ? 'done' : 'pending'}`,
        }, [
          m('span.todo-box', { 'aria-hidden': 'true' }, isDone ? '✓' : ''),
          m('span.todo-text', t.text),
        ]);
      })),
    ]);
  },
};
