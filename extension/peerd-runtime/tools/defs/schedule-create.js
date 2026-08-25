// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// schedule_create — register a background Routine: a standing task that runs
// unattended on a cadence, even while the side panel is closed. If peerd is
// locked or the browser is off when a routine is due, it runs as soon as peerd
// is back on (loop/scheduler.js catch-up).
//
// The tool just shapes the request and hands it to ctx.scheduleAdd (SW-injected,
// bound to the singleton scheduler); the schedule math + persistence live in
// loop/schedule.js + loop/scheduler.js. sideEffect 'write' so Plan mode can't
// arm autonomous runs (an Act-only capability) and the gate chain treats it like
// any other mutation; no web origin is touched, so the egress gate passes
// vacuously (origins → []).

// why a tool-local 'schedule' primitive (outside the base Primitive union): same
// pattern as complete_goal's 'goal' — a narrowed typedef keeps the central union
// put. ctx.scheduleAdd is SW-injected only; absent → the tool reports the feature
// is unavailable rather than throwing.
import { describeSchedule } from '../../loop/schedule.js';

/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult | { ok: false, error: string, content?: string }} ScheduleToolResult */
/** @typedef {Omit<Tool, 'primitive' | 'execute'> & { primitive: 'schedule', execute: (args: any, ctx: ToolContext) => Promise<ScheduleToolResult> }} ScheduleTool */

/** @type {ScheduleTool} */
export const scheduleCreateTool = composeTool("schedule_create", {

  execute: async (args, ctx) => {
    const scheduleAdd = /** @type {((req: any) => { ok: boolean, error?: string, routine?: any }) | undefined} */ (
      /** @type {{ scheduleAdd?: unknown }} */ (ctx).scheduleAdd);
    if (typeof scheduleAdd !== 'function') {
      return { ok: false, error: 'schedule_unavailable', content: 'Background scheduling is not available in this context.' };
    }
    if (typeof args?.prompt !== 'string' || !args.prompt.trim()) {
      return { ok: false, error: 'prompt_required' };
    }
    if (!args?.every && !args?.dailyAt) {
      return { ok: false, error: 'schedule_required', content: 'Provide a cadence: `every` (e.g. "6h") or `dailyAt` (e.g. "08:00").' };
    }
    // Arming a routine is arming PERSISTENT, UNATTENDED autonomy — higher
    // consequence than a normal write, so it FORCE-confirms even when the global
    // confirm toggle is off (the dweb_share/install pattern). This is the seam
    // that (1) stops an injection-influenced turn from silently planting a
    // standing trusted run, and (2) blocks routine-from-routine self-replication
    // — a firing runs with the panel closed, so its confirm can't be answered and
    // the create is declined. When the toggle is ON, the dispatcher already
    // confirmed this write, so we don't double-prompt.
    const permission = /** @type {{ confirmActions?: boolean } | undefined} */ (
      /** @type {{ permission?: unknown }} */ (ctx).permission);
    const confirm = /** @type {((p: Record<string, unknown>, signal?: AbortSignal) => Promise<'yes_once'|'yes_session'|'no'|boolean>) | undefined} */ (
      /** @type {unknown} */ (ctx.confirm));
    const aborted = () => ctx.abortSignal?.aborted === true;
    if (aborted()) {
      return { ok: false, error: 'schedule_aborted', content: 'The routine was not armed because the run was stopped.' };
    }
    if (permission?.confirmActions === false && confirm) {
      const cadence = args.every ? `every ${String(args.every).trim()}` : `daily at ${String(args.dailyAt).trim()}`;
      const runMode = args.mode === 'turn' ? 'a single turn' : 'an autonomous run';
      const ans = await confirm({
        tool: 'schedule_create',
        sideEffect: 'write',
        kind: 'schedule_arm',
        origins: [],
        summary: `Schedule a background routine (${cadence}, ${runMode})? It will run unattended, even with the panel closed:\n"${args.prompt.trim()}"`,
        sessionId: ctx.session?.sessionId ?? null,
      }, ctx.abortSignal);
      // The coordinator normally resolves an aborted confirmation as `no`, but
      // recheck the authoritative signal here too: injected/test coordinators
      // and future adapters must not turn a late affirmative into persistence.
      if (aborted()) {
        return { ok: false, error: 'schedule_aborted', content: 'The routine was not armed because the run was stopped.' };
      }
      if (ans !== 'yes_once' && ans !== 'yes_session' && ans !== true) {
        return { ok: false, error: 'declined', content: 'User declined to arm the routine.' };
      }
    }
    if (aborted()) {
      return { ok: false, error: 'schedule_aborted', content: 'The routine was not armed because the run was stopped.' };
    }
    const res = await scheduleAdd({
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
