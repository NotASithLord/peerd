// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// page_code — the web actor's CODE-REPL action surface (PR #119).
//
// The Aside-style A/B arm: instead of emitting discrete click/type/navigate
// tool calls, the code-mode web actor WRITES a script that drives its owned tab
// through a Playwright-shaped `page` object. The script runs in the SAME sealed
// headless worker as js_run, but under a hard capability profile: `page` + pure
// compute ONLY — no egress.fetch, no subagents, no OPFS. why: the web actor
// ingests untrusted page text, so its code hand must hold nothing beyond what
// the tool-call actor already holds (the exclusion IS the boundary,
// exposure.js) — every page.* call maps onto the SAME gated tool (navigate /
// click / type / snapshot / read_page) via the SW 'page/call' route, so the
// denylist, confirm gates, and audit apply unchanged. This tool is a
// vocabulary/shape change, not new capability.
//
// The owner identity is taken from ctx.session (the actor's own session) HERE,
// on the trusted side — the worker can never name a session or a tab; the SW
// route re-derives the owned tab from its own bindings per call.

import { clamp } from '/shared/util.js';
import { formatRunResult } from './script.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;

// The code-REPL worker's capability profile — fixed, never caller-supplied.
export const PAGE_CODE_CAPS = Object.freeze({
  page: true, egress: false, subagent: false, opfs: false,
});

/** @type {import('/shared/tool-types.js').Tool} */
export const pageCodeTool = composeTool("page_code", {

  execute: async (args, ctx) => {
    if (typeof args?.code !== 'string' || args.code.length === 0) {
      return { ok: false, error: 'code_required' };
    }
    // why: jsOffscreenClient rides the opaque ctx contract (not on ToolContext);
    // narrow to the one method this tool calls.
    const jsOffscreenClient = /** @type {{ execHeadless?: (code: string, opts: object) => Promise<import('./script.js').RunResult>, abortHeadless?: (runId: string, owner?: string) => Promise<void> } | undefined} */ (
      /** @type {any} */ (ctx).jsOffscreenClient);
    if (!jsOffscreenClient || typeof jsOffscreenClient.execHeadless !== 'function') {
      return { ok: false, error: 'page_code_unavailable' };
    }
    // The actor's own session — the trusted owner identity the page bridge rides
    // on. Absent (a non-session ctx) → fail closed; the SW route ALSO verifies
    // the session is a tab-backed web actor before any dispatch.
    const ownerSessionId = ctx.session?.sessionId;
    if (typeof ownerSessionId !== 'string' || !ownerSessionId) {
      return { ok: false, error: 'page_code_requires_actor_session' };
    }
    const extras = /** @type {{ scriptRuns?: { mintRunId: (owner: string) => string, register: (runId: string, signal: any, owner: string, caps: Record<string, boolean>) => void, release: (runId: string) => void }, abortSignal?: any }} */ (/** @type {any} */ (ctx));
    if (!extras.scriptRuns) return { ok: false, error: 'page_code_run_registry_unavailable' };
    if (extras.abortSignal?.aborted) return { ok: false, error: 'page_code_aborted: the turn was stopped before the run started' };
    const timeoutMs = clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    const runId = extras.scriptRuns.mintRunId(ownerSessionId);
    extras.scriptRuns.register(runId, extras.abortSignal, ownerSessionId, { page: true });
    /** @type {(() => void) | undefined} */
    let onAbort;
    if (extras.abortSignal && jsOffscreenClient.abortHeadless) {
      onAbort = () => { jsOffscreenClient.abortHeadless?.(runId, ownerSessionId); };
      if (extras.abortSignal.aborted) onAbort();
      else extras.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const result = await jsOffscreenClient.execHeadless(args.code, {
        timeoutMs, caps: PAGE_CODE_CAPS, ownerSessionId, runId,
        signal: extras.abortSignal,
      });
      if (result.endTurn === true) {
        return {
          ok: false,
          error: 'page_code_ended_for_host_policy',
          content: typeof result.endTurnContent === 'string' && result.endTurnContent
            ? result.endTurnContent
            : 'peerd stopped this page run because the tab entered a user-controlled sign-in step.',
          endTurn: true,
          outcomeKind: result.endTurnOutcomeKind === 'pre-effect-failure'
            ? 'pre-effect-failure'
            : 'effect-completed',
        };
      }
      return {
        ok: true,
        content: formatRunResult(args.code, result),
        ...(Array.isArray(result.images) && result.images.length ? { images: result.images } : {}),
        ...(Array.isArray(result.browserPolicies) && result.browserPolicies.length
          ? { browserChildPolicyNotices: result.browserPolicies }
          : {}),
      };
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      return { ok: false, error: `page_code_failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}` };
    } finally {
      extras.scriptRuns.release(runId);
      if (onAbort && extras.abortSignal) {
        try { extras.abortSignal.removeEventListener?.('abort', onAbort); } catch { /* stub */ }
      }
    }
  },
});
