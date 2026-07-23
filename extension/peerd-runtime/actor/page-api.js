// @ts-check
// Playwright-shaped `page` API — the host-side TRANSLATION CORE for the web
// actor's code-REPL arm (the Aside-style "the model writes Playwright JS"
// experiment; rationale on the PR). A `page.<method>(...)` call made inside the
// sealed worker is shipped to the host as `{ method, args }`; this PURE core
// turns it into a peerd tool call `{ name, args }`, and shapes the tool result
// back into a Playwright-ish return value.
//
// why a translation layer and not new tools: every page.* action MUST ride the
// SAME gated tools the tool-call actor already uses (navigate / click / type /
// snapshot / read_page), so the denylist, the confirm gate, and the audit apply
// unchanged. This is a vocabulary + shape layer over those — the same posture as
// the page_* facade (#109), but exposed as a CODE surface the actor drives in a
// REPL rather than as discrete tool definitions. The imperative shell (the worker
// `page` surface + the SW route that runs each call through `dispatchToolCall`)
// lives elsewhere; keeping the translation pure makes the semantics — above all
// Playwright's LOCATOR STRICTNESS — unit-testable without a browser.

/**
 * Raised when a page.* call is malformed or the gated tool it maps to failed.
 * Surfaces to the worker's awaited page.* call as a rejection, the way a real
 * Playwright call throws.
 */
export class PageApiError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PageApiError';
  }
}

/**
 * @typedef {{ method: string, args?: Record<string, any> }} PageCall
 * @typedef {{ name: string, args: Record<string, any> }} ToolCall
 * @typedef {{ ok?: boolean, error?: string, content?: string }} ToolResult
 */

/**
 * @typedef {Object} PageMethodSpec
 * @property {string} tool                                                the peerd tool this call dispatches
 * @property {(args: Record<string, any>) => Record<string, any>} toArgs  pure arg shaper (page args -> tool args)
 * @property {(content: any) => any} shape                                pure result shaper (parsed tool content -> page return)
 */

/** @type {Record<string, PageMethodSpec>} */
const PAGE_METHODS = {
  // page.goto(url) — navigate the owned tab. http(s)-only and the destination
  // denylist check are enforced DOWNSTREAM by the navigate tool + the egress
  // gate; here we only shape the call.
  goto: {
    tool: 'navigate',
    toArgs: (a) => {
      const url = a?.url;
      if (typeof url !== 'string' || url.length === 0) {
        throw new PageApiError('page.goto(url): url must be a non-empty string');
      }
      return { url };
    },
    shape: (c) => ({ ok: true, url: c?.url ?? null, ...(c?.origin ? { origin: c.origin } : {}) }),
  },

  // page.click(selector, { nth }) — Playwright locator STRICTNESS: the selector
  // must resolve to exactly one element or the click fails closed, via the
  // expectedCount guard (#103). An explicit nth opts out — the caller is
  // deliberately choosing among several matches (Playwright's .nth(i)).
  click: {
    tool: 'click',
    toArgs: (a) => {
      const selector = a?.selector;
      if (typeof selector !== 'string' || selector.length === 0) {
        throw new PageApiError('page.click(selector): selector must be a non-empty string');
      }
      return typeof a?.nth === 'number'
        ? { selector, nth: a.nth }
        : { selector, expectedCount: 1 };
    },
    shape: (c) => ({
      ok: true,
      clicked: c?.clicked === true,
      ...(typeof c?.matchedCount === 'number' ? { matchedCount: c.matchedCount } : {}),
      ...(c?.navigated ? { navigated: true } : {}),
    }),
  },

  // page.fill(selector, text) — replace a field's value. Always single-match
  // strict (a fill targets exactly one field).
  fill: {
    tool: 'type',
    toArgs: (a) => {
      const selector = a?.selector;
      const text = a?.text;
      if (typeof selector !== 'string' || selector.length === 0) {
        throw new PageApiError('page.fill(selector, text): selector must be a non-empty string');
      }
      if (typeof text !== 'string') {
        throw new PageApiError('page.fill(selector, text): text must be a string');
      }
      return { selector, text, expectedCount: 1 };
    },
    shape: (c) => ({
      ok: true,
      filled: true,
      ...(typeof c?.matchedCount === 'number' ? { matchedCount: c.matchedCount } : {}),
    }),
  },

  // page.snapshot() — re-perceive via the a11y snapshot (the SAME perception the
  // actor gets in its context). Perception stays snapshot-based; only ACTION
  // moves to code, which is the one axis this arm changes vs the web actor.
  snapshot: {
    tool: 'snapshot',
    toArgs: () => ({}),
    shape: (c) => c,
  },

  // page.content() — the page's readable text (read_page).
  content: {
    tool: 'read_page',
    toArgs: () => ({}),
    shape: (c) => c,
  },
};

/** The page.* methods the actor may call (drives the worker stub + the prompt). */
export const PAGE_API_METHODS = Object.freeze(Object.keys(PAGE_METHODS));

/**
 * Translate a `page.<method>(args)` call into the peerd tool call to dispatch.
 * Pure. Throws {@link PageApiError} on an unknown method or malformed args.
 * @param {PageCall} call
 * @returns {ToolCall}
 */
export const pageCallToToolCall = (call) => {
  const method = call?.method;
  const spec = typeof method === 'string' ? PAGE_METHODS[method] : undefined;
  if (!spec) throw new PageApiError(`unknown page method: ${String(method)}`);
  return { name: spec.tool, args: spec.toArgs(call?.args ?? {}) };
};

/**
 * Parse a tool result's content body. The page-mapped tools all return a JSON
 * string; fall back to the raw string when it isn't JSON.
 * @param {string | undefined} content
 * @returns {any}
 */
const parseContent = (content) => {
  if (typeof content !== 'string') return content ?? null;
  try { return JSON.parse(content); }
  catch { return content; }
};

/**
 * Shape a dispatched tool's result into the value `page.<method>()` resolves to.
 * Pure. Throws {@link PageApiError} when the gated tool failed, so the worker's
 * awaited call rejects like a real Playwright call. `content` is the tool
 * result's JSON-string body and is parsed here.
 * @param {string} method
 * @param {ToolResult} toolResult
 * @returns {any}
 */
export const shapePageResult = (method, toolResult) => {
  const spec = PAGE_METHODS[method];
  if (!spec) throw new PageApiError(`unknown page method: ${String(method)}`);
  if (!toolResult || toolResult.ok !== true) {
    throw new PageApiError(toolResult?.error ?? `page.${method} failed`);
  }
  return spec.shape(parseContent(toolResult.content));
};
