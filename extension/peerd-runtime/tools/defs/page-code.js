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
// click / type / snapshot / read_page) through the owning actor executor, so
// the denylist, confirm gates, and audit apply unchanged. This tool is a
// vocabulary/shape change, not new capability.
//
// The owner identity is taken from ctx.session (the actor's own session) HERE,
// on the trusted side. The worker can never name a session or a tab; exact
// page authority re-derives the owned tab from its own bindings per call.

import { formatRunResult } from './script.js';

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
    try {
      // why: code execution, run custody and cancellation stay behind the exact
      // page-program authority. The controller only interprets the bounded run
      // result and never receives browser, storage or offscreen clients.
      const result = await /** @type {any} */ (ctx).pageAuthority.runOwnedPageProgram();
      if (result?.ok === false) return result;
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
    }
  },
});
