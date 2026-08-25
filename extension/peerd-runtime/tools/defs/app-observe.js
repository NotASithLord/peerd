// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// Internal mapped primitive for app.observe(). It is registered so app_code can
// cross the standard dispatcher/gates; the code-surface actor never sees this
// as a model tool.

import { wrapUntrusted } from '../prompt-wrap.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const appObserveTool = composeTool("app_observe", {
  execute: async (_args, ctx) => {
    const call = /** @type {any} */ (ctx).appAgentCall;
    if (typeof call !== 'function') return { ok: false, error: 'app_playtest_not_available' };
    try {
      const result = await call('observe', {}, /** @type {any} */ (ctx).abortSignal);
      if (!result?.ok) return {
        ok: false,
        error: result?.error ?? 'app_observe_failed',
        ...(result?.outcomeKnown === false ? { outcomeKnown: false, outcomeKind: 'transport-lost' } : {}),
      };
      const value = result.value ?? null;
      return {
        ok: true,
        content: wrapUntrusted({
          origin: `app-runtime:${/** @type {any} */ (ctx).actorInstanceId ?? 'current'}`,
          tool: 'app_observe',
          body: JSON.stringify(value, null, 2),
        }),
        structured: { value },
      };
    } catch (error) {
      return { ok: false, error: `app_observe_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}` };
    }
  },
});
