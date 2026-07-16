// @ts-check
// web-pace/reducer.js — the PURE policy core of adaptive per-origin action
// pacing. Design spec: docs/store/ADAPTIVE-PACING.md (PR #213), which resolves
// ANTI-BOT-POSTURE.md Option 0 as "code, not prompt; learned, not a hardcoded
// list; targeted, not blanket".
//
// THE SHAPE. peerd paces NOTHING by default (minIntervalMs 0 everywhere). When
// a site pushes back in its own response bytes (a 429 + Retry-After, a velocity
// wall, a challenge interstitial), the observing hook feeds that signal through
// nextRuleOnBlock and persists the result: a NUMBER for that origin, sized from
// the cadence that actually got blocked. Quiet time decays it back toward zero;
// a probe tests whether the site still cares. The whole loop is
// observe -> learn -> enforce -> decay/probe.
//
// why a pure core: every transition here is a function of (rule, signal, now).
// No storage, no clock, no Math.random — the caller injects them. That makes the
// policy deterministic under Bun (see web-pace-reducer.test.ts) and keeps the
// enforcement/observation hooks as thin imperative shells, per the module's
// functional-core rule.
//
// THE FENCE (why this file holds no strings). The rule is data the RUNTIME
// interprets, never prose the model reads. It is computed and stored SW-side,
// behind the actor-heap fence: the offscreen worker never holds it and the
// model never receives it as prompt. An untrusted reasoning heap therefore
// cannot argue peerd out of pacing — there is no sentence to argue with.
//
// THE DESCENT RULE (the load-bearing safety property). Pacing may be raised by
// anyone, but it may only ever come DOWN two ways: automatic time-based decay,
// or a bounded probe that snaps back on a block. There is deliberately NO
// clearRule() and applyAgentSet() is RAISE-ONLY. why: raising is self-limiting
// (worst case peerd is slow on one origin), but LOWERING is the direction an
// injected page benefits from — talk the web actor into retiring the rule, peerd
// hammers the site, and it is the user's own logged-in account that eats the
// ban. An SW-side re-check of a "clear" call can validate its args but never its
// INTENT — it cannot tell "the actor judged this stale" from "a page talked the
// actor into it". So the descent is not a decision the actor is allowed to make;
// probe() is the safe expression of the same wish, because a block during the
// trial window restores the old value and re-escalates.

import { clamp } from '/shared/util.js';

/**
 * One learned rule for one origin. The FIELD SET is the contract (the numbers
 * are seeds, below); `minIntervalMs: 0` means "no rule" — the default state of
 * every origin peerd has never been blocked by.
 *
 * @typedef {Object} PaceRule
 * @property {string} origin                 the key this rule binds to
 * @property {number} minIntervalMs          enforced gap between action tools; 0 == no rule
 * @property {number} jitterFrac             ± fraction applied to the gap (a UNIFORM gap is itself a tell)
 * @property {number} observations           how many blocks have fed this rule
 * @property {number} lastBlockAt            epoch ms of the last observed block; drives decay eligibility
 * @property {number} lastDecayAt            epoch ms of the last decay/adopt
 * @property {number} createdAt              epoch ms
 * @property {number} updatedAt              epoch ms
 * @property {'learned'|'retry-after'|'agent'} source  provenance of the current value
 * @property {null | { trialMs: number, until: number, prevMinIntervalMs: number }} probe
 *   a live staleness test: pace at trialMs until `until`, restoring
 *   prevMinIntervalMs if the site blocks us during the window.
 */

/**
 * The tunables bundle (`K`). Seeds, not doctrine — start conservative and tune
 * from the eval harness + field reports (spec open question F). Injected into
 * every reducer so a test can pin exact arithmetic.
 *
 * @typedef {Object} PaceTunables
 * @property {number} growth         multiplier on a REPEAT block (compounding escalation)
 * @property {number} slowdownMult   "we were going at X and got blocked -> go slowdownMult * X"
 * @property {number} seedMs         floor for a FIRST block when no cadence sample exists
 * @property {number} decay          multiplier applied per elapsed quiet period (< 1)
 * @property {number} quietMs        block-free time that earns one decay step
 * @property {number} maxPaceMs      ceiling; at/over it the limiter HANDS OFF rather than napping
 * @property {number} jitterFrac     default ± fraction for a new rule
 * @property {number} retireFloorMs  decayed below this, the rule is retired (deleted)
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
  // minutes slower is not a pacing problem — needsHandOff() sends it up the
  // posture ladder (challenge hand-back / assist-only) instead of silently
  // sleeping a turn.
  maxPaceMs: 30_000,
  jitterFrac: 0.3,
  retireFloorMs: 250,
});

/**
 * The default state of an origin: known, but costing nothing. Callers mint this
 * lazily on the first signal for an origin — a rule that never leaves
 * `minIntervalMs: 0` is indistinguishable from having no rule at all.
 *
 * @param {string} origin @param {number} now @param {PaceTunables} [K]
 * @returns {PaceRule}
 */
export const newRule = (origin, now, K = PACE_TUNABLES) => ({
  origin,
  minIntervalMs: 0,
  jitterFrac: K.jitterFrac,
  observations: 0,
  lastBlockAt: 0,
  lastDecayAt: now,
  createdAt: now,
  updatedAt: now,
  source: 'learned',
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
  const fromCadence = Number.isFinite(recentIntervalMs)
    ? /** @type {number} */ (recentIntervalMs) * K.slowdownMult
    : 0;
  const fromServer = Number.isFinite(retryAfterMs) ? /** @type {number} */ (retryAfterMs) : 0;
  const desired = Math.max(
    rule.minIntervalMs * K.growth,   // compounding: repeats mean we are still too fast
    fromCadence,
    fromServer,
    K.seedMs,                        // a block always yields SOME rule
  );
  return {
    ...rule,
    minIntervalMs: clamp(desired, 0, K.maxPaceMs),
    observations: rule.observations + 1,
    lastBlockAt: now,
    updatedAt: now,
    // A block during a probe is the probe's answer; resolveProbe() owns that
    // transition, so a bare block here just drops the trial.
    probe: null,
    source: fromServer > 0 ? 'retry-after' : 'learned',
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
  !rule.probe && rule.minIntervalMs < K.retireFloorMs;

/**
 * The site wants us slower than pacing is willing to go. Not a nap — the caller
 * escalates to the posture ladder (challenge hand-back, or assist-only for this
 * origin). Pacing shaves seconds; it does not stall a turn for minutes.
 *
 * @param {PaceRule} rule @param {PaceTunables} [K]
 */
export const needsHandOff = (rule, K = PACE_TUNABLES) => rule.minIntervalMs >= K.maxPaceMs;

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
 * @returns {number} ms to sleep (>= 0)
 */
export const waitForAction = (rule, lastActionAt, now, rng = Math.random) => {
  if (!rule) return 0;
  const base = rule.probe ? rule.probe.trialMs : rule.minIntervalMs;
  if (!(base > 0)) return 0;                                  // no rule (or a zero trial) — full speed
  if (!Number.isFinite(lastActionAt)) return 0;               // first action on this origin is free
  const elapsed = now - /** @type {number} */ (lastActionAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;     // clock skew — never stall
  const jitter = base * rule.jitterFrac * (rng() * 2 - 1);    // ± jitterFrac
  return Math.max(0, (base + jitter) - elapsed);
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
export const startProbe = (rule, trialMs, windowMs, now) => {
  if (rule.probe) return rule;              // already probing — don't restart the window
  if (rule.minIntervalMs <= 0) return rule; // nothing to probe
  return {
    ...rule,
    probe: {
      trialMs: clamp(trialMs, 0, rule.minIntervalMs),
      until: now + windowMs,
      prevMinIntervalMs: rule.minIntervalMs,
    },
    updatedAt: now,
  };
};

/** The probe window has run out; the caller resolves it. @param {PaceRule} rule @param {number} now */
export const probeExpired = (rule, now) => !!rule.probe && now >= rule.probe.until;

/**
 * End a probe. Blocked during the trial -> the site still cares: restore the
 * previous interval, re-escalate from the trial cadence that just got blocked,
 * and reset the quiet timer (so decay does not immediately undo the lesson).
 * Clean -> adopt the lower trial value; if that is under the retire floor the
 * rule is now retirable and the caller drops it entirely.
 *
 * @param {PaceRule} rule @param {boolean} blockedDuringProbe @param {number} now @param {PaceTunables} [K]
 * @returns {PaceRule}
 */
export const resolveProbe = (rule, blockedDuringProbe, now, K = PACE_TUNABLES) => {
  if (!rule.probe) return rule;
  const { trialMs, prevMinIntervalMs } = rule.probe;
  if (blockedDuringProbe) {
    const restored = { ...rule, minIntervalMs: prevMinIntervalMs, probe: null };
    return nextRuleOnBlock(restored, { recentIntervalMs: trialMs, now }, K);
  }
  return { ...rule, minIntervalMs: trialMs, probe: null, lastDecayAt: now, updatedAt: now };
};

/**
 * The agent's only write into the rule: RAISE-ONLY, and clamped.
 *
 * why not a symmetric set(): see THE DESCENT RULE in the module header. A
 * request to go SLOWER is always safe to honor — the agent has a real signal
 * (a Retry-After it read, or the user saying "take it easy on this one") and
 * the worst case is a slow origin. A request to go FASTER is refused outright,
 * because that is the outcome an injected page wants and no downstream check
 * can distinguish a genuine judgement from a laundered instruction. An agent
 * that believes a rule is stale asks for a probe instead.
 *
 * @param {PaceRule} rule @param {number} requestedMs @param {number} now @param {PaceTunables} [K]
 * @returns {PaceRule} the rule unchanged when the request would lower it
 */
export const applyAgentSet = (rule, requestedMs, now, K = PACE_TUNABLES) => {
  if (!Number.isFinite(requestedMs)) return rule;
  const requested = clamp(requestedMs, 0, K.maxPaceMs);
  if (requested <= rule.minIntervalMs) return rule;   // refuse to lower — probe is the way down
  return { ...rule, minIntervalMs: requested, source: 'agent', updatedAt: now };
};
