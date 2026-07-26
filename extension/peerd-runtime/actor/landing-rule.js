// @ts-check
// peerd-runtime/actor — what happens when a web actor's tab lands somewhere.
// (issue #251, the decision half.)
//
// PURE. State in, verdict out. No IO, no clock of its own (`now` is injected),
// no knowledge of tabs or gates — so every branch below is exhaustively
// testable and the enforcement points stay thin.
//
// THE ONE RULE, and the reason this file is small:
//
//     Judge the LANDING, never the request.
//
// A tab's origin can change three ways:
//   1. the actor calls navigate()                     — a tool call we see
//   2. that navigation 302s somewhere else            — NO tool call for the hop
//   3. the page redirects itself (meta refresh / JS)  — no tool call at all
// Checking `args.url` catches only (1), and is defeated by any open redirect —
// which is not hypothetical: navigate.js RE-STAMPS the actor's pin to wherever
// the tab landed, so today (2) silently launders an origin change into an owned
// one. Testing where the tab ACTUALLY IS collapses all three into one check
// that no redirect chain can walk around.
//
// WHY A ROAMING ACTOR IS STOPPED RATHER THAN WARNED. An earlier draft let a
// roaming actor enter a credentialed site and relied on #242's forced confirm
// to catch the bad case. That makes the user's attention the boundary, which is
// backwards: a confirm is a backstop for where a boundary is missing, not a
// substitute for one. A roaming actor never holds the authority in the first
// place, so there is nothing for a hijack to spend.
//
// FAIL CLOSED, EVERYWHERE. This file's whole job is to REMOVE an authority an
// actor would otherwise keep, so an unrecognized input must never read as
// permission. Two places where a first draft got that backwards, both found in
// review and both now explicit: an unrecognized `mode` ends the actor rather
// than falling through, and a landing we cannot canonicalize is treated as
// FOREIGN rather than as "no page".

import { sameOrigin } from './origin-sensitivity.js';
import { normalizeApiOrigin } from './web-actor.js';

/**
 * @typedef {'continue' | 'handoff' | 'end'} LandingAction
 *
 *   continue  nothing to do — the actor may proceed.
 *   handoff   a ROAMING actor reached a credentialed origin. It ends, and the
 *             orchestrator routes the work to that origin's bound actor. The
 *             distinction from `end` is that there IS a successor.
 *   end       the actor's environment is gone or foreign. It stops. No successor
 *             is implied; the orchestrator decides what happens next.
 */

/**
 * An auth excursion: the ONE way a bound actor may be off its owned origin.
 *
 * @typedef {object} Excursion
 * @property {string} returnTo    the owned origin this must come back to
 * @property {string} openedAt    the IdP origin that opened it. why recorded:
 *   without it, "is this hop part of the sign-in I authorized" is not merely
 *   unenforced but UNREPRESENTABLE, and an open corridor becomes a free window
 *   onto any origin at all.
 * @property {string} lastLanding the landing this excursion last saw. why: the
 *   budget is spent per NAVIGATION, but this function is called per TOOL CALL
 *   (resolveTargetTab runs on every DOM tool). Without this, a single-page login
 *   — snapshot, type, click, snapshot — would burn the budget standing still and
 *   end the actor mid-sign-in.
 * @property {number} budget      navigations remaining
 * @property {number} deadline    epoch ms after which it is over regardless
 */

/**
 * @typedef {object} LandingVerdict
 * @property {LandingAction} action
 * @property {string} reason         one line, user-facing, no identifiers
 * @property {string} [handoffTo]    the origin whose bound actor should take over
 * @property {string} [adoptOrigin]  first landing only — the origin this actor now
 *   owns. why returned rather than re-derived by the caller: the obvious helper
 *   over there (`originOfUrl`) canonicalizes differently from `normalizeApiOrigin`
 *   on exactly the hosts that matter, so a caller deriving its own would disagree
 *   with the rule that later judges it.
 * @property {Excursion} [excursion] the excursion state going forward.
 *
 *   READ THIS AS A REPLACEMENT, NEVER AS A PATCH. Absent means "no excursion is
 *   running" — including the case where one just ENDED by returning home. A
 *   caller that writes `verdict.excursion ?? stored` would keep a discharged
 *   excursion alive forever, turning the one bounded exception in this file into
 *   a permanent hole. Always assign, never coalesce.
 */

/** Navigations one sign-in may take: app → IdP → consent → back is three. */
export const EXCURSION_BUDGET = 4;
/** why a deadline as well as a budget: a budget only decrements on navigation,
 * so a tab parked mid-excursion would hold the exception open indefinitely. */
export const EXCURSION_MS = 3 * 60_000;
/** How many excursions one bound actor may open, ever.
 *
 * why a lifetime cap and not just a per-leg budget: discharging at home CLEARS
 * the corridor, so without this a hostile page on the owned origin loops
 * home → IdP → hops → home → repeat and buys a fresh budget and deadline every
 * two navigations. Bounded per leg, unbounded per task — which is the bound that
 * actually matters. Legitimate work re-authenticates approximately never. */
export const MAX_EXCURSIONS = 2;

/**
 * Where is this tab, in the only three categories that matter?
 *
 *   'none'    no page to speak of — blank, about:, an extension page, a data:
 *             or javascript: URL, or a tab mid-load. Transient and not a
 *             violation; the caller's own null-tab handling owns it.
 *   'named'   a real http(s) page whose origin we can canonicalize.
 *   'unnamed' a real, LOADABLE http(s) page whose host `normalizeApiOrigin`
 *             refuses to name — an IP literal, IPv6, a trailing-dot FQDN, an
 *             underscore label, a single-label intranet host.
 *
 * why 'unnamed' exists as its own category, and why it was the worst bug in the
 * first draft of this file: normalizeApiOrigin's host rule was written so an
 * ADDRESSED origin can't collide with the literal 'web' or a numeric tabId — its
 * own comment says exactly that. It is not a "where is this tab" predicate.
 * Reusing it as one folded every host above into 'no page loaded', so a bound
 * actor 302'd to `https://evil.com./pwn` or `http://192.168.1.9/admin` was told
 * to CONTINUE. Those pages load fine. That inverts the file's only invariant,
 * and unlike the classifier's fail-open — which declines to ADD a protection —
 * it REMOVES one.
 *
 * @param {unknown} landing
 * @returns {{ kind: 'none' | 'named' | 'unnamed', origin: string | null }}
 */
const locate = (landing) => {
  const raw = String(landing ?? '').trim();
  if (!raw) return { kind: 'none', origin: null };
  let u;
  try { u = new URL(raw); } catch { return { kind: 'none', origin: null }; }
  // Anything that isn't a real web page: about:, chrome-extension:, data:,
  // javascript:, file:. Not somewhere an actor does work, and reachable
  // transiently during a load.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'none', origin: null };
  const origin = normalizeApiOrigin(raw);
  return origin ? { kind: 'named', origin } : { kind: 'unnamed', origin: null };
};

/**
 * Decide what happens now that the tab is at `landing`.
 *
 * @param {object} state
 * @param {'roaming' | 'bound'} state.mode
 * @param {string | null} [state.ownedOrigin]   bound only; null before the first landing
 * @param {unknown} state.landing               where the tab actually is now
 * @param {boolean} state.landingIsSensitive    from classifyOriginSensitivity
 * @param {boolean} [state.landingIsIdp]        is the landing a known identity provider
 * @param {Excursion | null} [state.excursion]  in-flight excursion, if any
 * @param {number} [state.excursionsUsed]       how many this actor has opened
 * @param {number} [state.now]                  injected clock
 * @returns {LandingVerdict}
 */
export const decideLanding = (state) => {
  const {
    mode, ownedOrigin = null, landing, landingIsSensitive,
    landingIsIdp = false, excursion = null, excursionsUsed = 0, now = 0,
  } = state;

  // FAIL CLOSED on an unrecognized mode. why this is not paranoia: an actor
  // record predating the field, a chrome.storage.session JSON round-trip, or a
  // typo in the SW's ctx rebuild would otherwise fall through every branch to a
  // permissive default and silently disable this entire core with no error.
  if (mode !== 'roaming' && mode !== 'bound') {
    return { action: 'end', reason: 'this helper is in an unknown state, so it was stopped' };
  }

  const { kind, origin: landingOrigin } = locate(landing);

  // Nowhere in particular. Transient; not a violation. Carry any excursion
  // through UNCHANGED — a blank read mid-sign-in must not discharge it, because
  // absence of the field means "cleared" to the caller.
  if (kind === 'none') {
    return { action: 'continue', reason: 'no page loaded', ...(excursion ? { excursion } : {}) };
  }

  if (mode === 'roaming') {
    // An unnameable host is never classified sensitive (the classifier refuses
    // it too), so roaming treats it as ordinary — consistent, and roaming holds
    // nothing to lose either way.
    if (kind === 'named' && landingIsSensitive) {
      return {
        action: 'handoff',
        handoffTo: /** @type {string} */ (landingOrigin),
        reason: 'this is a site you have an account on, so its own helper should do the work',
      };
    }
    return { action: 'continue', reason: 'ordinary page' };
  }

  // ── bound ────────────────────────────────────────────────────────────────
  // First landing after mint DEFINES what this actor owns, and the verdict says
  // WHAT to adopt so the caller never re-derives it differently.
  if (!ownedOrigin) {
    return kind === 'named'
      ? { action: 'continue', reason: 'first landing defines the owned site', adoptOrigin: /** @type {string} */ (landingOrigin) }
      : { action: 'end', reason: 'this page has no address peerd can pin work to' };
  }

  // A real page we cannot name is FOREIGN to a bound actor: it is provably not
  // the owned origin (which is nameable by construction).
  if (kind === 'unnamed') {
    return { action: 'end', reason: 'the tab moved to a page peerd cannot verify, so this task was stopped' };
  }

  if (sameOrigin(landingOrigin, ownedOrigin)) {
    // Home. Any excursion is over, successfully — the only good ending, and the
    // omission of `excursion` here is what discharges it.
    return { action: 'continue', reason: 'still on the owned site' };
  }

  // Off-origin. The only survivable case is an auth excursion still in credit.
  if (excursion) {
    if (now > excursion.deadline) {
      return { action: 'end', reason: 'the sign-in step took too long, so this task was stopped' };
    }
    // Where may a sign-in actually go? The IdP that opened it, and pages with
    // no identity of their own (interstitials, CDNs). NOT another credentialed
    // site: an open corridor must not become a window onto your mail or your
    // bank just because a sign-in started. why not "refuse every sensitive
    // hop": an IdP is definitionally a password-field origin, so the learned
    // signal will mark it — hence the openedAt exemption rather than a blanket
    // rule.
    const atOpener = sameOrigin(landingOrigin, excursion.openedAt);
    if (landingIsSensitive && !atOpener) {
      return { action: 'end', reason: 'the sign-in step led to another site you have an account on, so this task was stopped' };
    }
    // Spend budget only on an actual MOVE. This function runs per tool call,
    // not per navigation; without this a single-page login would burn the
    // budget standing still.
    const moved = !sameOrigin(landingOrigin, excursion.lastLanding);
    if (!moved) return { action: 'continue', reason: 'signing in', excursion };
    if (excursion.budget <= 0) {
      return { action: 'end', reason: 'the sign-in step went further than expected, so this task was stopped' };
    }
    return {
      action: 'continue',
      reason: 'signing in',
      excursion: { ...excursion, lastLanding: /** @type {string} */ (landingOrigin), budget: excursion.budget - 1 },
    };
  }

  // No excursion running. Landing on a known IdP OPENS one — deliberately
  // narrow: bound actors only, toward a known IdP only, with a budget, a
  // deadline, a recorded opener, and a lifetime cap.
  if (landingIsIdp) {
    if (excursionsUsed >= MAX_EXCURSIONS) {
      return { action: 'end', reason: 'this task has already signed in as many times as peerd allows, so it was stopped' };
    }
    return {
      action: 'continue',
      reason: 'signing in',
      excursion: {
        returnTo: ownedOrigin,
        openedAt: /** @type {string} */ (landingOrigin),
        lastLanding: /** @type {string} */ (landingOrigin),
        budget: EXCURSION_BUDGET,
        deadline: now + EXCURSION_MS,
      },
    };
  }

  // Anywhere else: the environment this actor owned is not where it is.
  // Redirect, hijack, or the user driving the tab — same answer; the caller
  // reports which via environment_changed.
  return { action: 'end', reason: 'this helper works only on one site, and the tab left it' };
};

/**
 * MAY THIS ACTOR SPEND THE USER'S SESSION AT `origin` RIGHT NOW?
 *
 * The same policy as above, asked of the CREDENTIAL rather than of the tool
 * call — and the reason it is a second function instead of a second branch is
 * that the two questions are asked at different times by different code.
 *
 * decideLanding runs when a DOM tool resolves a tab. But `ctx.activeTab.origin`
 * is ALSO the web actor's session-credential scope: the SW wraps its webFetch
 * with `withSessionScopedCredentials(webFetch, () => ctx.activeTab?.origin)`,
 * read live on every request. So the moment a page redirects itself onto a
 * credentialed origin, the actor's fetch scope moves there too — with no tool
 * call in between for decideLanding to judge. `fetch_url`, `read_web_cache` and
 * the `site_client_*` tools never pass through resolveTargetTab, so they can
 * spend that scope before any DOM tool re-enters the chokepoint.
 *
 * This closes that window because it is SYNCHRONOUS and can therefore sit
 * directly inside the scope getter, where an async judge cannot. It is a
 * narrowing, never a widening: it can only withhold a scope the pre-#251 code
 * would have handed over.
 *
 * why an excursion does NOT re-open the scope: signing in is a DOM flow — typing
 * into a form on the IdP's page — and the browser attaches that origin's own
 * cookies regardless. Letting peerd's fetch ALSO ride the user's session at an
 * origin the actor doesn't own would hand the corridor a capability the corridor
 * was never for.
 *
 * @param {object} state
 * @param {'roaming' | 'bound'} state.mode
 * @param {string | null} [state.ownedOrigin]
 * @param {Excursion | null} [state.excursion]
 * @param {unknown} state.origin           the scope being asked for
 * @param {boolean} state.originIsSensitive from classifyOriginSensitivity
 * @returns {boolean}
 */
export const mayHoldCredentials = (state) => {
  const { mode, ownedOrigin = null, excursion = null, origin, originIsSensitive } = state;
  if (mode !== 'roaming' && mode !== 'bound') return false;   // fail closed, as above
  const { kind, origin: scope } = locate(origin);
  // Nothing to scope. The getter's own `?? undefined` handles it; answering
  // false here would be the same outcome by a less obvious route.
  if (kind !== 'named') return false;

  if (mode === 'roaming') {
    // The whole definition of roaming: it browses, it holds nothing. On an
    // ordinary site there is no user session worth the name, so scoping cookies
    // to it costs nothing and keeps same-site fetches working as they do today.
    return !originIsSensitive;
  }

  // Bound: exactly the one origin it owns, and only once it owns one.
  if (!ownedOrigin) return false;
  if (excursion) return false;
  return sameOrigin(scope, ownedOrigin);
};
