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
 * @typedef {'continue' | 'wait' | 'handoff' | 'end'} LandingAction
 *
 *   continue  nothing to do — the actor may proceed.
 *   wait      a confirmed sign-in is in progress. The tab stays bound, but the
 *             actor may not touch the identity provider. The user owns this leg.
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
 * @property {string} idpOrigin   the exact identity-provider origin the user
 *   approved. No intermediate origin is part of the corridor.
 * @property {number} deadline    epoch ms after which it is over regardless
 * @property {true} authorized    a host-stamped marker. Persisted excursions
 *   from the old landing-only design do not have it and fail closed.
 */

/**
 * A one-shot grant created by the host after the user confirms a verified
 * sign-in affordance. The landing rule consumes it into an Excursion.
 *
 * @typedef {object} AuthGrant
 * @property {string} returnTo
 * @property {string} idpOrigin
 * @property {number} deadline
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
 * @property {AuthGrant} [authGrant] the unused sign-in grant going forward.
 *
 *   READ THIS AS A REPLACEMENT, NEVER AS A PATCH. Absent means "no excursion is
 *   running" — including the case where one just ENDED by returning home. A
 *   caller that writes `verdict.excursion ?? stored` would keep a discharged
 *   excursion alive forever, turning the one bounded exception in this file into
 *   a permanent hole. Always assign, never coalesce.
 */

/** Kept as a public compatibility export. Exact-origin corridors use no hop budget. */
export const EXCURSION_BUDGET = 4;
/** A deadline keeps an unused grant or parked sign-in from living indefinitely. */
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
 * Is `landing` the same site as `owned`, differing ONLY by a leading `www.`?
 *
 * Scheme and port must match exactly — a www-fold is a host convention, never a
 * licence to change protocol or port. Both directions are accepted because sites
 * canonicalize in both (apex→www is the common one; www→apex happens too).
 *
 * @param {string | null} landing
 * @param {string | null} owned
 */
const isWwwFold = (landing, owned) => {
  if (!landing || !owned) return false;
  let a; let b;
  try { a = new URL(landing); b = new URL(owned); } catch { return false; }
  if (a.protocol !== b.protocol || a.port !== b.port) return false;
  const x = a.hostname.toLowerCase();
  const y = b.hostname.toLowerCase();
  return x === `www.${y}` || y === `www.${x}`;
};

/**
 * Durable grants carry origins, not arbitrary URLs. Requiring the stored value
 * to equal the canonical form makes a corrupted path, casing change, or port
 * spelling fail closed instead of being silently broadened by `sameOrigin`.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
const isCanonicalHttpsOrigin = (value) => typeof value === 'string'
  && value.startsWith('https://')
  && normalizeApiOrigin(value) === value;

/**
 * Decide what happens now that the tab is at `landing`.
 *
 * @param {object} state
 * @param {'roaming' | 'bound'} state.mode
 * @param {string | null} [state.ownedOrigin]   bound only; null before the first landing
 * @param {unknown} state.landing               where the tab actually is now
 * @param {boolean} state.landingIsSensitive    from classifyOriginSensitivity
 * @param {boolean} [state.landingIsIdp]        is the landing a known identity provider
 * @param {boolean} [state.provisional]      was `ownedOrigin` ASKED FOR rather than
 *   OBSERVED? True for a `site:<origin>` actor, whose origin the orchestrator
 *   spelled; false for a handoff successor, whose origin a roaming actor was
 *   already on. Only a provisional origin may settle onto its own www-fold.
 * @param {Excursion | null} [state.excursion]  in-flight excursion, if any
 * @param {AuthGrant | null} [state.authGrant]   unused host-stamped grant
 * @param {number} [state.excursionsUsed]       how many this actor has opened
 * @param {number} [state.now]                  injected clock
 * @returns {LandingVerdict}
 */
export const decideLanding = (state) => {
  const {
    mode, ownedOrigin = null, landing, landingIsSensitive,
    landingIsIdp = false, excursion = null, authGrant = null,
    excursionsUsed = 0, now = 0,
    provisional = false,
  } = state;

  // FAIL CLOSED on an unrecognized mode. why this is not paranoia: an actor
  // record predating the field, a chrome.storage.session JSON round-trip, or a
  // typo in the SW's ctx rebuild would otherwise fall through every branch to a
  // permissive default and silently disable this entire core with no error.
  if (mode !== 'roaming' && mode !== 'bound') {
    return { action: 'end', reason: 'this helper is in an unknown state, so it was stopped' };
  }

  const { kind, origin: landingOrigin } = locate(landing);

  // Validate durable corridor state before interpreting the landing. A service
  // worker restart must not turn malformed, expired, or legacy data into
  // permission. Null means absent; every present value must be exact.
  const validGrant = authGrant !== null
    && typeof authGrant === 'object'
    && sameOrigin(authGrant.returnTo, ownedOrigin)
    && isCanonicalHttpsOrigin(authGrant.returnTo)
    && isCanonicalHttpsOrigin(authGrant.idpOrigin)
    && Number.isFinite(authGrant.deadline)
    && now <= authGrant.deadline;
  const validExcursion = excursion !== null
    && typeof excursion === 'object'
    && excursion.authorized === true
    && sameOrigin(excursion.returnTo, ownedOrigin)
    && isCanonicalHttpsOrigin(excursion.returnTo)
    && isCanonicalHttpsOrigin(excursion.idpOrigin)
    && Number.isFinite(excursion.deadline)
    && now <= excursion.deadline;
  if (mode === 'bound'
    && ((authGrant !== null && !validGrant)
      || (excursion !== null && !validExcursion)
      || (authGrant !== null && excursion !== null))) {
    return { action: 'end', reason: 'the sign-in authorization was invalid or expired, so this task was stopped' };
  }

  // Nowhere in particular. Transient; not a violation. Carry any excursion
  // through UNCHANGED — a blank read mid-sign-in must not discharge it, because
  // absence of the field means "cleared" to the caller.
  if (kind === 'none') {
    return {
      action: 'continue', reason: 'no page loaded',
      ...(validGrant ? { authGrant: /** @type {AuthGrant} */ (authGrant) } : {}),
      ...(validExcursion ? { excursion: /** @type {Excursion} */ (excursion) } : {}),
    };
  }

  if (mode === 'roaming') {
    // Dedicated sign-in origins are corridors, not destinations. Handoff would
    // invite the orchestrator to mint a standalone site actor with authority
    // over the user's identity provider. Only a bound relying-party actor may
    // enter one, through the limited excursion below.
    if (kind === 'named' && landingIsIdp) {
      return {
        action: 'end',
        reason: 'this is a sign-in service that helpers may only visit while signing in to another site',
      };
    }
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

  // A PROVISIONAL owned origin — one that was ASKED FOR rather than OBSERVED —
  // may settle onto the www-fold of itself on its very first landing.
  //
  // why this exists at all: `site:<origin>` is a handle the orchestrator SPELLS,
  // from the user's words or its own guess, so the origin is a request. Loading
  // `https://reddit.com` lands on `https://www.reddit.com`, which is ordinary
  // web behaviour and not an attack — but sameOrigin says no, and the actor
  // ended. Worse, the binding is durable, so retrying the same handle resumed
  // the same session pinned to the same unreachable origin: a permanent dead end
  // for that chat, one orphaned tab per attempt. Adversarial review found it and
  // was right that it would be hit on the first commonly-named site.
  //
  // why ONLY the www fold, and not "same registrable domain": working out the
  // registrable domain needs a public-suffix list we do not ship, and the cheap
  // approximation (share the last two labels) is actively wrong on `co.uk` —
  // `bbc.co.uk` and `evil.co.uk` would look like the same site. The apex↔www
  // pair is the case that actually bites, and it is decidable with no list and
  // no ambiguity. Anything else still ends, and the report names where the tab
  // landed so the orchestrator can re-address it deliberately.
  //
  // The HANDOFF path is unaffected either way: `handoffTo` is the origin a
  // roaming actor was already ON, so it is an observation and this branch is a
  // no-op for it.
  if (provisional && kind === 'named' && !sameOrigin(landingOrigin, ownedOrigin)) {
    if (isWwwFold(landingOrigin, ownedOrigin)) {
      return {
        action: 'continue',
        reason: 'the site redirected to its canonical host',
        adoptOrigin: /** @type {string} */ (landingOrigin),
      };
    }
  }

  // A real page we cannot name is FOREIGN to a bound actor: it is provably not
  // the owned origin (which is nameable by construction).
  if (kind === 'unnamed') {
    return { action: 'end', reason: 'the tab moved to a page peerd cannot verify, so this task was stopped' };
  }

  if (sameOrigin(landingOrigin, ownedOrigin)) {
    // Home discharges an active excursion. An unused live grant stays armed:
    // login re-verifies the relying page after consent and before clicking, so
    // consuming it on that safety read would break the confirmed flow.
    return {
      action: 'continue', reason: 'still on the owned site',
      ...(validGrant ? { authGrant: /** @type {AuthGrant} */ (authGrant) } : {}),
    };
  }

  // The actor never works on the identity provider. The browser and user own
  // that leg. A later page action is allowed only after the tab returns home.
  if (validExcursion) {
    if (!landingIsIdp || !sameOrigin(landingOrigin, excursion.idpOrigin)) {
      return { action: 'end', reason: 'the sign-in step left its approved provider, so this task was stopped' };
    }
    return {
      action: 'wait',
      reason: 'finish signing in in the open tab, then return here to continue',
      excursion: /** @type {Excursion} */ (excursion),
    };
  }

  // A known IdP landing is not self-authorizing. It consumes one exact,
  // unexpired grant stamped by the host after the user's login confirmation.
  if (landingIsIdp && validGrant && sameOrigin(landingOrigin, authGrant.idpOrigin)) {
    if (excursionsUsed >= MAX_EXCURSIONS) {
      return { action: 'end', reason: 'this task has already signed in as many times as peerd allows, so it was stopped' };
    }
    return {
      action: 'wait',
      reason: 'finish signing in in the open tab, then return here to continue',
      excursion: {
        returnTo: ownedOrigin,
        idpOrigin: /** @type {string} */ (landingOrigin),
        deadline: authGrant.deadline,
        authorized: true,
      },
    };
  }

  // Keep this reason distinct from an ordinary foreign-origin stop. The report
  // layer uses it to avoid suggesting a standalone site helper for an identity
  // provider. A matching grant whose target is no longer in the IdP registry
  // lands here too, so registry tightening fails closed.
  if (landingIsIdp || (validGrant && sameOrigin(landingOrigin, authGrant.idpOrigin))) {
    return { action: 'end', reason: 'this sign-in was not authorized, so this task was stopped' };
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
 * call in between for decideLanding to judge. `fetch_url`, `read_result` and
 * the `site_client_*` tools never pass through resolveTargetTab, so they can
 * spend that scope before any DOM tool re-enters the chokepoint.
 *
 * This closes that window because it is SYNCHRONOUS and can therefore sit
 * directly inside the scope getter, where an async judge cannot. It is a
 * narrowing, never a widening: it can only withhold a scope the pre-#251 code
 * would have handed over.
 *
 * why an excursion does NOT re-open the scope: the user and browser own the IdP
 * step, including its cookies. Letting peerd's fetch also ride that session
 * would give the parked actor authority the confirmed transition never granted.
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
  const { mode, ownedOrigin = null, origin, originIsSensitive } = state;
  if (mode !== 'roaming' && mode !== 'bound') return false;   // fail closed, as above
  const { kind, origin: scope } = locate(origin);
  // Not a web page at all (blank, about:, an extension page). Nothing to scope.
  if (kind === 'none') return false;

  if (mode === 'roaming') {
    // A real page whose host we cannot CANONICALIZE — an IDN whose punycode TLD
    // the normalizer's tail rule rejects, a single-label intranet name, a
    // trailing-dot FQDN. Roaming is allowed to be there (the classifier refuses
    // to call such a host sensitive, so `landingIsSensitive` is false and
    // decideLanding continues), and roaming holds nothing worth withholding.
    //
    // why this branch exists at all, found by adversarial review: without it,
    // `https://пример.рф` and `http://wiki/` fell to a blanket refusal and a
    // roaming actor silently got LOGGED-OUT content on an ordinary public site
    // it was entitled to use — no error, no audit entry, just a 401 body. The
    // comment next door claimed the ordinary case was unchanged, and for those
    // hosts it was not. The caller compares scope against the request origin
    // itself, so handing back the raw value restores exactly the pre-#251
    // behaviour without widening anything.
    if (kind === 'unnamed') return true;
    // The whole definition of roaming: it browses, it holds nothing. On an
    // ordinary site there is no user session worth the name, so scoping cookies
    // to it costs nothing and keeps same-site fetches working as they do today.
    return !originIsSensitive;
  }

  // Bound, and the host cannot be named. It is provably NOT the owned origin,
  // which is nameable by construction — the same reasoning decideLanding uses to
  // end the actor outright.
  if (kind !== 'named') return false;

  // Bound: exactly the one origin it owns, and only once it owns one.
  if (!ownedOrigin) return false;
  // The owned origin is allowed unconditionally — INCLUDING mid-excursion.
  //
  // why the excursion check comes second, which is the opposite of a first
  // draft: this function is synchronous and therefore cannot discharge an
  // excursion, while `decideLanding` (which can) only runs on a tool call. So a
  // tab that has already come home sits with stale active state until the
  // next DOM tool judges it. Refusing the owned origin during that window broke
  // the actor's session on the one site it is definitionally allowed to use —
  // and bought nothing, since the sign-in state never widened what "home" means.
  if (sameOrigin(scope, ownedOrigin)) return true;
  // Off-origin, excursion or not. The user and browser own the IdP step, and the
  // browser attaches that origin's own cookies regardless. Letting peerd's fetch
  // also ride the user's session somewhere the actor does not own would grant a
  // capability the confirmed transition never included.
  return false;
};
