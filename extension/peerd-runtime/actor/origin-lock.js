// @ts-check
// peerd-runtime/actor — the origin lock's imperative shell (issue #251).
//
// The POLICY is pure and lives next door (landing-rule.js decides,
// origin-sensitivity.js classifies). This binds it to a live actor: reads the
// actor's mode and owned origin, asks the rule, persists what changed, and
// reports what happened. All IO is injected, so the shell is testable without a
// browser and the SW's wiring stays a few lines.
//
// ONE ENFORCEMENT POINT. `makeJudgeLanding` produces the `judgeLanding` that
// `resolveTargetTab` calls on every DOM tool. That is deliberately the only
// place: it is the single chokepoint every DOM tool funnels through, and it has
// already done the live `tabs.get()`, so it is the only place that knows where
// the tab ACTUALLY IS rather than where something asked it to go.
//
// WHAT THIS DOES NOT DO, and must not silently appear to. On a `handoff` it
// records the successor origin and ends the actor — it does NOT mint the bound
// actor or forward a goal. Routing is the orchestrator's, and the goal text must
// be re-authored there rather than carried over from a possibly-hijacked roaming
// actor. If a future change makes this file forward actor-authored text into a
// handoff, the segmentation becomes decorative and #251's whole point is lost.

import { decideLanding } from './landing-rule.js';
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
