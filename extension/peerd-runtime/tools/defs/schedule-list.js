// @ts-check
// schedule_list — enumerate the registered background Routines (loop/scheduler.js
// singleton, via ctx.scheduleList). Read-class, no egress: it reads local
// scheduler state only, so it never confirms and the origin/egress gates pass
// vacuously.

import { describeSchedule } from '../../loop/schedule.js';

/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult | { ok: false, error: string, content?: string }} ScheduleToolResult */
/** @typedef {Omit<Tool, 'primitive' | 'execute'> & { primitive: 'schedule', execute: (args: any, ctx: ToolContext) => Promise<ScheduleToolResult> }} ScheduleTool */

/** @type {ScheduleTool} */
export const scheduleListTool = {
  name: 'schedule_list',
  primitive: 'schedule',
  description: 'List the registered background routines: id, task prompt, cadence, mode, enabled state, and next run time. Use schedule_create to add one, schedule_cancel to remove one.',
  schema: { type: 'object', properties: {} },
  sideEffect: 'read',
  origins: () => [],

  execute: async (_args, ctx) => {
    const scheduleList = /** @type {(() => any[]) | undefined} */ (
      /** @type {{ scheduleList?: unknown }} */ (ctx).scheduleList);
    if (typeof scheduleList !== 'function') {
      return { ok: false, error: 'schedule_unavailable', content: 'Background scheduling is not available in this context.' };
    }
    const routines = scheduleList() ?? [];
    if (routines.length === 0) {
      return { ok: true, content: 'No background routines registered.' };
    }
    const rows = routines.map((r) => ({
      id: r.id,
      prompt: r.prompt,
      schedule: describeSchedule(r.schedule),
      mode: r.mode,
      enabled: r.enabled !== false,
      nextRunAt: new Date(r.nextRunAt).toISOString(),
      lastRunAt: r.lastRunAt ? new Date(r.lastRunAt).toISOString() : null,
      runCount: r.runCount ?? 0,
    }));
    return { ok: true, content: JSON.stringify(rows, null, 2) };
  },
};
