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
// A tab's origin can change three ways, and an earlier draft of #251 tried to
// handle them separately:
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

import { sameOrigin } from './origin-sensitivity.js';
import { normalizeApiOrigin } from './web-actor.js';

/**
 * @typedef {'continue' | 'handoff' | 'end'} LandingAction
 *
 *   continue  nothing to do — the actor may proceed.
 *   handoff   a ROAMING actor reached a credentialed origin. It ends, and the
 *             orchestrator is told to route the work to that origin's bound
 *             actor. The distinction from `end` is that there IS a successor.
 *   end       the actor's environment is gone or foreign. It stops. No successor
 *             is implied; the orchestrator decides what to do next.
 */

/**
 * @typedef {object} Excursion
 * @property {string} returnTo   the owned origin the excursion must come back to
 * @property {number} budget     navigations remaining before it is over
 * @property {number} deadline   epoch ms after which it is over regardless
 */

/**
 * @typedef {object} LandingVerdict
 * @property {LandingAction} action
 * @property {string} reason         one line, user-facing, no identifiers
 * @property {string} [handoffTo]    the origin whose bound actor should take over
 * @property {Excursion} [excursion] the excursion state going forward.
 *
 *   READ THIS AS A REPLACEMENT, NEVER AS A PATCH. Absent means "no excursion is
 *   running" — including the case where one just ENDED by returning home. A
 *   caller that writes `verdict.excursion ?? stored` would keep a discharged
 *   excursion alive forever, turning the one bounded exception in this file
 *   into a permanent hole. Always assign, never coalesce.
 */

/** The excursion budget. Small on purpose — an SSO round trip is a handful of
 * hops (app → IdP → maybe a consent screen → back). A generous budget is just a
 * wider corridor for an attacker to work in, and the cost of being wrong is one
 * re-delegation, not a broken flow. */
export const EXCURSION_BUDGET = 4;
/** why a deadline as well as a budget: a budget only decrements on navigation,
 * so a tab parked mid-excursion would hold the exception open indefinitely. */
export const EXCURSION_MS = 3 * 60_000;

/**
 * Decide what happens now that the tab is at `landing`.
 *
 * @param {object} state
 * @param {'roaming' | 'bound'} state.mode
 * @param {string | null} [state.ownedOrigin]   bound actors only; null before the first landing
 * @param {unknown} state.landing               where the tab actually is now
 * @param {boolean} state.landingIsSensitive    from classifyOriginSensitivity
 * @param {boolean} [state.landingIsIdp]        is the landing a known identity provider
 * @param {Excursion | null} [state.excursion]  in-flight excursion, if any
 * @param {number} [state.now]                  injected clock
 * @returns {LandingVerdict}
 */
export const decideLanding = (state) => {
  const {
    mode, ownedOrigin = null, landing, landingIsSensitive,
    landingIsIdp = false, excursion = null, now = 0,
  } = state;

  const landingOrigin = normalizeApiOrigin(landing);

  // A tab that is nowhere usable — blank, about:, an extension page, junk.
  // Not a violation and not a place to work: let the caller's own null-tab
  // handling deal with it rather than ending an actor over a transient state.
  if (!landingOrigin) return { action: 'continue', reason: 'no page loaded' };

  if (mode === 'roaming') {
    // THE NO-ENTRY RULE. A roaming actor holds no credentials and must not
    // acquire any by walking into a site where the user has an identity.
    if (landingIsSensitive) {
      return {
        action: 'handoff',
        handoffTo: landingOrigin,
        reason: 'this is a site you have an account on, so its own helper should do the work',
      };
    }
    return { action: 'continue', reason: 'ordinary page' };
  }

  // ── bound ────────────────────────────────────────────────────────────────
  // First landing after mint DEFINES what this actor owns. Mirrors the API
  // actor, whose origin is fixed at mint; a bound actor starts on a blank tab
  // and cannot know its origin before it arrives.
  if (!ownedOrigin) return { action: 'continue', reason: 'first landing defines the owned site' };

  if (sameOrigin(landingOrigin, ownedOrigin)) {
    // Home. Any excursion that was running is over, successfully — this is the
    // ONLY way an excursion ends well, which is what makes it bounded rather
    // than a hole.
    return { action: 'continue', reason: 'still on the owned site' };
  }

  // Off-origin. The only survivable case is an auth excursion still in credit.
  if (excursion) {
    const expired = now > excursion.deadline;
    const spent = excursion.budget <= 0;
    if (expired || spent) {
      return {
        action: 'end',
        reason: expired
          ? 'the sign-in step took too long, so this task was stopped'
          : 'the sign-in step went further than expected, so this task was stopped',
      };
    }
    // Still travelling. Decrement and carry on.
    return {
      action: 'continue',
      reason: 'signing in',
      excursion: { ...excursion, budget: excursion.budget - 1 },
    };
  }

  // No excursion running. Landing on a known IdP OPENS one — this is the OAuth
  // solve, and it is deliberately narrow: only a bound actor, only toward a
  // known IdP, only with a budget and a deadline, and it can only be discharged
  // by returning to the owned origin.
  if (landingIsIdp) {
    return {
      action: 'continue',
      reason: 'signing in',
      excursion: {
        returnTo: ownedOrigin,
        budget: EXCURSION_BUDGET,
        deadline: now + EXCURSION_MS,
      },
    };
  }

  // Anywhere else: the environment this actor owned is not where it is.
  // Whether a redirect, a hijack, or the user driving the tab themselves, the
  // answer is the same and the caller reports which via environment_changed.
  return {
    action: 'end',
    reason: 'this helper works only on one site, and the tab left it',
  };
};
