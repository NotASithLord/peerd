// @ts-check
// complete_goal — end the autonomous Goal run.
//
// Goal mode (the mode-row Goal toggle, loop/goal-runner.js) keeps re-entering
// the agent turn until the agent decides the goal is met. THIS tool is how it
// decides: calling it stops the loop. It is REVEALED to the model only while a
// goal run is active (tools/exposure.js GOAL_ONLY_TOOLS drops it from the main
// descriptor list otherwise), so a normal chat never sees it. NOTE the gate is
// the descriptor filter, NOT the dispatcher: complete_goal is a normal
// main-agent tool, so a stray call outside a run still reaches execute() — which
// is why execute() below no-ops (returns no_active_goal_run) when there's no run
// to end. Two layers: hidden from the model, harmless if called anyway.
//
// Read-class + no egress: it touches no external surface, just signals the
// SW-side run controller via ctx.completeGoalRun (injected in buildToolContext,
// bound to this session). So it never confirms and the origin/egress gates pass
// vacuously — the only "effect" is ending the user's own background run.

// why: 'goal' is outside the base Primitive union (same pattern as the dweb
// tools — a tool-local primitive declared via a narrowed typedef so the central
// union stays put). ctx.completeGoalRun is SW-injected only; absent → the tool
// reports it isn't in a goal run rather than throwing.
/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult | { ok: false, error: string, content?: string }} GoalToolResult */
/** @typedef {Omit<Tool, 'primitive' | 'execute'> & { primitive: 'goal', execute: (args: any, ctx: ToolContext) => Promise<GoalToolResult> }} GoalTool */

/** @type {GoalTool} */
export const completeGoalTool = {
  name: 'complete_goal',
  primitive: 'goal',
  description: [
    'End the autonomous goal run: call this when — and only when — the current',
    'goal is FULLY achieved, or when you are genuinely blocked and cannot make',
    'further progress. Pass a one-line summary of the outcome. After this the',
    'loop stops and control returns to the user. Only available while a goal run',
    'is active.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'One line: what was accomplished, or why you are stopping (if blocked).',
      },
    },
    required: ['summary'],
  },
  // Read-class control signal — no external side effect, so no confirmation.
  sideEffect: 'read',
  // No web origin is touched; return [] so the origin/egress gates pass.
  origins: () => [],

  execute: async (args, ctx) => {
    // why: ctx.completeGoalRun is the SW-injected hook bound to THIS session's
    // goal run. Absent (or no active run) → the model called it outside a run;
    // report that rather than throwing, so a stray call is a harmless no-op.
    const complete = /** @type {((summary: string) => boolean) | undefined} */ (
      /** @type {{ completeGoalRun?: unknown }} */ (ctx).completeGoalRun);
    const summary = typeof args?.summary === 'string' ? args.summary.trim() : '';
    if (typeof complete !== 'function') {
      return { ok: false, error: 'no_active_goal_run', content: 'complete_goal was called outside an active goal run; nothing to end.' };
    }
    const ended = complete(summary);
    if (!ended) {
      return { ok: false, error: 'no_active_goal_run', content: 'No active goal run to complete.' };
    }
    return { ok: true, content: `Goal run ended.${summary ? ` Summary: ${summary}` : ''}` };
  },
};
