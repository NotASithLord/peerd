// @ts-check
// Shared helpers for the DOM tools.
//
// Two responsibilities:
//
//   1. Resolve the "target tab" from a tool's args, and enforce the
//      denylist on the ACTUAL resolved tab. Tools take an optional
//      `tabId`; when omitted we default to the active tab. This is what
//      the V1 single-tab flow expects.

// Deep import of the PURE matcher (not the /peerd-egress/index.js barrel):
// the barrel pulls in vault/storage, which load the browser polyfill and
// break this module's unit tests. composer/resolvers.js imports it the
// same way for the same reason.
import { findDenylistMatch } from '../../../peerd-egress/denylist/denylist.js';
//
//   2. Functions that get INJECTED into the page via
//      chrome.scripting.executeScript. Those functions:
//        - can NOT close over any module-scope state (scripting
//          serializes them as plain JS to run in the page world)
//        - must NOT reference any helpers defined in this file
//          (closed-over imports don't get serialized)
//      So every injected fn is self-contained. We keep them here for
//      organization but each is independently executable.

/**
 * Get the tab the tool should operate on. Returns the chrome.tabs Tab
 * object, or null if not found — OR if the resolved tab is on the
 * denylist.
 *
 * why the denylist check lives HERE: the origin gate runs the denylist
 * against `tool.origins(args, ctx)`, which for DOM tools is
 * `[ctx.activeTab.origin]`. But execute() drives whatever `args.tabId`
 * resolves to — a different tab. origins() is synchronous and can't await
 * `tabs.get(args.tabId)`, so it structurally can't see the real target.
 * That left a hole: a tool called with a tabId pointing at a denylisted
 * bank/email/health tab would drive it despite the gate. We close it at
 * the one chokepoint every DOM tool funnels through. A denylisted target
 * yields null, which every caller already surfaces as a refusal.
 *
 * @param {{ tabId?: number }} args
 * @param {{ tabs: any, denylist?: readonly string[], activeTab?: { id: number, url: string, origin: string }, noteTab?: (tabId: number, url?: string, opts?: { opened?: boolean }) => void }} ctx
 */
export const resolveTargetTab = async (args, ctx) => {
  let tab = null;
  if (args?.tabId) {
    try { tab = await ctx.tabs.get(args.tabId); } catch { return null; }
  } else if (ctx.activeTab?.id) {
    try { tab = await ctx.tabs.get(ctx.activeTab.id); } catch { return null; }
  } else {
    const [t] = await ctx.tabs.query({ active: true, currentWindow: true });
    tab = t ?? null;
  }
  if (!tab) return null;
  if (isDenylistedTab(tab.url, ctx.denylist)) return null;
  // The loop just targeted THIS tab by id (navigate/click/type/read/… on a tab
  // the agent opened) — update the "current agent tab" card so it tracks where
  // the agent is working. Only when explicitly addressed (args.tabId): operating
  // on the user's OWN active tab (no tabId) isn't an agent tab to "go to".
  if (args?.tabId && typeof tab.id === 'number') {
    try { ctx.noteTab?.(tab.id); } catch { /* best-effort */ }
  }
  return tab;
};

/**
 * Is this tab's host on the denylist? Pure.
 * @param {string | undefined} url
 * @param {readonly string[] | undefined} denylist
 */
export const isDenylistedTab = (url, denylist) => {
  let hostname = '';
  // why: erased cast — a missing url throws inside new URL() and is caught
  // below (returns false), the same outcome the type narrowing would force.
  try { hostname = new URL(/** @type {string} */ (url)).hostname; } catch { return false; }
  return !!hostname && !!findDenylistMatch(hostname, denylist ?? []);
};

/**
 * Model-facing error for a CDP-only capability that has no fallback
 * (page_exec's Trusted-Types evaluation, page_keys' trusted input — the
 * gaps we deliberately do NOT fake with scripting). The wording depends
 * on WHY the pool is absent (ctx.cdpUnavailableReason, set by the SW):
 *
 *   'setting_off'         — Chrome, user turned advanced automation off:
 *                           the capability exists, point at the switch.
 *   'browser_unsupported' — the debugger (CDP) API isn't present in this
 *                           build at all: either Firefox (no chrome.debugger
 *                           API ever) OR the store Chrome package, which ships
 *                           WITHOUT the `debugger` permission until it's
 *                           re-added post-approval (see docs/store/
 *                           OPEN-DECISIONS.md). Neither has a switch to flip,
 *                           so the message must NOT name a specific browser or
 *                           offer a phantom toggle — and must NOT leak the
 *                           build channel to the agent (CLAUDE.md: channel
 *                           never reaches the model).
 *
 * Always starts with "debugger_unavailable" — the SW's nudge matcher and
 * the runner prompt's fallback guidance both key on that prefix.
 *
 * @param {{ cdpUnavailableReason?: string|null }} ctx
 * @param {string} gap   what cannot happen, e.g. 'running JS on Trusted-Types pages'
 * @param {string} hint  what the model should do instead
 */
export const cdpUnavailableError = (ctx, gap, hint) => {
  const reason = ctx?.cdpUnavailableReason;
  if (reason === 'browser_unsupported') {
    return `debugger_unavailable: this build of peerd has no debugger (CDP) API, so ${gap} is not `
      + `possible here — a platform/build limit, not a setting you can flip. ${hint}`;
  }
  if (reason === 'setting_off') {
    return `debugger_unavailable: advanced automation (the Chrome debugger) is off in Settings → `
      + `Advanced, so ${gap} is unavailable. ${hint}`;
  }
  return `debugger_unavailable: advanced automation (Chrome debugger) is unavailable, so ${gap} `
    + `is unavailable. ${hint}`;
};

/**
 * Best-effort URL → origin extraction. chrome:// and about: pages don't
 * have an "origin" in the network sense; return their scheme as a
 * stand-in so the origin gate has SOMETHING to denylist-check (and so
 * we can label tool calls in the UI).
 *
 * @param {string | undefined | null} url
 * @returns {string}
 */
export const originOfUrl = (url) => {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'chrome:' || u.protocol === 'about:' || u.protocol === 'devtools:') {
      return `${u.protocol}//${u.host || u.pathname.split('/')[0] || ''}`;
    }
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
};
