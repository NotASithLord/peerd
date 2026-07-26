// @ts-check
// peerd-runtime/actor — the origin lock's imperative shell (issue #251).
//
// The POLICY is pure and lives next door (landing-rule.js decides,
// origin-sensitivity.js classifies). This binds it to a live actor: reads the
// actor's mode and owned origin, asks the rule, persists what changed, and
// reports what happened. All IO is injected, so the shell is testable without a
// browser and the SW's wiring stays a few lines.
//
// WHERE IT IS ENFORCED, AND WHERE IT IS NOT. `makeJudgeLanding` produces the
// `judgeLanding` called from two places: `resolveTargetTab` (every DOM tool, on
// the tab's current URL) and `navigate` (again, on the URL it just landed on —
// the only point in the tree that observes a landing as it is created, which is
// what catches a 302 nobody made a tool call for).
//
// That covers the DOM surface. It does NOT cover every way the actor's session
// authority can be spent, and an earlier draft of this header wrongly implied it
// did. The web actor also holds `fetch_url`, `read_web_cache` and the
// `site_client_*` tools, none of which pass through `resolveTargetTab`. Their
// credential scope is `ctx.activeTab.origin`, read live — so a page that
// redirects itself to a credentialed origin moves that scope with no tool call
// to judge, and those tools could spend it before any DOM tool re-entered the
// chokepoint.
//
// `makeCredentialScope` below is the answer to that, and it is a DIFFERENT shape
// on purpose: synchronous, so it can sit inside the credential-scope getter the
// egress wrapper already reads live on every request. It withholds the scope
// rather than refusing the call, so it can only ever narrow what the pre-#251
// code handed over. What remains uncovered is a SESSIONLESS cross-origin fetch,
// which is exactly what those tools do today when off-origin — no authority to
// take away.
//
// WHAT THIS DOES NOT DO, and must not silently appear to. On a `handoff` it
// records the successor origin and ends the actor — it does NOT mint the bound
// actor or forward a goal. Routing is the orchestrator's, and the goal text must
// be re-authored there rather than carried over from a possibly-hijacked roaming
// actor. If a future change makes this file forward actor-authored text into a
// handoff, the segmentation becomes decorative and #251's whole point is lost.

import { decideLanding, mayHoldCredentials } from './landing-rule.js';
import { classifyOriginSensitivity } from './origin-sensitivity.js';

/**
 * @typedef {object} ActorOriginState
 * @property {'roaming' | 'bound'} mode
 * @property {string | null} [ownedOrigin]
 * @property {import('./landing-rule.js').Excursion | null} [excursion]
 * @property {number} [excursionsUsed]
 */

/**
 * Build the `judgeLanding` an actor's tool context carries.
 *
 * @param {object} deps
 * @param {() => ActorOriginState | null} deps.getState  the calling actor's origin state,
 *   or null for a context the lock does not apply to (the orchestrator, an API
 *   actor with no tab, an engine kind). Null means "no lock".
 * @param {(patch: Partial<ActorOriginState>) => void | Promise<void>} deps.saveState
 * @param {(event: { action: string, reason: string, from: string | null, to: string, handoffTo?: string }) => void | Promise<void>} deps.onStop
 *   called when the verdict ends the actor — the SW turns this into the
 *   environment_changed report the orchestrator sees.
 * @param {(origin: string) => boolean} [deps.isUgcZone]
 * @param {(origin: string) => boolean} [deps.hasVaultSecret]
 * @param {() => ReadonlySet<string> | ReadonlyMap<string, any>} [deps.getLearned]
 * @param {(origin: string) => boolean} [deps.isIdp]
 * @param {() => number} [deps.now]
 * @returns {(url: string) => Promise<{ action: string, reason: string } | null>}
 */
export const makeJudgeLanding = (deps) => {
  const {
    getState, saveState, onStop,
    isUgcZone, hasVaultSecret, getLearned, isIdp, now = Date.now,
  } = deps;

  return async (url) => {
    const state = getState();
    // No state means the lock does not apply here. why not fail closed: this
    // function runs on EVERY DOM tool call including the orchestrator's own
    // and the engine kinds', and refusing those would break the product
    // wholesale. The security decision is which contexts GET a state, made
    // once in the SW, not re-litigated per call.
    if (!state) return null;

    const sensitivity = classifyOriginSensitivity(url, {
      isUgcZone, hasVaultSecret, learned: getLearned?.(),
    });

    const verdict = decideLanding({
      mode: state.mode,
      ownedOrigin: state.ownedOrigin ?? null,
      landing: url,
      landingIsSensitive: sensitivity.sensitive,
      landingIsIdp: isIdp?.(url) === true,
      excursion: state.excursion ?? null,
      excursionsUsed: state.excursionsUsed ?? 0,
      now: now(),
    });

    if (verdict.action === 'continue') {
      // Persist BOTH excursion transitions and the first-landing adoption.
      //
      // why `excursion` is written unconditionally rather than only when
      // present: absence means "cleared" in the rule's contract (a discharged
      // excursion returns no field), so coalescing it against the stored value
      // would keep a spent corridor alive forever. Always assign.
      /** @type {Partial<ActorOriginState>} */
      const patch = { excursion: verdict.excursion ?? null };
      if (verdict.adoptOrigin && !state.ownedOrigin) patch.ownedOrigin = verdict.adoptOrigin;
      // Count an excursion when one OPENS — the lifetime cap is what stops the
      // corridor being refreshed by bouncing home, so it must not be reset by
      // the same discharge that clears the corridor.
      if (verdict.excursion && !state.excursion) patch.excursionsUsed = (state.excursionsUsed ?? 0) + 1;
      await saveState(patch);
      return verdict;
    }

    // end | handoff — both stop this actor. The distinction rides in the event
    // so the orchestrator knows whether a successor is implied.
    await onStop({
      action: verdict.action,
      reason: verdict.reason,
      from: state.ownedOrigin ?? null,
      to: url,
      ...(verdict.handoffTo ? { handoffTo: verdict.handoffTo } : {}),
    });
    return verdict;
  };
};

/**
 * Build the SYNCHRONOUS credential-scope getter the web actor's egress wrapper
 * reads on every request.
 *
 * The SW today does `withSessionScopedCredentials(webFetch, () => ctx.activeTab?.origin)`.
 * This wraps that getter: same value when the lock is content for the actor to
 * be spending a session there, `undefined` — meaning sessionless — when it is
 * not. Undefined is already the wrapper's "no session" case, so nothing
 * downstream needs to learn a new shape.
 *
 * WHERE THE BEHAVIOUR ACTUALLY CHANGES, stated because a narrowing fails safe
 * but not visibly, and an earlier draft of this comment claimed more than it
 * should have. A ROAMING actor is unchanged everywhere it was allowed to be,
 * including on hosts `normalizeApiOrigin` cannot canonicalize — an IDN, a
 * single-label intranet name, a trailing-dot FQDN — because refusing those
 * bought nothing and cost the actor a logged-out page with no error to explain
 * it. What a roaming actor loses is its session on a SENSITIVE origin, which is
 * the whole point. A BOUND actor loses it everywhere except the one origin it
 * owns, which is also the whole point.
 *
 * why this cannot reuse `judgeLanding`: that function is async (it persists) and
 * it MUTATES state (it spends excursion budget). A credential-scope getter is
 * called synchronously, possibly several times per request, and must be free of
 * consequences. So the policy is asked in its read-only form (`mayHoldCredentials`)
 * and nothing here writes.
 *
 * @param {object} deps
 * @param {() => ActorOriginState | null} deps.getState
 * @param {() => string | undefined} deps.getOrigin  the live scope, normally `ctx.activeTab?.origin`
 * @param {(origin: string) => boolean} [deps.isUgcZone]
 * @param {(origin: string) => boolean} [deps.hasVaultSecret]
 * @param {() => ReadonlySet<string> | ReadonlyMap<string, any>} [deps.getLearned]
 * @returns {() => string | undefined}
 */
export const makeCredentialScope = (deps) => {
  const { getState, getOrigin, isUgcZone, hasVaultSecret, getLearned } = deps;
  return () => {
    const origin = getOrigin();
    if (!origin) return undefined;
    const state = getState();
    // No state means the lock does not apply to this context — the same
    // "decided once in the SW" rule as judgeLanding. Hand back the unmodified
    // scope so a non-locked actor behaves exactly as it did before #251.
    if (!state) return origin;
    const sensitivity = classifyOriginSensitivity(origin, {
      isUgcZone, hasVaultSecret, learned: getLearned?.(),
    });
    return mayHoldCredentials({
      mode: state.mode,
      ownedOrigin: state.ownedOrigin ?? null,
      excursion: state.excursion ?? null,
      origin,
      originIsSensitive: sensitivity.sensitive,
    })
      ? origin
      : undefined;
  };
};
