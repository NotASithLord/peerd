// @ts-check

// why: cadence validation, descriptions, and tool result shaping are ordinary
// scheduling semantics. The injected interface exposes only three complete
// routine actions; it carries no alarm, storage, scheduler, or confirmation
// object into the controller.
import { scheduleCreateTool } from './tools/defs/schedule-create.js';
import { scheduleListTool } from './tools/defs/schedule-list.js';
import { scheduleCancelTool } from './tools/defs/schedule-cancel.js';

export const CONTROLLER_SCHEDULE_TOOL_NAMES = Object.freeze([
  'schedule_create', 'schedule_list', 'schedule_cancel',
]);

const tools = Object.freeze({
  schedule_create: scheduleCreateTool,
  schedule_list: scheduleListTool,
  schedule_cancel: scheduleCancelTool,
});

export const controllerHostsScheduleTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(tools, name);

/**
 * @param {string} name
 * @param {unknown} args
 * @param {Record<string,Function>} authority
 * @param {{signal?:AbortSignal}} [options]
 */
export const executeControllerScheduleTool = async (
  name, args, authority, options = {},
) => {
  const tool = tools[/** @type {keyof typeof tools} */ (name)];
  if (!tool) throw Object.assign(new Error('controller schedule tool is unavailable'), {
    code: 'controller-schedule-tool-unavailable', outcomeKnown: true,
  });
  return tool.execute(args, /** @type {any} */ ({
    abortSignal: options.signal,
    scheduleAuthority: Object.freeze({
      readRoutines: authority.readRoutines,
      armConfirmedRoutine: authority.armConfirmedRoutine,
      cancelRoutine: authority.cancelRoutine,
    }),
  }));
};
