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

import { codeClientMethod, codeClientMethods } from './capability-manifest.js';

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

/** @param {any} target @param {string} what @returns {{ ref?: string, selector?: string }} */
const targetArgs = (target, what) => {
  if (typeof target === 'string' && target.length > 0) {
    return /^@e\d+$/.test(target) ? { ref: target } : { selector: target };
  }
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    if (typeof target.ref === 'string' && /^@e\d+$/.test(target.ref)) return { ref: target.ref };
    if (typeof target.selector === 'string' && target.selector.length > 0) return { selector: target.selector };
  }
  throw new PageApiError(`${what}: target must be a CSS selector, an @e ref, or { selector|ref }`);
};

/** @param {any} value @returns {Record<string, any>} */
const plainOptions = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** @param {any} c */
const passthrough = (c) => c;

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
      const target = targetArgs(a?.target ?? a?.selector, 'page.click(target)');
      if (target.ref) return target;
      return typeof a?.nth === 'number'
        ? { ...target, nth: a.nth }
        : { ...target, expectedCount: 1 };
    },
    shape: (c) => ({
      ok: true,
      clicked: c?.clicked === true,
      ...(typeof c?.matchedCount === 'number' ? { matchedCount: c.matchedCount } : {}),
      ...(c?.navigated ? { navigated: true } : {}),
      ...(c?.browserPolicy ? { browserPolicy: c.browserPolicy } : {}),
      ...(Array.isArray(c?.browserPolicies) ? { browserPolicies: c.browserPolicies } : {}),
    }),
  },

  // page.fill(selector, text) — replace a field's value. Always single-match
  // strict (a fill targets exactly one field).
  fill: {
    tool: 'type',
    toArgs: (a) => {
      const target = targetArgs(a?.target ?? a?.selector, 'page.fill(target, text)');
      const text = a?.text;
      if (typeof text !== 'string') {
        throw new PageApiError('page.fill(target, text): text must be a string');
      }
      return { ...target, text, ...(target.selector ? { expectedCount: 1 } : {}), ...(a?.submit === true ? { submit: true } : {}) };
    },
    shape: (c) => ({
      ok: true,
      filled: true,
      ...(typeof c?.matchedCount === 'number' ? { matchedCount: c.matchedCount } : {}),
      ...(c?.browserPolicy ? { browserPolicy: c.browserPolicy } : {}),
      ...(Array.isArray(c?.browserPolicies) ? { browserPolicies: c.browserPolicies } : {}),
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

  readState: {
    tool: 'read_state',
    toArgs: (a) => targetArgs(a?.target ?? a?.selector ?? a?.ref, 'page.readState(target)'),
    shape: passthrough,
  },
  watchChanges: {
    tool: 'watch_changes',
    toArgs: () => ({}),
    shape: passthrough,
  },
  query: {
    tool: 'query_dom',
    toArgs: (a) => {
      if (typeof a?.selector !== 'string' || !a.selector) throw new PageApiError('page.query(selector): selector must be a non-empty string');
      return { selector: a.selector, ...plainOptions(a.options) };
    },
    shape: passthrough,
  },
  keys: {
    tool: 'page_keys',
    toArgs: (a) => {
      if (typeof a?.sequence !== 'string' || !a.sequence) throw new PageApiError('page.keys(sequence): sequence must be a non-empty string');
      return { keys: a.sequence };
    },
    shape: passthrough,
  },
  readPdf: {
    tool: 'read_pdf',
    toArgs: (a) => plainOptions(a.options),
    shape: passthrough,
  },
  view: {
    tool: 'view',
    toArgs: () => ({}),
    shape: passthrough,
  },

  // The rest of the tab web actor's safe non-DOM surface. These remain page.*
  // so one familiar client owns the actor's entire web hand; each call still
  // dispatches the named existing tool under the actor's pinned context.
  fetch: {
    tool: 'fetch_url',
    toArgs: (a) => {
      if (typeof a?.url !== 'string' || !a.url) throw new PageApiError('page.fetch(url): url must be a non-empty string');
      return { ...plainOptions(a.options), url: a.url };
    },
    shape: passthrough,
  },
  readDocument: {
    tool: 'read_doc',
    toArgs: (a) => {
      if (typeof a?.url !== 'string' || !a.url) throw new PageApiError('page.readDocument(url): url must be a non-empty string');
      return { ...plainOptions(a.options), url: a.url };
    },
    shape: passthrough,
  },
  readCache: {
    tool: 'read_web_cache',
    toArgs: (a) => {
      if (typeof a?.key !== 'string' || !a.key) throw new PageApiError('page.readCache(key): key must be a non-empty string');
      return { ...plainOptions(a.options), key: a.key };
    },
    shape: passthrough,
  },
  readSiteClient: {
    tool: 'site_client_read',
    toArgs: (a) => {
      if (typeof a?.origin !== 'string' || !a.origin) throw new PageApiError('page.readSiteClient(origin): origin must be a non-empty string');
      return { origin: a.origin };
    },
    shape: passthrough,
  },
  writeSiteClient: {
    tool: 'site_client_write',
    toArgs: (a) => {
      if (typeof a?.origin !== 'string' || !a.origin) throw new PageApiError('page.writeSiteClient(origin, definition): origin must be a non-empty string');
      const definition = plainOptions(a?.definition);
      return { ...definition, origin: a.origin };
    },
    shape: passthrough,
  },
  captureSite: {
    tool: 'site_capture',
    toArgs: (a) => {
      if (a?.action !== 'start' && a?.action !== 'stop') throw new PageApiError("page.captureSite(action): action must be 'start' or 'stop'");
      return { action: a.action };
    },
    shape: passthrough,
  },
  login: {
    tool: 'login',
    toArgs: (a) => ({ ...targetArgs(a?.target ?? a?.selector, 'page.login(target)'), ...plainOptions(a?.options) }),
    shape: passthrough,
  },
};

/** The page.* methods the actor may call (drives the worker stub + the prompt). */
export const PAGE_API_METHODS = Object.freeze(codeClientMethods('page'));

const PAGE_TOOL_ROUTES = Object.freeze({
  navigate: 'page-program/navigate',
  click: 'page-program/click',
  type: 'page-program/fill',
  snapshot: 'page-program/snapshot',
  read_page: 'page-program/read',
  read_state: 'page-program/read-state',
  watch_changes: 'page-program/watch-changes',
  query_dom: 'page-program/query-dom',
  read_pdf: 'page-program/read-pdf',
  view: 'page-program/view',
  fetch_url: 'page-program/fetch',
  read_doc: 'page-program/read-document',
  read_web_cache: 'page-program/read-cache',
  site_client_read: 'page-program/site-client-read',
  site_client_write: 'page-program/site-client-write',
  site_capture: 'page-program/site-capture',
  login: 'page-program/login',
});

/**
 * Translate a `page.<method>(args)` call into the peerd tool call to dispatch.
 * Pure. Throws {@link PageApiError} on an unknown method or malformed args.
 * @param {PageCall} call
 * @returns {ToolCall}
 */
export const pageCallToToolCall = (call) => {
  const method = call?.method;
  const spec = typeof method === 'string' ? PAGE_METHODS[method] : undefined;
  const declared = typeof method === 'string' ? codeClientMethod('page', method) : null;
  if (!spec || !declared || declared.tool !== spec.tool) throw new PageApiError(`unknown page method: ${String(method)}`);
  return { name: spec.tool, args: spec.toArgs(call?.args ?? {}) };
};

/**
 * Resolve one declared page method to its fixed SW relay route. The caller
 * cannot supply a route or tool name; both come from the sealed manifest.
 * @param {PageCall} call
 */
export const pageCallToRelay = (call) => {
  const toolCall = pageCallToToolCall(call);
  const route = PAGE_TOOL_ROUTES[/** @type {keyof typeof PAGE_TOOL_ROUTES} */ (toolCall.name)];
  if (!route) throw new PageApiError(`page method has no fixed authority route: ${call.method}`);
  return { route, args: toolCall.args };
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
    const code = toolResult?.error ?? `page.${method} failed`;
    const content = typeof toolResult?.content === 'string' ? toolResult.content.trim() : '';
    throw new PageApiError(content ? `${code}: ${content}` : code);
  }
  return spec.shape(parseContent(toolResult.content));
};

/**
 * Shape the raw exact-authority ToolResult into the page worker's response.
 * @param {string} method
 * @param {any} result
 */
export const shapePageCallOutcome = (method, result) => {
  const structured = result?.structured && typeof result.structured === 'object'
    ? result.structured : {};
  const browserPolicies = Array.isArray(result?.browserPolicies)
    ? result.browserPolicies
    : result?.browserPolicy ? [result.browserPolicy]
      : Array.isArray(structured.browserPolicies)
        ? structured.browserPolicies
        : structured.browserPolicy ? [structured.browserPolicy] : [];
  const policyFields = browserPolicies.length ? { browserPolicies } : {};
  const terminalFields = result?.endTurn === true ? {
    endTurn: true,
    endTurnContent: typeof result.endTurnContent === 'string'
      ? result.endTurnContent
      : typeof result.content === 'string' ? result.content : '',
    ...(typeof result.endTurnOutcomeKind === 'string'
      ? { endTurnOutcomeKind: result.endTurnOutcomeKind }
      : typeof result.outcomeKind === 'string'
        ? { endTurnOutcomeKind: result.outcomeKind } : {}),
  } : {};
  try {
    return {
      ok: true,
      value: shapePageResult(method, result),
      ...(Array.isArray(result?.images) && result.images.length
        ? { images: result.images.slice(-1) } : {}),
      ...policyFields,
      ...terminalFields,
    };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
      ...policyFields,
      ...terminalFields,
    };
  }
};
