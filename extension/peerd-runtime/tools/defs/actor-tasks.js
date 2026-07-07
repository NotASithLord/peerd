// @ts-check
// actor_tasks — peek at this chat's async spawned WITHOUT blocking.
//
// Async spawned actors (DESIGN-11) report back on their own as a later turn, so
// the model rarely needs this. It exists for the occasional "is it still
// going?" check — deliberately non-blocking (a snapshot, never a wait) to
// avoid the premature-poll trap that collapses async back into sync.

// why: ctx.actorTasks is the SW-bound snapshot fn (scoped to this session),
// injected outside the base ToolContext; narrow ctx to it at the use site. The
// snapshot shape mirrors makeAsyncActors' actorTasks (actor/async-actors.js).
/** @typedef {{ taskId: string, task: string, status: string, lastOutput: string }} ActorTaskSnapshot */
/** @typedef {{ actorTasks?: () => ActorTaskSnapshot[] }} ActorTasksCtx */

/** @type {import('/shared/tool-types.js').Tool} */
export const actorTasksTool = {
  name: 'actor_tasks',
  primitive: 'spawned',
  description: [
    'Peek at the async spawned you started in THIS chat: each one\'s status',
    '(running / done / delivered / cancelled) and a tail of its recent output.',
    'NON-BLOCKING — a snapshot, never a wait. You rarely need this: results come',
    'back on their own as a later turn. Do NOT call it in a loop to wait.',
  ].join(' '),
  schema: { type: 'object', properties: {} },
  sideEffect: 'read',
  origins: () => [],

  execute: async (_args, ctx) => {
    // why: narrow ctx to the SW-bound actorTasks snapshot slot.
    const sctx = /** @type {ActorTasksCtx} */ (/** @type {unknown} */ (ctx));
    if (typeof sctx.actorTasks !== 'function') {
      return { ok: false, error: 'async_actor_unavailable' };
    }
    const tasks = sctx.actorTasks();
    if (!tasks.length) return { ok: true, content: 'No async spawned in this chat.' };
    const lines = tasks.map((t) => {
      const tail = t.lastOutput ? `\n  …${t.lastOutput.slice(-200)}` : '';
      return `${t.taskId} [${t.status}] ${t.task}${tail}`;
    });
    return { ok: true, content: lines.join('\n') };
  },
};
