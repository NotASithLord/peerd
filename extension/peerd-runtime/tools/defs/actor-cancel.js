// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// actor_cancel — stop an async actor's result from coming back.
//
// Frees the per-chat outstanding slot and suppresses the reintegration wake.
// (The child loop settles on its own at its step cap; cancel just drops the
// result — truly aborting a running loop mid-step is a follow-on.)

// why: ctx.actorCancel is the SW-bound cancel fn (scoped to this session),
// injected outside the base ToolContext; narrow ctx to it at the use site. The
// result shape mirrors makeAsyncActors' actorCancel (actor/async-actors.js).
/** @typedef {{ actorCancel?: (taskId: string) => ({ ok: true, content: string } | { ok: false, error: string } | Promise<{ ok: true, content: string } | { ok: false, error: string }>) }} ActorCancelCtx */

/** @type {import('/shared/tool-types.js').Tool} */
export const actorCancelTool = composeTool("actor_cancel", {

  execute: async (args, ctx) => {
    // why: narrow ctx to the SW-bound actorCancel slot.
    const sctx = /** @type {ActorCancelCtx} */ (/** @type {unknown} */ (ctx));
    if (typeof sctx.actorCancel !== 'function') {
      return { ok: false, error: 'async_actor_unavailable' };
    }
    if (typeof args?.taskId !== 'string' || !args.taskId) {
      return { ok: false, error: 'taskId_required' };
    }
    const res = await sctx.actorCancel(args.taskId);
    return res.ok ? { ok: true, content: res.content } : { ok: false, error: res.error };
  },
});
