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
// The one live look at the target document (issues 267 + 276). Deep import for
// the same reason as above — dom/index.js is fine, but this file is unit-tested
// without a browser and the barrel is wider than the one function needed.
import { hasPasswordFieldInjected } from '../../dom/walk-injected.js';
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
 * How long the live probe gets before the chokepoint gives up on it.
 *
 * why a timeout at all: the probe is the only thing on this path that depends
 * on the RENDERER answering. A tool that drives the page through CDP (page_exec,
 * page_keys) never needed the renderer's cooperation, and a wedged main thread
 * must not turn into a hung tool call. Short enough to be invisible next to the
 * injections the DOM tools already do, long enough that an ordinary busy page
 * still answers.
 */
const LIVE_PROBE_TIMEOUT_MS = 400;

/**
 * Ask the document that is ACTUALLY committed in the target tab where it is and
 * whether it is showing a password field. Best-effort by construction: null
 * means "could not look", never "nothing there".
 *
 * why here and not in each tool: this is the only place that knows the tool is
 * about to touch a specific tab, and it is the only place every DOM tool passes
 * through. Before this, the password-field signal was observed in exactly ONE
 * tool (`snapshot`) — so an actor that perceived with `read_page` instead never
 * taught the classifier anything, and staying unlearned was a matter of which
 * tool it chose to call (issue 267). Tool choice belongs to whoever is driving
 * the actor, which is precisely the party the classifier exists to constrain.
 *
 * @param {{ id?: number }} tab
 * @param {{ scripting?: any }} ctx
 * @returns {Promise<{ origin: string | null, href: string | null, hasPasswordField: boolean | null } | null>}
 */
const probeLiveDocument = async (tab, ctx) => {
  if (typeof tab?.id !== 'number' || typeof ctx?.scripting?.executeScript !== 'function') return null;
  /** @type {any} */
  let timer = null;
  try {
    const probe = ctx.scripting.executeScript({ target: { tabId: tab.id }, func: hasPasswordFieldInjected });
    const raced = await Promise.race([
      probe,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), LIVE_PROBE_TIMEOUT_MS); }),
    ]);
    const v = raced?.[0]?.result;
    if (!v) return null;
    return {
      origin: typeof v.origin === 'string' ? v.origin : null,
      href: typeof v.href === 'string' ? v.href : null,
      hasPasswordField: typeof v.has === 'boolean' ? v.has : null,
    };
  } catch {
    // Pages the browser refuses to inject into (chrome:, the extension stores,
    // a tab mid-navigation) land here. FAIL OPEN: the caller keeps the verdict
    // it already reached on tab.url. Refusing instead would break every
    // CDP-driven tool on exactly the pages CDP exists for.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

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
 * @param {{ tabs: any, denylist?: readonly string[], activeTab?: { id: number, url: string, origin: string }, actorType?: string, noteTab?: (tabId: number, url?: string, opts?: { opened?: boolean }) => void, judgeLanding?: (url: string) => Promise<{ action: string } | null>, scripting?: any, noteLearnedOrigin?: (origin: string, reason: string) => void }} ctx
 *
 * `judgeLanding` (issue 251) is the origin lock, injected by the SW so this
 * file stays free of actor state and the policy stays pure and unit-tested
 * (`peerd-runtime/actor/landing-rule.js`). Absent — a non-actor context, or an
 * actor kind with no tab — means no lock, which is the pre-251 behaviour.
 */
export const resolveTargetTab = async (args, ctx) => {
  let tab = null;
  if (args?.tabId) {
    try { tab = await ctx.tabs.get(args.tabId); } catch { return null; }
  } else if (ctx.activeTab?.id) {
    try { tab = await ctx.tabs.get(ctx.activeTab.id); } catch { return null; }
  } else if (ctx.actorType) {
    // DESIGN-17 FAIL-CLOSED: an ACTOR has no user-foreground context. A WEB
    // actor OWNS exactly one tab and ctx.activeTab IS it; if that couldn't be
    // resolved (the owned tab closed mid-turn — the TOCTOU between mint and turn),
    // refuse rather than fall through to the foreground query below. Without this
    // guard a web actor whose tab vanished would silently retarget the USER's
    // active page. (The engine kinds never reach here — their toolset has no DOM
    // tools — so this is the web actor's wall in practice.)
    return null;
  } else {
    const [t] = await ctx.tabs.query({ active: true, currentWindow: true });
    tab = t ?? null;
  }
  if (!tab) return null;
  if (isDenylistedTab(tab.url, ctx.denylist)) return null;
  // issue 251 — THE ORIGIN LOCK, enforced here and only here.
  //
  // why this chokepoint and not the gate stack: gates are pure and synchronous
  // and run on `args`, but the question is "where did the tab actually END UP",
  // which needs the live read this function has already done. A gate checking
  // args.url is defeated by any 302 — and navigate.js used to re-stamp the pin
  // to the landing origin, laundering an open redirect into an owned one. Every
  // DOM tool funnels through here, so one check covers the whole DOM surface.
  //
  // CAVEAT, found by adversarial review and worth keeping in front of the next
  // reader: null here means BOTH "no tab" and "refused", and navigate.js used to
  // read the first meaning and adopt a fresh tab — turning a refusal into a new
  // credentialed tab. It now guards on the pin. Any future caller that reacts to
  // null by CREATING something must make the same distinction; "every caller
  // treats null as a refusal" was asserted here once and was not true.
  if (ctx.judgeLanding) {
    const verdict = await ctx.judgeLanding(tab.url);
    if (verdict && verdict.action !== 'continue') return null;
  }
  // ONE live look at the document that is actually there — the answer to two
  // findings, and the reason it is worth a round trip.
  //
  // issue 276: everything above judged `tab.url`, which is what the BROWSER
  // recorded, read out of a record frozen before this function was called. The
  // document committed right now can be a different origin, and the tool's own
  // injection lands in that one. Re-checking the origin the document reports
  // about ITSELF narrows the window from "however stale the tab record is" to
  // "one message round trip". It does not close it: the tool injects after we
  // return, and only pinning the judged documentId at injection time would make
  // that airtight. Stated plainly so the next reader does not over-trust it.
  //
  // issue 267: while we are in there, observe the password field — so every DOM
  // tool teaches the classifier, not just `snapshot`.
  const live = await probeLiveDocument(tab, ctx);
  if (live?.origin && live.origin !== originOfUrl(tab.url)) {
    // It moved. Judge where it IS, on the same two rules, and refuse on either.
    if (isDenylistedTab(live.href ?? live.origin, ctx.denylist)) return null;
    if (ctx.judgeLanding) {
      const verdict = await ctx.judgeLanding(live.href ?? live.origin);
      if (verdict && verdict.action !== 'continue') return null;
    }
  }
  if (live?.hasPasswordField === true && live.origin) {
    // Attributed to the origin that REPORTED it, never to the tab record — the
    // #278 rule, held by construction here rather than by comparison.
    try { ctx.noteLearnedOrigin?.(live.origin, 'password-field'); } catch { /* best-effort */ }
  }
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
