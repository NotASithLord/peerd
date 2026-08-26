// @ts-check

import { executeNow } from './clock/execute.js';

export const CONTROLLER_TOOL_IMPLEMENTATIONS = Object.freeze({
  now: () => executeNow(),
  complete_goal: async (/** @type {any} */ args, /** @type {any} */ context) => {
    const summary = typeof args?.summary === 'string' ? args.summary.trim() : '';
    const result = await context.effects.endGoal({ summary });
    if (result?.ok !== true) throw Object.assign(new Error('Goal completion failed.'), {
      code: result?.code ?? 'goal-completion-failed',
      outcomeKnown: result?.outcomeKnown === true,
      retryable: result?.retryable === true,
    });
    return result.value?.ended === true
      ? { ok: true, content: `Goal run ended.${summary ? ` Summary: ${summary}` : ''}` }
      : { ok: false, error: 'no_active_goal_run', content: 'No active goal run to complete.' };
  },
});
