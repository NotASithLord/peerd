// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// schedule_create — register a background Routine: a standing task that runs
// unattended on a cadence, even while the side panel is closed. If peerd is
// locked or the browser is off when a routine is due, it runs as soon as peerd
// is back on (loop/scheduler.js catch-up).
//
// The tool shapes the request and hands it to a named scheduling authority
// action; the schedule math + persistence live in loop/schedule.js +
// loop/scheduler.js. sideEffect 'write' so Plan mode can't
// arm autonomous runs (an Act-only capability) and the gate chain treats it like
// any other mutation; no web origin is touched, so the egress gate passes
// vacuously (origins → []).

// why a tool-local 'schedule' primitive (outside the base Primitive union): same
// pattern as complete_goal's 'goal' — a narrowed typedef keeps the central union
// put. The authority interface is exact and does not expose its scheduler.
import { describeSchedule } from '../../loop/schedule.js';

/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult | { ok: false, error: string, content?: string }} ScheduleToolResult */
/** @typedef {Omit<Tool, 'primitive' | 'execute'> & { primitive: 'schedule', execute: (args: any, ctx: ToolContext) => Promise<ScheduleToolResult> }} ScheduleTool */

/** @type {ScheduleTool} */
export const scheduleCreateTool = composeTool("schedule_create", {

  execute: async (args, ctx) => {
    const authority = /** @type {{ armConfirmedRoutine?:(req:any)=>Promise<any> }|undefined} */ (
      /** @type {{ scheduleAuthority?: unknown }} */ (ctx).scheduleAuthority);
    if (typeof authority?.armConfirmedRoutine !== 'function') {
      return { ok: false, error: 'schedule_unavailable', content: 'Background scheduling is not available in this context.' };
    }
    if (typeof args?.prompt !== 'string' || !args.prompt.trim()) {
      return { ok: false, error: 'prompt_required' };
    }
    if (!args?.every && !args?.dailyAt) {
      return { ok: false, error: 'schedule_required', content: 'Provide a cadence: `every` (e.g. "6h") or `dailyAt` (e.g. "08:00").' };
    }
    const res = await authority.armConfirmedRoutine({
      prompt: args.prompt,
      every: args.every,
      dailyAt: args.dailyAt,
      mode: args.mode,
    });
    if (!res?.ok) {
      const why = res?.error === 'invalid-schedule'
        ? 'Could not parse the cadence. Use `every` like "30m"/"6h"/"1d", or `dailyAt` like "08:00".'
        : res?.error === 'too-many-routines'
          ? 'The routine limit is reached. Remove one with schedule_cancel before adding another.'
          : `Could not create the routine (${res?.error ?? 'unknown'}).`;
      return { ok: false, error: res?.error ?? 'schedule_create_failed', content: why };
    }
    const r = res.routine;
    return {
      ok: true,
      content: JSON.stringify({
        id: r.id,
        prompt: r.prompt,
        schedule: describeSchedule(r.schedule),
        mode: r.mode,
        nextRunAt: new Date(r.nextRunAt).toISOString(),
      }, null, 2),
    };
  },
});
