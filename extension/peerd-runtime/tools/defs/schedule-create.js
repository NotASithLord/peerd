// @ts-check
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
export const scheduleCreateTool = {
  name: 'schedule_create',
  primitive: 'schedule',
  description: [
    'Register a background routine: a standing task that runs unattended on a',
    'schedule, even when the side panel is closed. If peerd is locked or the',
    'browser was off when it was due, it runs as soon as peerd is back on.',
    'Give the task as `prompt` and EXACTLY ONE cadence: `every` (a duration like',
    '"30m", "6h", "1d") OR `dailyAt` (local 24h "HH:MM", e.g. "08:00"). `mode`',
    'controls each firing: "goal" (default — an autonomous multi-step run until',
    'the task is done) or "turn" (a single agent turn). Each firing opens its own',
    'fresh session. Use schedule_list to review and schedule_cancel to remove.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task to run on each firing, e.g. "Summarize my open tabs and save a note".',
      },
      every: {
        type: 'string',
        description: 'Interval cadence: a duration like "30m", "6h", "1d". Mutually exclusive with dailyAt.',
      },
      dailyAt: {
        type: 'string',
        description: 'Daily cadence: local 24h time "HH:MM", e.g. "08:00". Mutually exclusive with every.',
      },
      mode: {
        type: 'string',
        enum: ['goal', 'turn'],
        description: 'How each firing runs: "goal" (autonomous multi-step, default) or "turn" (one turn).',
      },
    },
    required: ['prompt'],
  },
  sideEffect: 'write',
  origins: () => [],

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
    const confirm = /** @type {((p: Record<string, unknown>) => Promise<'yes_once'|'yes_session'|'no'|boolean>) | undefined} */ (
      /** @type {unknown} */ (ctx.confirm));
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
      });
      if (ans !== 'yes_once' && ans !== 'yes_session' && ans !== true) {
        return { ok: false, error: 'declined', content: 'User declined to arm the routine.' };
      }
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
};
