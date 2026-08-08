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
 * @typedef {{ ok: true, value: any, images?: Array<{ data: string, mediaType: string }>, browserPolicies?: any[] } | { ok: false, error: string, browserPolicies?: any[] }} PageCallOutcome
 * @typedef {{ ok?: boolean, error?: string, content?: string, images?: Array<{ data: string, mediaType: string }>, structured?: Record<string, any> }} ToolResult
 */

/**
 * Decide how the page/call route should resolve the actor's tab. PURE — the SW
 * route feeds it the currently-owned tab (from webActorTabBindings.tabFor) and
 * the method, and acts on the verdict.
 *
 * why this exists: the CODE-surface web actor's ONLY navigation is page.goto,
 * and it has NO direct `navigate` tool — so it can't trigger the tool-call
 * actor's lazy `adoptWebTab` that opens the FIRST tab. Without this, page.goto
 * on a fresh actor failed closed ('no owned tab'), the model retried page_code
 * until (if lucky) the orchestrator opened a tab for it, and otherwise gave up —
 * reading as "the page worker is down". page.goto is the code actor's adopt
 * path: mirror navigate's lazy open. Any OTHER page.* with no tab genuinely has
 * no page to act on → refuse with an actionable message.
 *
 * @param {number | null | undefined} ownedTabId  the actor's currently-bound tab, if any
 * @param {string} method  the page.* method
 * @returns {{ action: 'dispatch', tabId?: number } | { action: 'adopt' } | { action: 'refuse', error: string }}
 */
export const resolvePageTab = (ownedTabId, method) => {
  if (typeof ownedTabId === 'number') return { action: 'dispatch', tabId: ownedTabId };
  if (method === 'goto') return { action: 'adopt' };
  // Tab-free web operations are valid before the actor renders anything. They
  // still run in the same actor ctx (origin/cache ownership is session-bound),
  // but there is no tab id to pin onto their tool args.
  if (['fetch', 'readDocument', 'readCache', 'readSiteClient', 'writeSiteClient'].includes(method)) {
    return { action: 'dispatch' };
  }
  return {
    action: 'refuse',
    error: `page.${method}: no page open yet — call page.goto(url) first to open your tab.`,
  };
};

/**
 * @param {{
 *   dispatchToolCall: (call: { name: string, args: object, id?: string }, ctx: any) => Promise<ToolResult>,
 *   buildActorContext: (binding: { sessionId: string, tabId?: number }) => any,
 * }} deps
 *   - dispatchToolCall: the gated dispatcher (gates + hooks + audit).
 *   - buildActorContext: builds the ToolContext for THIS actor's session, scoped
 *     to its owned tab. May be async.
 * @returns {(req: { method: string, args?: object, sessionId: string, tabId?: number, rid?: number | string, signal?: AbortSignal }) => Promise<PageCallOutcome>}
 */
export const makePageCallHandler = ({ dispatchToolCall, buildActorContext }) => async (req) => {
  if (req.signal?.aborted) return { ok: false, error: 'page_call_aborted' };
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
  if (req.signal?.aborted) return { ok: false, error: 'page_call_aborted' };
  if (req.signal) ctx = { ...ctx, abortSignal: req.signal };

  // Pin the owned tab onto the tool args (security invariant above). The DOM
  // tools all accept tabId; ones that don't ignore the extra key.
  //
  // why the id must be UNIQUE per dispatch: the lifecycle tracker keys
  // operations on (sessionId, call id), and the SW route doesn't thread the
  // worker's rid through — a constant id made every page.* write after the
  // first read as a replay of it and refuse. These are fresh interactive
  // calls the worker awaits one at a time; there is no resume path that
  // re-drives them, so a collision-free random id is the correct identity.
  const call = {
    name: toolCall.name,
    args: { ...toolCall.args, ...(typeof req.tabId === 'number' ? { tabId: req.tabId } : {}) },
    id: `page-${req.rid ?? ''}-${crypto.randomUUID()}`,
  };

  /** @type {ToolResult} */
  let result;
  try {
    if (req.signal?.aborted) return { ok: false, error: 'page_call_aborted' };
    result = await dispatchToolCall(call, ctx);
  } catch (e) {
    return { ok: false, error: `page_dispatch_failed: ${errMessage(e)}` };
  }
  if (req.signal?.aborted) return { ok: false, error: 'page_call_aborted' };

  const structured = result.structured && typeof result.structured === 'object'
    ? result.structured
    : {};
  const browserPolicies = Array.isArray(structured.browserPolicies)
    ? structured.browserPolicies
    : structured.browserPolicy ? [structured.browserPolicy] : [];
  const policyFields = browserPolicies.length ? { browserPolicies } : {};

  // Shape the result. A gated failure (denylist / confirm decline / count
  // mismatch) lands here as a thrown PageApiError → the worker's awaited page.*
  // call rejects, exactly like a real Playwright error.
  try {
    return {
      ok: true,
      value: shapePageResult(req.method, result),
      ...(Array.isArray(result.images) && result.images.length ? { images: result.images.slice(-1) } : {}),
      ...policyFields,
    };
  } catch (e) {
    return { ok: false, error: errMessage(e), ...policyFields };
  }
};

/** @param {unknown} e */
const errMessage = (e) => (e instanceof Error ? e.message : String(e));
