// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// actor_tasks — peek at this chat's async spawned WITHOUT blocking.
//
// Async spawned actors (DESIGN-11) report back on their own as a later turn, so
// the model rarely needs this. It exists for the occasional "is it still
// going?" check — deliberately non-blocking (a snapshot, never a wait) to
// avoid the premature-poll trap that collapses async back into sync.

// why: ctx.actorTasks is the SW-bound snapshot fn (scoped to this session),
// injected outside the base ToolContext; narrow ctx to it at the use site. The
// snapshot shape mirrors makeAsyncActors' actorTasks (actor/async-actors.js).
/** @typedef {{ taskId: string, task: string, status: string, lastOutput: string, childSessionId?: string|null, visibleTools?: string[]|null }} ActorTaskSnapshot */
/** @typedef {{ actorTasks?: () => ActorTaskSnapshot[]|Promise<ActorTaskSnapshot[]> }} ActorTasksCtx */

/** @type {import('/shared/tool-types.js').Tool} */
export const actorTasksTool = composeTool("actor_tasks", {

  execute: async (_args, ctx) => {
    // why: narrow ctx to the SW-bound actorTasks snapshot slot.
    const sctx = /** @type {ActorTasksCtx} */ (/** @type {unknown} */ (ctx));
    if (typeof sctx.actorTasks !== 'function') {
      return { ok: false, error: 'async_actor_unavailable' };
    }
    const tasks = await sctx.actorTasks();
    if (!tasks.length) return { ok: true, content: 'No async spawned in this chat.' };
    const lines = tasks.map((t) => {
      const tail = t.lastOutput ? `\n  …${t.lastOutput.slice(-200)}` : '';
      return `${t.taskId} [${t.status}] ${t.task}${tail}`;
    });
    return { ok: true, content: lines.join('\n') };
  },
});
