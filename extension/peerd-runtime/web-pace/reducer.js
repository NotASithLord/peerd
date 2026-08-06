// @ts-check
// web-pace/reducer.js — the PURE policy core of adaptive per-origin action
// pacing. Issue #234 is the decision record.
//
// This module is not wired into storage, hooks, dispatch, or UI. It changes no
// extension behavior on its own. A future integration must keep rules in the
// trusted service-worker control plane, feed only fixed trusted classifiers
// into these transitions, and keep rule history out of model context. Arbitrary
// page text is never a pacing instruction.
//
// THE SHAPE. The default interval is zero. A trusted observer may pass a block
// signal through nextRuleOnBlock, producing an interval for that exact origin.
// Quiet time decays it toward zero. A probe may test one action at a lower
// interval, then adopt that interval only after a clean outcome and settle
// period. The intended loop is observe -> learn -> enforce -> decay/probe.
//
// why a pure core: every transition here is a function of (rule, signal, now).
// No storage, no clock, no Math.random — the caller injects them. That makes the
// policy deterministic under Bun (see web-pace-reducer.test.ts) and keeps the
// enforcement/observation hooks as thin imperative shells, per the module's
// functional-core rule.
//
// THE FENCE (why this file holds no page strings). The integration must treat a
// rule as control-plane data, not prose for the model. This reducer does not
// establish that boundary by itself.
//
// THE DESCENT RULE (the load-bearing safety property). A rule rises only from
// trusted block signals, and it may come down only through automatic time-based
// decay or a bounded probe that snaps back on a block. There is deliberately no
// clearRule() or model-controlled set operation. LOWERING is the direction an
// injected page benefits from: retire the rule, peerd hammers the site, and the
// user's logged-in account absorbs the risk. An argument check cannot validate
// intent. Descent is therefore limited to time-based decay and the one-action
// probe state machine below.

import { clamp } from '/shared/util.js';

/**
 * One learned rule for one origin. The FIELD SET is the contract (the numbers
 * are seeds, below); `minIntervalMs: 0` means "no rule" — the default state of
 * every origin peerd has never been blocked by.
 *
 * @typedef {Object} PaceRule
 * @property {1} version                       persisted shape version
 * @property {string} origin                 the key this rule binds to
 * @property {number} minIntervalMs          enforced gap between action tools; 0 == no rule
 * @property {number} jitterFrac             ± fraction applied to the gap (a UNIFORM gap is itself a tell)
 * @property {number} observations           how many blocks have fed this rule
 * @property {number} lastBlockAt            epoch ms of the last observed block; drives decay eligibility
 * @property {number} lastDecayAt            epoch ms of the last decay/adopt
 * @property {number} createdAt              epoch ms
 * @property {number} updatedAt              epoch ms
 * @property {'learned'|'retry-after'} lastEscalationSource source of the last increase
 * @property {null | {
 *   trialMs: number,
 *   startedAt: number,
 *   until: number,
 *   prevMinIntervalMs: number,
 *   actionStartedAt: number | null,
 *   cleanObservedAt: number | null,
 * }} probe a one-action staleness test
 */

/**
 * The tunables bundle (`K`). These are starting values to tune through the eval
 * harness and field reports. Injection lets tests pin exact arithmetic.
 *
 * @typedef {Object} PaceTunables
 * @property {number} growth         multiplier on a REPEAT block (compounding escalation)
 * @property {number} slowdownMult   "we were going at X and got blocked -> go slowdownMult * X"
 * @property {number} seedMs         floor for a FIRST block when no cadence sample exists
 * @property {number} decay          multiplier applied per elapsed quiet period (< 1)
 * @property {number} quietMs        block-free time that earns one decay step
 * @property {number} maxPaceMs      ceiling; at/over it the future caller must hand off rather than wait
 * @property {number} jitterFrac     default ± fraction for a new rule
 * @property {number} retireFloorMs  decayed below this, the rule is retired (deleted)
 * @property {number} minProbeWindowMs shortest useful observation window
 * @property {number} maxProbeWindowMs longest a probe may suppress normal decay
 * @property {number} probeSettleMs     quiet time after a clean observed result
 */

/** @type {PaceTunables} */
export const PACE_TUNABLES = Object.freeze({
  growth: 2,
  slowdownMult: 2,
  // why a seed: a block is evidence even when we have no cadence sample to size
  // from (an SW restart lost the interval ring, or the block landed on the first
  // action). Without a floor, `max()` of unknowns is 0 and we would "learn"
  // no rule from a real block.
  seedMs: 1_000,
  decay: 0.5,
  quietMs: 30 * 60_000,
  // why a ceiling at all: pacing is for shaving seconds. A site that wants us
  // minutes slower is not a pacing problem. needsHandOff() tells the future
  // controller to use a challenge hand-back or assist-only posture instead of
  // silently sleeping a turn.
  maxPaceMs: 30_000,
  jitterFrac: 0.3,
  retireFloorMs: 250,
  minProbeWindowMs: 5_000,
  maxProbeWindowMs: 5 * 60_000,
  probeSettleMs: 2_000,
});

export const PACE_RULE_VERSION = 1;

/** @param {unknown} value @returns {value is number} */
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Validate data at the persistence boundary before any action uses it. An
 * unreadable rule must make a future write path fail closed, not turn pacing
 * off. The optional origin check prevents a valid record being replayed under
 * another key.
 *
 * @param {unknown} value
 * @param {string | undefined} [expectedOrigin]
 * @param {PaceTunables} [K]
 * @returns {value is PaceRule}
 */
export const isValidRule = (value, expectedOrigin, K = PACE_TUNABLES) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = /** @type {Partial<PaceRule>} */ (value);
  if (rule.version !== PACE_RULE_VERSION) return false;
  if (typeof rule.origin !== 'string' || rule.origin.length === 0) return false;
  if (expectedOrigin !== undefined && rule.origin !== expectedOrigin) return false;
  if (!isFiniteNumber(rule.minIntervalMs)
    || rule.minIntervalMs < 0
    || rule.minIntervalMs > K.maxPaceMs) return false;
  if (!isFiniteNumber(rule.jitterFrac)
    || rule.jitterFrac < 0
    || rule.jitterFrac > K.jitterFrac) return false;
  const observations = rule.observations;
  if (!isFiniteNumber(observations) || !Number.isInteger(observations) || observations < 0) return false;
  const { lastBlockAt, lastDecayAt, createdAt, updatedAt } = rule;
  if (!isFiniteNumber(lastBlockAt) || lastBlockAt < 0
    || !isFiniteNumber(lastDecayAt) || lastDecayAt < 0
    || !isFiniteNumber(createdAt) || createdAt < 0
    || !isFiniteNumber(updatedAt) || updatedAt < 0) return false;
  if (updatedAt < createdAt || lastDecayAt < createdAt || lastDecayAt > updatedAt) return false;
  if (observations === 0) {
    if (lastBlockAt !== 0 || rule.minIntervalMs !== 0) return false;
  } else if (lastBlockAt < createdAt || lastBlockAt > updatedAt) return false;
  if (rule.lastEscalationSource !== 'learned' && rule.lastEscalationSource !== 'retry-after') return false;
  if (observations === 0 && rule.lastEscalationSource !== 'learned') return false;
  if (rule.probe === null) return true;
  if (!rule.probe || typeof rule.probe !== 'object') return false;
  const probe = rule.probe;
  if (!isFiniteNumber(probe.trialMs)
    || probe.trialMs < 0
    || probe.trialMs > rule.minIntervalMs) return false;
  if (!isFiniteNumber(probe.prevMinIntervalMs)
    || probe.prevMinIntervalMs !== rule.minIntervalMs) return false;
  const { startedAt, until, actionStartedAt, cleanObservedAt } = probe;
  if (!isFiniteNumber(startedAt) || !isFiniteNumber(until)) return false;
  const windowMs = until - startedAt;
  if (windowMs < K.minProbeWindowMs || windowMs > K.maxProbeWindowMs) return false;
  if (startedAt < createdAt || startedAt > updatedAt) return false;
  if (actionStartedAt !== null
    && (!isFiniteNumber(actionStartedAt)
      || actionStartedAt < startedAt
      || actionStartedAt >= until
      || actionStartedAt > updatedAt)) return false;
  if (cleanObservedAt !== null
    && (actionStartedAt === null
      || !isFiniteNumber(cleanObservedAt)
      || cleanObservedAt < actionStartedAt
      || cleanObservedAt !== updatedAt)) return false;
  return true;
};

/**
 * The default state of an origin: known, but costing nothing. Callers mint this
 * lazily on the first signal for an origin — a rule that never leaves
 * `minIntervalMs: 0` is indistinguishable from having no rule at all.
 *
 * @param {string} origin @param {number} now @param {PaceTunables} [K]
 * @returns {PaceRule}
 */
export const newRule = (origin, now, K = PACE_TUNABLES) => ({
  version: PACE_RULE_VERSION,
  origin,
  minIntervalMs: 0,
  jitterFrac: K.jitterFrac,
  observations: 0,
  lastBlockAt: 0,
  lastDecayAt: now,
  createdAt: now,
  updatedAt: now,
  lastEscalationSource: 'learned',
  probe: null,
});

/**
 * A block was observed -> escalate. Sized from the speed that ACTUALLY got
 * blocked (times a slowdown multiplier) rather than a blind constant, so a first
 * block lands near the right cadence in one step instead of ramping through
 * many. An explicit server ask (Retry-After) always wins if it is larger — that
 * is the site telling us its own number, and honoring it is the whole compliance
 * story.
 *
 * @param {PaceRule} rule
 * @param {{ recentIntervalMs?: number, retryAfterMs?: number, now: number }} signal
 *   recentIntervalMs: our observed gap between recent actions on this origin.
 * @param {PaceTunables} [K]
 * @returns {PaceRule}
 */
export const nextRuleOnBlock = (rule, { recentIntervalMs, retryAfterMs, now }, K = PACE_TUNABLES) => {
  if (!isValidRule(rule, undefined, K) || !Number.isFinite(now)) return rule;
  const effectiveNow = Math.max(now, rule.createdAt, rule.updatedAt, rule.lastBlockAt, rule.lastDecayAt);
  const fromCadence = Number.isFinite(recentIntervalMs) && /** @type {number} */ (recentIntervalMs) >= 0
    ? /** @type {number} */ (recentIntervalMs) * K.slowdownMult
    : 0;
  const fromServer = Number.isFinite(retryAfterMs) && /** @type {number} */ (retryAfterMs) >= 0
    ? /** @type {number} */ (retryAfterMs)
    : 0;
  const fromExisting = rule.minIntervalMs * K.growth;
  const desired = Math.max(
    fromExisting,                    // compounding: repeats mean we are still too fast
    fromCadence,
    fromServer,
    K.seedMs,                        // a block always yields SOME rule
  );
  return {
    ...rule,
    minIntervalMs: clamp(desired, 0, K.maxPaceMs),
    observations: rule.observations + 1,
    lastBlockAt: effectiveNow,
    updatedAt: effectiveNow,
    // A block during a probe is the probe's answer; resolveProbe() owns that
    // transition, so a bare block here just drops the trial.
    probe: null,
    // Attribute the VALUE that won, not merely the presence of a header. A
    // smaller Retry-After did not set this rule and must not get credit for it.
    lastEscalationSource: fromServer > 0 && fromServer >= Math.max(fromExisting, fromCadence, K.seedMs)
      ? 'retry-after'
      : 'learned',
  };
};

/**
 * Block-free time relaxes the rule toward zero, so a one-off block during a
 * burst does not tax an origin forever. LAZY + multi-period by design (spec
 * open question C): callers recompute on next access rather than running a
 * timer, so a rule untouched for five quiet periods must decay five steps at
 * once — not one. Never decays mid-probe (the probe owns the value).
 *
 * @param {PaceRule} rule @param {number} now @param {PaceTunables} [K]
 * @returns {PaceRule}
 */
export const decay = (rule, now, K = PACE_TUNABLES) => {
  if (!isValidRule(rule, undefined, K)) return rule;
  if (rule.probe) return rule;
  if (rule.minIntervalMs <= 0) return rule;
  const since = now - Math.max(rule.lastBlockAt, rule.lastDecayAt);
  if (!Number.isFinite(since) || since < 0) return rule;   // clock skew — never relax on a bad clock
  const periods = Math.floor(since / K.quietMs);
  if (periods < 1) return rule;
  return {
    ...rule,
    minIntervalMs: rule.minIntervalMs * (K.decay ** periods),
    lastDecayAt: now,
    updatedAt: now,
  };
};

/**
 * Decayed into irrelevance — the caller deletes the record. Keeping a rule at
 * a sub-floor interval would be a permanent row for a site that stopped caring.
 *
 * @param {PaceRule} rule @param {PaceTunables} [K]
 */
export const isRetired = (rule, K = PACE_TUNABLES) =>
  isValidRule(rule, undefined, K)
  && !rule.probe
  && rule.minIntervalMs < K.retireFloorMs
  && rule.observations > 0;

/**
 * The site wants us slower than pacing is willing to go. Not a nap — the caller
 * escalates to the posture ladder (challenge hand-back, or assist-only for this
 * origin). Pacing shaves seconds; it does not stall a turn for minutes.
 *
 * @param {PaceRule} rule @param {PaceTunables} [K]
 */
export const needsHandOff = (rule, K = PACE_TUNABLES) =>
  !isValidRule(rule, undefined, K) || rule.minIntervalMs >= K.maxPaceMs;

/**
 * The per-action delay: a CATCH-UP, not a fixed tax. The first action on an
 * origin (no prior timestamp) is always free, and an action that naturally
 * followed a slow read waits little or nothing — we only ever make up the
 * shortfall. Jitter de-regularizes the tempo (a metronome is its own tell).
 * While probing, the trial interval is the one enforced.
 *
 * @param {PaceRule | null | undefined} rule
 * @param {number | undefined} lastActionAt   epoch ms of the previous paced action on this origin
 * @param {number} now
 * @param {() => number} [rng]                [0,1) source; injected for tests
 * @param {PaceTunables} [K]
 * @returns {number | null} ms to sleep, or null when the rule cannot authorize an action
 */
export const waitForAction = (rule, lastActionAt, now, rng = Math.random, K = PACE_TUNABLES) => {
  if (!rule) return 0;
  if (!isValidRule(rule, undefined, K)) return null;
  if (needsHandOff(rule, K)) return null;
  if (rule.probe && !probeAllowsAction(rule, now, K)) return null;
  if (lastActionAt === undefined) return rule.probe ? null : 0;
  if (!Number.isFinite(lastActionAt) || lastActionAt < 0) return null;
  const base = rule.probe ? rule.probe.trialMs : rule.minIntervalMs;
  if (!(base > 0)) return 0;
  const elapsed = now - /** @type {number} */ (lastActionAt);
  // A backwards or broken wall clock is not evidence that the interval elapsed.
  // Require the full base rather than turning clock skew into a pacing bypass.
  if (!Number.isFinite(elapsed) || elapsed < 0) return Math.min(base, K.maxPaceMs);
  const rawRandom = rng();
  const random = Number.isFinite(rawRandom) ? clamp(rawRandom, 0, 1) : 0.5;
  const jitterFrac = rule.jitterFrac;
  const jitter = base * jitterFrac * (random * 2 - 1);         // ± jitterFrac
  // The ceiling governs the ACTUAL wait, not only the pre-jitter interval.
  return clamp((base + jitter) - elapsed, 0, K.maxPaceMs);
};

/**
 * Start a staleness test: drop to a trial interval for a bounded window and see
 * whether the site still minds. This is the ONLY way a rule comes down other
 * than automatic decay — and it is safe precisely because it is reversible:
 * resolveProbe() restores prevMinIntervalMs and re-escalates on a block.
 *
 * The trial is clamped to at most the current interval — a "probe" that made us
 * SLOWER would be a contradiction, and one that could set any value would be
 * the very lever this design denies the agent.
 *
 * @param {PaceRule} rule @param {number} trialMs @param {number} windowMs @param {number} now
 * @returns {PaceRule}
 */
export const startProbe = (rule, trialMs, windowMs, now, K = PACE_TUNABLES) => {
  if (!isValidRule(rule, undefined, K)) return rule;
  if (rule.probe) return rule;              // already probing — don't restart the window
  if (rule.minIntervalMs <= 0) return rule; // nothing to probe
  if (!Number.isFinite(trialMs) || trialMs < 0) return rule;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return rule;
  if (!Number.isFinite(now) || now < rule.updatedAt) return rule;
  const boundedWindow = clamp(windowMs, K.minProbeWindowMs, K.maxProbeWindowMs);
  return {
    ...rule,
    probe: {
      trialMs: clamp(trialMs, 0, rule.minIntervalMs),
      startedAt: now,
      until: now + boundedWindow,
      prevMinIntervalMs: rule.minIntervalMs,
      actionStartedAt: null,
      cleanObservedAt: null,
    },
    updatedAt: now,
  };
};

/** The probe window has run out; the caller resolves it. @param {PaceRule} rule @param {number} now */
export const probeExpired = (rule, now, K = PACE_TUNABLES) =>
  isValidRule(rule, undefined, K) && Number.isFinite(now) && !!rule.probe && now >= rule.probe.until;

/**
 * A probe authorizes exactly one action. The future controller must reserve it
 * immediately before dispatch so a second call cannot run at the trial pace.
 *
 * @param {PaceRule} rule @param {number} now
 * @param {PaceTunables} [K]
 * @returns {boolean}
 */
export const probeAllowsAction = (rule, now, K = PACE_TUNABLES) =>
  isValidRule(rule, undefined, K)
  && !!rule.probe
  && Number.isFinite(now)
  && now >= rule.probe.startedAt
  && now < rule.probe.until
  && rule.probe.actionStartedAt === null;

/**
 * @param {PaceRule} rule @param {number | undefined} lastActionAt
 * @param {number} now @param {PaceTunables} [K]
 * @returns {PaceRule}
 */
export const beginProbeAction = (rule, lastActionAt, now, K = PACE_TUNABLES) => {
  if (!Number.isFinite(lastActionAt)
    || /** @type {number} */ (lastActionAt) < 0
    || !probeAllowsAction(rule, now, K)
    || !rule.probe) return rule;
  return {
    ...rule,
    probe: { ...rule.probe, actionStartedAt: now },
    updatedAt: now,
  };
};

/**
 * Record a completed non-blocking outcome from the trusted post-action
 * classifier. The action may finish after the probe window, but it must be the
 * single action reserved inside that window.
 *
 * @param {PaceRule} rule @param {number} actionStartedAt @param {number} observedAt
 * @param {PaceTunables} [K]
 * @returns {PaceRule}
 */
export const noteCleanProbeAction = (rule, actionStartedAt, observedAt, K = PACE_TUNABLES) => {
  if (!isValidRule(rule, undefined, K) || !rule.probe) return rule;
  if (!Number.isFinite(actionStartedAt)
    || !Number.isFinite(observedAt)
    || rule.probe.cleanObservedAt !== null
    || rule.probe.actionStartedAt !== actionStartedAt
    || observedAt < actionStartedAt) return rule;
  return {
    ...rule,
    probe: { ...rule.probe, cleanObservedAt: observedAt },
    updatedAt: observedAt,
  };
};

/**
 * End a probe. Blocked during the trial -> the site still cares: restore the
 * previous interval, re-escalate from the trial cadence that just got blocked,
 * and reset the quiet timer (so decay does not immediately undo the lesson).
 * Clean -> adopt the lower trial value; if that is under the retire floor the
 * rule is now retirable and the caller drops it entirely.
 *
 * @param {PaceRule} rule @param {'clean'|'blocked'|'inconclusive'} outcome
 * @param {number} now @param {PaceTunables} [K]
 * @returns {PaceRule}
 */
export const resolveProbe = (rule, outcome, now, K = PACE_TUNABLES) => {
  if (!isValidRule(rule, undefined, K) || !rule.probe || !Number.isFinite(now)) return rule;
  const { trialMs, prevMinIntervalMs, startedAt, actionStartedAt, cleanObservedAt } = rule.probe;
  if (now < startedAt) return rule;
  if (outcome === 'blocked') {
    if (actionStartedAt === null || now < actionStartedAt) return rule;
    const restored = { ...rule, minIntervalMs: prevMinIntervalMs, probe: null };
    return nextRuleOnBlock(restored, { recentIntervalMs: trialMs, now }, K);
  }
  if (outcome === 'inconclusive') {
    if (now < rule.updatedAt || (actionStartedAt !== null && now < actionStartedAt)) return rule;
    return { ...rule, minIntervalMs: prevMinIntervalMs, probe: null, updatedAt: now };
  }
  if (outcome !== 'clean' || actionStartedAt === null || cleanObservedAt === null) return rule;
  // A quiet timer is not a test. Adopt only after the one authorized action
  // completed cleanly and a bounded post-result settle period also stayed clean.
  const readyAt = Math.max(rule.probe.until, cleanObservedAt + K.probeSettleMs);
  if (now < readyAt) return rule;
  return { ...rule, minIntervalMs: trialMs, probe: null, lastDecayAt: now, updatedAt: now };
};
