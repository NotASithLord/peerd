// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// One code-first runtime/development feedback surface for a bound App actor.

import { clamp } from '/shared/util.js';
import { formatRunResult } from './script.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;

/** @type {import('/shared/tool-types.js').Tool} */
export const appCodeTool = composeTool("app_code", {
  execute: async (args, ctx) => {
    if (typeof args?.code !== 'string' || args.code.length === 0) return { ok: false, error: 'code_required' };
    const authority = /** @type {{ runCode?: Function } | undefined} */ (
      /** @type {any} */ (ctx).appAuthority);
    if (!authority?.runCode) return { ok: false, error: 'app_code_unavailable' };
    const timeoutMs = clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    try {
      const result = await authority.runCode(args.code, timeoutMs);
      if (result?.refusal === 'app_code_requires_actor_session') {
        return { ok: false, error: result.refusal };
      }
      if (result?.refusal === 'app_code_run_registry_unavailable') {
        return { ok: false, error: result.refusal };
      }
      if (result?.refusal === 'app_code_unavailable') {
        return { ok: false, error: result.refusal };
      }
      if (result?.aborted === true) return {
        ok: false,
        error: 'app_code_aborted: the turn was stopped before the run started',
        outcomeKnown: true,
        outcomeKind: 'pre-effect-failure',
      };
      if (result?.appOutcomeUnknown === true || (result?.error && result?.usedApp === true)) {
        return {
          ok: false,
          error: `app_code_outcome_unknown: ${result?.appOutcomeError ?? result?.error ?? 'an App action may have landed; inspect state before another action'}`,
          outcomeKnown: false,
          outcomeKind: 'transport-lost',
          content: formatRunResult(args.code, result),
        };
      }
      if (result?.error) {
        return {
          ok: false,
          error: `app_code_failed: ${result.error}`,
          outcomeKnown: true,
          outcomeKind: 'pre-effect-failure',
          content: formatRunResult(args.code, result),
        };
      }
      return { ok: true, content: formatRunResult(args.code, result) };
    } catch (error) {
      const detail = /** @type {{name?:string,message?:string,executionDispatched?:boolean,outcomeKnown?:boolean}} */ (error);
      const outcomeUnknown = detail?.executionDispatched === true
        || detail?.outcomeKnown === false;
      return {
        ok: false,
        error: `${outcomeUnknown ? 'app_code_outcome_unknown' : 'app_code_failed'}: ${detail?.name ?? 'Error'}: ${detail?.message ?? String(error)}`,
        outcomeKnown: !outcomeUnknown,
        outcomeKind: outcomeUnknown ? 'transport-lost' : 'pre-effect-failure',
      };
    }
  },
});
