// @ts-check
// schedule_cancel — remove a background Routine by id (loop/scheduler.js
// singleton, via ctx.scheduleRemove). sideEffect 'write' so it rides the same
// gate chain as scheduling; no web origin is touched (origins → []).

/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult | { ok: false, error: string, content?: string }} ScheduleToolResult */
/** @typedef {Omit<Tool, 'primitive' | 'execute'> & { primitive: 'schedule', execute: (args: any, ctx: ToolContext) => Promise<ScheduleToolResult> }} ScheduleTool */

/** @type {ScheduleTool} */
export const scheduleCancelTool = {
  name: 'schedule_cancel',
  primitive: 'schedule',
  description: 'Remove a background routine by its id (from schedule_list). The routine stops firing immediately.',
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The routine id to remove (from schedule_list).' },
    },
    required: ['id'],
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    const scheduleRemove = /** @type {((id: string) => boolean) | undefined} */ (
      /** @type {{ scheduleRemove?: unknown }} */ (ctx).scheduleRemove);
    if (typeof scheduleRemove !== 'function') {
      return { ok: false, error: 'schedule_unavailable', content: 'Background scheduling is not available in this context.' };
    }
    if (typeof args?.id !== 'string' || !args.id) return { ok: false, error: 'id_required' };
    const removed = scheduleRemove(args.id);
    return removed
      ? { ok: true, content: `Removed routine ${args.id}.` }
      : { ok: false, error: 'not_found', content: `No routine with id ${args.id}.` };
  },
};
