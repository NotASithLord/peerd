// @ts-check
// Host-side page-call handler — the SW-route logic for the web-actor code-REPL
// arm. It receives a `page.<method>` RPC the actor made inside its sealed worker
// and runs it through the SAME gated dispatch the tool-call web actor uses, then
// returns the shaped result (or an error the worker's awaited call rejects with).
//
// IO is INJECTED (the tool dispatcher + the actor tool-context builder), so the
// whole flow — translate → build the actor's gated ctx → dispatch → shape →
// surface failures the way the worker sees them — is unit-testable without a
// browser. The translation/shaping itself is the pure core in page-api.js.
//
// SECURITY — tab pinning: the destination tab is taken from the actor's binding
// (req.tabId), NOT from the page.* call args, and is force-set on the dispatched
// tool args. So a page.* call can only ever act on the tab the actor already
// owns; the worker can't aim it at another tab. Everything else (denylist,
// confirm, audit) is inherited unchanged because we go through dispatchToolCall.

import { pageCallToToolCall, shapePageResult } from './page-api.js';

/**
 * @typedef {{ ok: true, value: any } | { ok: false, error: string }} PageCallOutcome
 * @typedef {{ ok?: boolean, error?: string, content?: string }} ToolResult
 */

/**
 * @param {{
 *   dispatchToolCall: (call: { name: string, args: object, id?: string }, ctx: any) => Promise<ToolResult>,
 *   buildActorContext: (binding: { sessionId: string, tabId: number }) => any,
 * }} deps
 *   - dispatchToolCall: the gated dispatcher (gates + hooks + audit).
 *   - buildActorContext: builds the ToolContext for THIS actor's session, scoped
 *     to its owned tab. May be async.
 * @returns {(req: { method: string, args?: object, sessionId: string, tabId: number, rid?: number | string }) => Promise<PageCallOutcome>}
 */
export const makePageCallHandler = ({ dispatchToolCall, buildActorContext }) => async (req) => {
  // Translate first — a bad method or malformed args is the worker code's
  // mistake; surface it as a rejection and NEVER dispatch anything.
  let toolCall;
  try {
    toolCall = pageCallToToolCall({ method: req?.method, args: req?.args });
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }

  // Build the gated context for this actor's session + owned tab.
  let ctx;
  try {
    ctx = await buildActorContext({ sessionId: req.sessionId, tabId: req.tabId });
  } catch (e) {
    return { ok: false, error: `page_context_unavailable: ${errMessage(e)}` };
  }

  // Pin the owned tab onto the tool args (security invariant above). The DOM
  // tools all accept tabId; ones that don't ignore the extra key.
  const call = {
    name: toolCall.name,
    args: { ...toolCall.args, tabId: req.tabId },
    id: `page-${req.rid ?? ''}`,
  };

  /** @type {ToolResult} */
  let result;
  try {
    result = await dispatchToolCall(call, ctx);
  } catch (e) {
    return { ok: false, error: `page_dispatch_failed: ${errMessage(e)}` };
  }

  // Shape the result. A gated failure (denylist / confirm decline / count
  // mismatch) lands here as a thrown PageApiError → the worker's awaited page.*
  // call rejects, exactly like a real Playwright error.
  try {
    return { ok: true, value: shapePageResult(req.method, result) };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
};

/** @param {unknown} e */
const errMessage = (e) => (e instanceof Error ? e.message : String(e));
