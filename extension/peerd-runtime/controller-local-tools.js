// @ts-check

import { executeNow } from './clock/execute.js';

export const CONTROLLER_LOCAL_TOOL_NAMES = Object.freeze(['now', 'complete_goal']);
const localToolNames = new Set(CONTROLLER_LOCAL_TOOL_NAMES);

export const controllerHostsLocalTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && localToolNames.has(name);

/**
 * Controller-local tool semantics. The only privileged edge is the exact
 * goal-completion operation; ordinary local tools receive no kernel surface.
 * @param {string} name
 * @param {unknown} args
 * @param {{completeGoal:(summary:string)=>Promise<any>}} authority
 */
export const executeControllerLocalTool = async (name, args, authority) => {
  if (name === 'now') return executeNow();
  if (name !== 'complete_goal') {
    throw Object.assign(new Error('controller local tool is unavailable'), {
      code: 'controller-local-tool-unavailable', outcomeKnown: true,
    });
  }
  const summary = typeof /** @type {any} */ (args)?.summary === 'string'
    ? /** @type {any} */ (args).summary.trim() : '';
  const result = await authority.completeGoal(summary);
  if (result?.ok !== true) throw Object.assign(new Error('Goal completion failed.'), {
    code: result?.code ?? 'goal-completion-failed',
    outcomeKnown: result?.outcomeKnown === true,
    retryable: result?.retryable === true,
  });
  return result.value?.ended === true
    ? { ok: true, content: `Goal run ended.${summary ? ` Summary: ${summary}` : ''}` }
    : { ok: false, error: 'no_active_goal_run', content: 'No active goal run to complete.' };
};
