// @ts-check
// Internal mapped primitive for app.act(). Argument validation is duplicated at
// this gate because a worker/client bug must not widen the App runtime surface.

import { wrapUntrusted } from '../prompt-wrap.js';

const SAFE_ACTION = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_PARAMS_CHARS = 20_000;

/** @type {import('/shared/tool-types.js').Tool} */
export const appActTool = {
  name: 'app_act',
  primitive: 'app',
  description: 'Internal exact-instance App action primitive.',
  schema: {
    type: 'object',
    properties: { action: { type: 'string' }, params: { type: 'object' } },
    required: ['action'],
  },
  sideEffect: 'write',
  origins: () => [],
  execute: async (args, ctx) => {
    if (typeof args?.action !== 'string' || !SAFE_ACTION.test(args.action)) {
      return { ok: false, error: 'invalid_app_action', outcomeKnown: true, outcomeKind: 'pre-effect-failure' };
    }
    const params = args.params == null ? {} : args.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return { ok: false, error: 'app_action_params_must_be_an_object', outcomeKnown: true, outcomeKind: 'pre-effect-failure' };
    }
    let encoded;
    try { encoded = JSON.stringify(params); }
    catch { return { ok: false, error: 'app_action_params_not_serializable', outcomeKnown: true, outcomeKind: 'pre-effect-failure' }; }
    if (encoded.length > MAX_PARAMS_CHARS) return { ok: false, error: 'app_action_params_too_large', outcomeKnown: true, outcomeKind: 'pre-effect-failure' };
    const call = /** @type {any} */ (ctx).appAgentCall;
    if (typeof call !== 'function') return { ok: false, error: 'app_playtest_not_available' };
    try {
      const result = await call('act', { action: args.action, params }, /** @type {any} */ (ctx).abortSignal);
      if (!result?.ok) {
        // appAgentCall crossed into the App document. A naked handler error is
        // not proof that the action failed before mutation: Apps routinely
        // mutate and then throw. Only an explicit trusted-host pre-effect
        // classification is safe to retry; every other rejection is unknown.
        const knownPreEffect = result?.outcomeKnown === true
          && result?.outcomeKind === 'pre-effect-failure';
        return {
          ok: false,
          error: result?.error ?? 'app_act_failed',
          outcomeKnown: knownPreEffect,
          outcomeKind: knownPreEffect ? 'pre-effect-failure' : 'transport-lost',
        };
      }
      const value = result.value ?? null;
      return {
        ok: true,
        content: wrapUntrusted({
          origin: `app-runtime:${/** @type {any} */ (ctx).actorInstanceId ?? 'current'}`,
          tool: 'app_act',
          body: JSON.stringify(value, null, 2),
        }),
        structured: { value },
      };
    } catch (error) {
      return {
        ok: false,
        error: `app_act_failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}`,
        outcomeKnown: false,
        outcomeKind: 'transport-lost',
      };
    }
  },
};
