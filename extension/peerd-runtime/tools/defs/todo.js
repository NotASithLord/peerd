// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// todo_init / todo_check / todo_add — the goal run's plan-of-record tools.
//
// Revealed to the model ONLY while a goal run is active (tools/exposure.js
// GOAL_ONLY_TOOLS, same seam as complete_goal): a normal chat never sees
// them, so they cost normal turns zero tokens. Like complete_goal, the gate
// is the descriptor filter, not the dispatcher — execute() no-ops gracefully
// when called outside a run (no ctx.todoStore).
//
// The list itself lives on the SESSION record (session.todos), so it rides
// the state snapshots the side panel already receives — the visible todo
// card needs no new event plumbing — and it survives an SW restart with the
// run (goal-runner resumes; the plan is still there).
//
// Read-class: mutating the agent's own bookkeeping is not a page/world side
// effect, so these never confirm and stay legal in every goal iteration
// (mirrors complete_goal's classification). All list logic is pure
// (todo/core.js, Bun-tested); ctx.todoStore.apply is the SW-injected
// serialized read-modify-write bound to this session, so two ops in one
// concurrent wave can't lose an update.

import {
  initTodos, checkTodo, addTodo, nextPending, todoProgress, formatTodoBlock,
} from '../../todo/core.js';

/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('../../todo/core.js').TodoItem} TodoItem */
/** @typedef {import('/shared/tool-types.js').ToolResult | { ok: false, error: string, content?: string }} GoalToolResult */
/** @typedef {Omit<Tool, 'primitive' | 'execute'> & { primitive: 'goal', execute: (args: any, ctx: ToolContext) => Promise<GoalToolResult> }} GoalTool */

/**
 * The SW-injected store bound to this session (buildToolContext). apply()
 * serializes read-modify-writes so concurrent same-turn ops compose.
 * @param {ToolContext} ctx
 * @returns {{ apply: (fn: (todos: TodoItem[] | undefined) => { ok: boolean, todos?: TodoItem[], error?: string, [k: string]: unknown }) => Promise<any> } | null}
 */
const storeOf = (ctx) => {
  const store = /** @type {{ todoStore?: unknown }} */ (ctx).todoStore;
  return store && typeof (/** @type {any} */ (store).apply) === 'function'
    ? /** @type {any} */ (store)
    : null;
};

const NO_RUN = {
  ok: /** @type {const} */ (false),
  error: 'no_active_goal_run',
  content: 'The todo tools are only available during an active goal run.',
};

/**
 * Progress + what's-next footer every todo result carries — the check-off
 * turn always leaves the model looking at the live plan.
 * @param {TodoItem[] | undefined} todos
 */
const footer = (todos) => {
  const { done, total } = todoProgress(todos);
  const next = nextPending(todos);
  return next
    ? `${done}/${total} done. Next: ${next.id}. ${next.text}${next.validation ? ` (verify: ${next.validation})` : ''}`
    : `${done}/${total} done. All items complete — verify the goal end-to-end, then call complete_goal.`;
};

/** @type {GoalTool} */
export const todoInitTool = composeTool("todo_init", {
  execute: async (args, ctx) => {
    const store = storeOf(ctx);
    if (!store) return NO_RUN;
    const out = await store.apply(() => initTodos(args?.items));
    if (!out.ok) return { ok: false, error: out.error };
    return {
      ok: true,
      content: `Plan recorded (${out.todos.length} items).\n${formatTodoBlock(out.todos)}`,
    };
  },
});

/** @type {GoalTool} */
export const todoCheckTool = composeTool("todo_check", {
  execute: async (args, ctx) => {
    const store = storeOf(ctx);
    if (!store) return NO_RUN;
    const out = await store.apply((todos) => checkTodo(todos ?? [], args?.id));
    if (!out.ok) return { ok: false, error: out.error };
    return { ok: true, content: `Done: ${out.item.id}. ${out.item.text}\n${footer(out.todos)}` };
  },
});

/** @type {GoalTool} */
export const todoAddTool = composeTool("todo_add", {
  execute: async (args, ctx) => {
    const store = storeOf(ctx);
    if (!store) return NO_RUN;
    const out = await store.apply((todos) => addTodo(todos, args?.text, args?.validation));
    if (!out.ok) return { ok: false, error: out.error };
    return { ok: true, content: `Added: ${out.item.id}. ${out.item.text}\n${footer(out.todos)}` };
  },
});
