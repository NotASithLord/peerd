// @ts-check
// One code-first gameplay/development feedback surface for a bound App actor.

import { clamp } from '/shared/util.js';
import { formatRunResult } from './script.js';
import { codeClientReference } from '../../actor/capability-manifest.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;

export const APP_CODE_CAPS = Object.freeze({
  app: true, page: false, egress: false, subagent: false, opfs: false,
});

/** @type {import('/shared/tool-types.js').Tool} */
export const appCodeTool = {
  name: 'app_code',
  primitive: 'app',
  description: [
    'Playtest YOUR running App by writing JavaScript in a sealed worker.',
    `Exact client: ${codeClientReference('app')}.`,
    'Compose short observe/act loops and return compact structured evidence.',
    'Every call is exact-instance pinned and crosses the same App runtime gate;',
    'code adds composition, not authority. No browser, network, files, or subagents.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Async JS function body; top-level await and return work.' },
      timeoutMs: { type: 'integer', description: `Wall-clock cap in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` },
    },
    required: ['code'],
  },
  sideEffect: 'write',
  origins: () => [],
  execute: async (args, ctx) => {
    if (typeof args?.code !== 'string' || args.code.length === 0) return { ok: false, error: 'code_required' };
    const client = /** @type {any} */ (ctx).jsOffscreenClient;
    if (!client || typeof client.execHeadless !== 'function') return { ok: false, error: 'app_code_unavailable' };
    const ownerSessionId = ctx.session?.sessionId;
    if (typeof ownerSessionId !== 'string' || !ownerSessionId) return { ok: false, error: 'app_code_requires_actor_session' };
    const extras = /** @type {any} */ (ctx);
    if (!extras.scriptRuns) return { ok: false, error: 'app_code_run_registry_unavailable' };
    if (extras.abortSignal?.aborted) return {
      ok: false,
      error: 'app_code_aborted: the turn was stopped before the run started',
      outcomeKnown: true,
      outcomeKind: 'pre-effect-failure',
    };
    const timeoutMs = clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    const runId = extras.scriptRuns.mintRunId(ownerSessionId);
    extras.scriptRuns.register(runId, extras.abortSignal, ownerSessionId, { app: true });
    let onAbort;
    if (extras.abortSignal && client.abortHeadless) {
      onAbort = () => { client.abortHeadless(runId, ownerSessionId); };
      if (extras.abortSignal.aborted) onAbort();
      else extras.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    // Set only by the trusted SW client at the exact job/run transport commit
    // point. The eventual result may be lost to Stop/deadline/transport before
    // job-runner can return its stronger usedApp/appOutcomeUnknown custody.
    let executionDispatched = false;
    try {
      const result = await client.execHeadless(args.code, {
        timeoutMs, caps: APP_CODE_CAPS, ownerSessionId, runId, signal: extras.abortSignal,
        onExecutionDispatch: () => { executionDispatched = true; },
      });
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
      const outcomeUnknown = executionDispatched
        || detail?.executionDispatched === true
        || detail?.outcomeKnown === false;
      return {
        ok: false,
        error: `${outcomeUnknown ? 'app_code_outcome_unknown' : 'app_code_failed'}: ${detail?.name ?? 'Error'}: ${detail?.message ?? String(error)}`,
        outcomeKnown: !outcomeUnknown,
        outcomeKind: outcomeUnknown ? 'transport-lost' : 'pre-effect-failure',
      };
    } finally {
      extras.scriptRuns.release(runId);
      if (onAbort && extras.abortSignal) {
        try { extras.abortSignal.removeEventListener?.('abort', onAbort); } catch { /* stub */ }
      }
    }
  },
};
