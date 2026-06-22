// @ts-check
// subagent_cancel — stop an async subagent's result from coming back.
//
// Frees the per-chat outstanding slot and suppresses the reintegration wake.
// (The child loop settles on its own at its step cap; cancel just drops the
// result — truly aborting a running loop mid-step is a follow-on.)

// why: ctx.subagentCancel is the SW-bound cancel fn (scoped to this session),
// injected outside the base ToolContext; narrow ctx to it at the use site. The
// result shape mirrors makeAsyncSubagents' subagentCancel (subagent/async-subagents.js).
/** @typedef {{ subagentCancel?: (taskId: string) => ({ ok: true, content: string } | { ok: false, error: string }) }} SubagentCancelCtx */

/** @type {import('/shared/tool-types.js').Tool} */
export const subagentCancelTool = {
  name: 'subagent_cancel',
  primitive: 'subagent',
  description: [
    'Cancel an async subagent you started (taskId from subagent_tasks): its',
    'result will NOT come back. Use when it\'s no longer needed.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The subagent task id (e.g. as-1).' },
    },
    required: ['taskId'],
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    // why: narrow ctx to the SW-bound subagentCancel slot.
    const sctx = /** @type {SubagentCancelCtx} */ (/** @type {unknown} */ (ctx));
    if (typeof sctx.subagentCancel !== 'function') {
      return { ok: false, error: 'async_subagent_unavailable' };
    }
    if (typeof args?.taskId !== 'string' || !args.taskId) {
      return { ok: false, error: 'taskId_required' };
    }
    const res = sctx.subagentCancel(args.taskId);
    return res.ok ? { ok: true, content: res.content } : { ok: false, error: res.error };
  },
};
