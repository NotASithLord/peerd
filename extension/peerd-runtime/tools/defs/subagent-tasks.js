// @ts-check
// subagent_tasks — peek at this chat's async subagents WITHOUT blocking.
//
// Async subagents (DESIGN-11) report back on their own as a later turn, so
// the model rarely needs this. It exists for the occasional "is it still
// going?" check — deliberately non-blocking (a snapshot, never a wait) to
// avoid the premature-poll trap that collapses async back into sync.

// why: ctx.subagentTasks is the SW-bound snapshot fn (scoped to this session),
// injected outside the base ToolContext; narrow ctx to it at the use site. The
// snapshot shape mirrors makeAsyncSubagents' subagentTasks (subagent/async-subagents.js).
/** @typedef {{ taskId: string, task: string, status: string, lastOutput: string }} SubagentTaskSnapshot */
/** @typedef {{ subagentTasks?: () => SubagentTaskSnapshot[] }} SubagentTasksCtx */

/** @type {import('/shared/tool-types.js').Tool} */
export const subagentTasksTool = {
  name: 'subagent_tasks',
  primitive: 'subagent',
  description: [
    'Peek at the async subagents you started in THIS chat: each one\'s status',
    '(running / done / delivered / cancelled) and a tail of its recent output.',
    'NON-BLOCKING — a snapshot, never a wait. You rarely need this: results come',
    'back on their own as a later turn. Do NOT call it in a loop to wait.',
  ].join(' '),
  schema: { type: 'object', properties: {} },
  sideEffect: 'read',
  origins: () => [],

  execute: async (_args, ctx) => {
    // why: narrow ctx to the SW-bound subagentTasks snapshot slot.
    const sctx = /** @type {SubagentTasksCtx} */ (/** @type {unknown} */ (ctx));
    if (typeof sctx.subagentTasks !== 'function') {
      return { ok: false, error: 'async_subagent_unavailable' };
    }
    const tasks = sctx.subagentTasks();
    if (!tasks.length) return { ok: true, content: 'No async subagents in this chat.' };
    const lines = tasks.map((t) => {
      const tail = t.lastOutput ? `\n  …${t.lastOutput.slice(-200)}` : '';
      return `${t.taskId} [${t.status}] ${t.task}${tail}`;
    });
    return { ok: true, content: lines.join('\n') };
  },
};
