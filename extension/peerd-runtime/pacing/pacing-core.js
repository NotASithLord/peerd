// @ts-check
// pacing/pacing-core.js - the PURE policy core of adaptive per-origin action
// pacing. Issue #234 is the decision record; PR #218 is the closed first draft.
//
// THE POSTURE, stated once so no other comment has to hedge: peerd paces itself
// to RESPECT a site's stated limits. It is not disguising automation. Nothing
// here exists to make peerd look more human, which is why there is no tempo
// de-regularization: a uniform cadence is not a problem to be solved, and the
// one sanctioned adjustment (the clock-skew guard below) can only ever make
// peerd wait LONGER.
//
// TWO BRAKES per origin, both minted only by a trusted observer holding a real
// Response:
//   notBeforeMs    an ABSOLUTE epoch deadline the server named. Gates every
//                  request, read or write. Survives restarts because it is a
//                  point in time, not an interval.
//   minIntervalMs  a learned floor between WRITE actions, measured from the
//                  last committed action. Writes only - issue #234 decided
//                  that, because pacing reads would serialize the concurrent
//                  read waves the turn driver deliberately allows.
//
// THE DEFECT THIS FILE EXISTS TO NOT REPEAT (why #218 was closed). The first
// draft stored Retry-After as an interval and measured it from the PRIOR
// ACTION. An action at t=0, a 429 at t=5s and `Retry-After: 9` then permitted
// the next action at t=9s - four seconds inside the window the server asked
// for, and earlier still once negative jitter applied. Both halves are fixed
// here and pinned by tests: the deadline is absolute and anchored to the
// RESPONSE, and no adjustment may move an action earlier than a deadline a
// server named.
//
// THE DESCENT RULE (load-bearing). A rule rises only from trusted block
// signals. It comes down only through time decay or an explicit human forget on
// the settings page. There is deliberately no clearRule() and no model-facing
// setter: LOWERING is the direction an injected page benefits from - retire the
// rule, peerd hammers the site, and the user's logged-in account absorbs the
// consequences. An argument check cannot validate intent, so the lever does not
// exist.
//
// why a pure core: every transition is a function of (rule, signal, now) with
// storage and the clock injected, so the arithmetic is testable under Bun with
// a fake clock. The controller (background/origin-pacing-store.js) is the
// imperative shell that owns the kv blob, the per-origin lane and the sleep.

import { clamp } from '/shared/util.js';

/**
 * One learned rule for one canonical origin. The FIELD SET is the contract;
 * the numbers in PACE_TUNABLES are seeds to tune from field reports.
 *
 * @typedef {Object} PaceRule
 * @property {1} version              persisted shape version
 * @property {string} origin          canonical origin this rule binds to
 * @property {number} notBeforeMs     ABSOLUTE epoch ms before which nothing may
 *                                    be sent to this origin; 0 = none live
 * @property {'retry-after-seconds' | 'retry-after-date' | 'status-backoff' | 'none'} notBeforeSource
 *                                    which observation produced notBeforeMs
 * @property {number} minIntervalMs   learned floor between write actions; 0 = none
 * @property {number} lastActionMs    epoch ms of the last committed paced action
 * @property {number} strikes         consecutive blocks; drives escalation
 * @property {number} observations    total blocks ever fed into this rule
 * @property {number} lastBlockAt     epoch ms of the last observed block
 * @property {number} lastDecayAt     epoch ms of the last decay step
 * @property {number} createdAt       epoch ms
 * @property {number} updatedAt       epoch ms
 * @property {number} seq             monotone; a lower seq never overwrites a higher one
 */

/**
 * @typedef {Object} PaceTunables
 * @property {number} seedMs         floor for a FIRST block with no cadence sample
 * @property {number} growth         multiplier on a REPEAT block
 * @property {number} slowdownMult   "we were going at X and got blocked -> X * this"
 * @property {number} decay          multiplier per elapsed quiet period (< 1)
 * @property {number} quietMs        block-free time that earns one decay step
 * @property {number} retireFloorMs  decayed under this with no live deadline, the
 *                                   rule is retired and the record deleted
 * @property {number} maxIntervalMs  ceiling on the LEARNED floor
 * @property {number} maxInlineWaitMs longest peerd will sleep inline; past it the
 *                                   caller hands off instead of napping
 * @property {number} statusBackoffMs deadline granted by a bare 429/503 with no
 *                                   usable Retry-After
 * @property {number} maxDeadlineMs  ceiling on how far ahead a server deadline may
 *                                   be honored as a live rule
 * @property {number} skewGuardMs    positive-only margin added to a SERVER-stated
 *                                   deadline to cover clock skew
 */

/** @type {PaceTunables} */
export const PACE_TUNABLES = Object.freeze({
  // why a seed: a block is evidence even with no cadence sample to size from
  // (a fresh service-worker generation lost lastActionMs, or the block landed
  // on the very first request). Without a floor, max() over unknowns is 0 and
  // a real block would teach nothing.
  seedMs: 1_000,
  growth: 2,
  slowdownMult: 2,
  decay: 0.5,
  quietMs: 30 * 60_000,
  retireFloorMs: 250,
  maxIntervalMs: 30_000,
  // why an inline ceiling at all: pacing is for shaving seconds off a cadence.
  // A site that wants peerd minutes slower is not a pacing problem, it is a
  // "come back later" problem, and silently sleeping a turn hides that from the
  // user. Past this the caller returns the terminal handoff instead.
  maxInlineWaitMs: 30_000,
  statusBackoffMs: 5_000,
  // why cap a server deadline: `Retry-After: 86400` is a legal answer, and a
  // day-long live rule held in a kv blob is indistinguishable from a permanent
  // ban peerd never tells anyone about. Past the cap the deadline is clamped;
  // the origin still lands in the ceiling handoff, which is visible.
  maxDeadlineMs: 24 * 60 * 60_000,
  // why positive-only, and why it exists at all: peerd's clock and the server's
  // may differ by a few hundred ms, so firing at exactly the stated instant can
  // land marginally inside the window. This margin can only DELAY. It is not
  // tempo variation - it is a fixed constant, and the same posture as the
  // provider adapters' existing positive-only retry margin.
  skewGuardMs: 250,
});

export const PACE_RULE_VERSION = 1;

/** Statuses that mean "you are going too fast" or "not now". */
export const BLOCKING_STATUSES = Object.freeze([429, 503]);

/** @param {unknown} value @returns {value is number} */
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** @param {unknown} value @returns {value is number} */
const isEpochMs = (value) => isFiniteNumber(value) && value >= 0 && value <= 8.64e15;

/**
 * Is this status one peerd should slow down for?
 *
 * why 403 is NOT in the list: it is the ordinary answer for "you are not
 * allowed to do that", and treating every permission error as a rate signal
 * would teach a pacing rule from a missing scope. A 403 is only a pacing signal
 * when it arrives WITH a Retry-After, which the observation path handles by the
 * header rather than by the status.
 *
 * @param {unknown} status
 */
export const isBlockingStatus = (status) =>
  typeof status === 'number' && BLOCKING_STATUSES.includes(status);

/**
 * Does this response say "you are going too fast" or "not now"?
 *
 * The Retry-After header alone is NOT enough. It is legal and common on a 200
 * or 202 as polling guidance - "the job is not done, ask again in 5s" - and
 * reading that as a rate limit would slow peerd down on every ordinary
 * long-poll API. So the header only counts alongside an ERROR status, where it
 * genuinely means "come back later".
 *
 * @param {unknown} status
 * @param {unknown} retryAfter  the raw Retry-After header value
 */
export const isRateLimitSignal = (status, retryAfter) => {
  if (isBlockingStatus(status)) return true;
  if (typeof status !== 'number' || status < 400) return false;
  return typeof retryAfter === 'string' && retryAfter.trim() !== '';
};

/**
 * Parse an RFC 9110 Retry-After into an ABSOLUTE deadline.
 *
 * Both legal forms are handled. `delta-seconds` is relative to the response, so
 * it is anchored to `responseAtMs` - never to now, and never to a prior action.
 * `HTTP-date` is already absolute. A malformed value yields null and the caller
 * falls back to the status-derived backoff rather than to zero.
 *
 * why not reuse the provider adapters' parser: theirs is `Number(retryAfter)`
 * only, so an HTTP-date (legal, and common on 503) silently becomes NaN there.
 * That is tolerable for a provider retry and is not tolerable here, where the
 * value is the compliance promise itself.
 *
 * @param {unknown} headerValue     the raw Retry-After header
 * @param {number} responseAtMs     epoch ms the response was observed
 * @returns {{ deadlineMs: number, source: 'retry-after-seconds' | 'retry-after-date' } | null}
 */
export const parseRetryAfter = (headerValue, responseAtMs) => {
  if (typeof headerValue !== 'string' || !isEpochMs(responseAtMs)) return null;
  const raw = headerValue.trim();
  if (!raw) return null;
  // delta-seconds is a bare non-negative integer. Reject anything else here so
  // '3 hours' or '-1' falls through to the date branch and then to null instead
  // of being coerced.
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds)) return null;
    return {
      deadlineMs: responseAtMs + (seconds * 1000),
      source: 'retry-after-seconds',
    };
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  // A date already in the past asks for nothing; report it rather than
  // inventing a deadline, and let the status backoff decide.
  if (parsed <= responseAtMs) return null;
  return { deadlineMs: parsed, source: 'retry-after-date' };
};

/**
 * The default state of an origin: known, but costing nothing. Callers mint this
 * lazily on the first signal - a rule that never leaves zero on both brakes is
 * indistinguishable from having no rule at all, and is not persisted.
 *
 * @param {string} origin @param {number} now
 * @returns {PaceRule}
 */
export const newRule = (origin, now) => ({
  version: PACE_RULE_VERSION,
  origin,
  notBeforeMs: 0,
  notBeforeSource: 'none',
  minIntervalMs: 0,
  lastActionMs: 0,
  strikes: 0,
  observations: 0,
  lastBlockAt: 0,
  lastDecayAt: now,
  createdAt: now,
  updatedAt: now,
  seq: 0,
});

/**
 * Validate a record at the persistence boundary before any action consults it.
 * An unreadable rule must make a write path fail CLOSED, not turn pacing off -
 * so this is deliberately strict and the caller treats `false` as "refuse",
 * never as "no rule".
 *
 * @param {unknown} value
 * @param {string} [expectedOrigin]  guards a valid record replayed under another key
 * @param {PaceTunables} [K]
 * @returns {value is PaceRule}
 */
export const isValidRule = (value, expectedOrigin, K = PACE_TUNABLES) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = /** @type {Partial<PaceRule>} */ (value);
  if (rule.version !== PACE_RULE_VERSION) return false;
  if (typeof rule.origin !== 'string' || rule.origin.length === 0) return false;
  if (expectedOrigin !== undefined && rule.origin !== expectedOrigin) return false;
  if (!isEpochMs(rule.notBeforeMs)) return false;
  if (rule.notBeforeSource !== 'retry-after-seconds'
    && rule.notBeforeSource !== 'retry-after-date'
    && rule.notBeforeSource !== 'status-backoff'
    && rule.notBeforeSource !== 'none') return false;
  if (rule.notBeforeMs === 0 && rule.notBeforeSource !== 'none') return false;
  if (!isFiniteNumber(rule.minIntervalMs)
    || rule.minIntervalMs < 0
    || rule.minIntervalMs > K.maxIntervalMs) return false;
  if (!isEpochMs(rule.lastActionMs)) return false;
  if (!Number.isSafeInteger(rule.strikes) || /** @type {number} */ (rule.strikes) < 0) return false;
  if (!Number.isSafeInteger(rule.observations) || /** @type {number} */ (rule.observations) < 0) return false;
  if (!isEpochMs(rule.lastBlockAt) || !isEpochMs(rule.lastDecayAt)) return false;
  if (!isEpochMs(rule.createdAt) || !isEpochMs(rule.updatedAt)) return false;
  if (!Number.isSafeInteger(rule.seq) || /** @type {number} */ (rule.seq) < 0) return false;
  if (/** @type {number} */ (rule.updatedAt) < /** @type {number} */ (rule.createdAt)) return false;
  if (rule.observations === 0 && (rule.lastBlockAt !== 0 || rule.strikes !== 0)) return false;
  return true;
};

/**
 * A block was observed by a TRUSTED classifier - escalate.
 *
 * Keeping the two outputs independent is the point: `notBeforeMs` is what the
 * SERVER asked for, anchored to its response; `minIntervalMs` is what PEERD
 * infers about a safe cadence, sized from the speed that actually got blocked
 * so a first block lands near the right rate in one step rather than ramping.
 *
 * @param {PaceRule} rule
 * @param {Object} signal
 * @param {number} signal.responseAtMs   epoch ms the blocking response was seen
 * @param {number} [signal.status]       the HTTP status observed
 * @param {unknown} [signal.retryAfter]  the raw Retry-After header, if any
 * @param {number} [signal.recentIntervalMs] observed gap since the prior action
 * @param {PaceTunables} [K]
 * @returns {PaceRule}
 */
export const nextRuleOnBlock = (rule, signal, K = PACE_TUNABLES) => {
  if (!isValidRule(rule, undefined, K)) return rule;
  const { responseAtMs, status, retryAfter, recentIntervalMs } = signal ?? {};
  if (!isEpochMs(responseAtMs)) return rule;
  // Never let a stale-clock observation rewind the record's own timeline.
  const at = Math.max(responseAtMs, rule.updatedAt);

  const stated = parseRetryAfter(retryAfter, responseAtMs);
  const deadline = stated
    // why the guard rides HERE and only here: it covers the gap between the
    // server's clock and ours on a deadline the server named. A peerd-derived
    // backoff has no such gap to cover.
    ? clamp(stated.deadlineMs + K.skewGuardMs, at, at + K.maxDeadlineMs)
    : (isBlockingStatus(status) ? at + K.statusBackoffMs : 0);
  /** @type {PaceRule['notBeforeSource']} */
  const source = stated ? stated.source : (deadline > 0 ? 'status-backoff' : 'none');

  const fromCadence = isFiniteNumber(recentIntervalMs) && recentIntervalMs >= 0
    ? recentIntervalMs * K.slowdownMult
    : 0;
  const fromExisting = rule.minIntervalMs * K.growth;
  const learned = clamp(
    Math.max(fromExisting, fromCadence, K.seedMs),
    0,
    K.maxIntervalMs,
  );

  return {
    ...rule,
    // why max() rather than assignment: a second block while an earlier, longer
    // deadline is still live must not shorten it. Deadlines only move later.
    notBeforeMs: Math.max(rule.notBeforeMs, deadline),
    notBeforeSource: deadline >= rule.notBeforeMs && deadline > 0 ? source : rule.notBeforeSource,
    minIntervalMs: learned,
    strikes: rule.strikes + 1,
    observations: rule.observations + 1,
    lastBlockAt: at,
    updatedAt: at,
    seq: rule.seq + 1,
  };
};

/**
 * A clean, non-blocking result was observed. Clears the strike streak so the
 * NEXT block escalates from the learned floor rather than from a stale streak,
 * but deliberately does not lower `minIntervalMs`: descent is decay's job (and
 * the human's), never a single good answer's.
 *
 * @param {PaceRule} rule @param {number} now @param {PaceTunables} [K]
 * @returns {PaceRule}
 */
export const noteCleanResult = (rule, now, K = PACE_TUNABLES) => {
  if (!isValidRule(rule, undefined, K) || !isEpochMs(now)) return rule;
  if (rule.strikes === 0) return rule;
  const at = Math.max(now, rule.updatedAt);
  return { ...rule, strikes: 0, updatedAt: at, seq: rule.seq + 1 };
};

/**
 * Stamp a committed action. The interval brake measures from this, so it must
 * be written by the controller AFTER the action was actually authorized and
 * dispatched, never on a refusal.
 *
 * @param {PaceRule} rule @param {number} at @param {PaceTunables} [K]
 * @returns {PaceRule}
 */
export const noteActionAt = (rule, at, K = PACE_TUNABLES) => {
  if (!isValidRule(rule, undefined, K) || !isEpochMs(at)) return rule;
  if (at <= rule.lastActionMs) return rule;
  return { ...rule, lastActionMs: at, updatedAt: Math.max(at, rule.updatedAt), seq: rule.seq + 1 };
};

/**
 * Block-free time relaxes the LEARNED floor toward zero, so one bad burst does
 * not tax an origin forever. Lazy and multi-period by design: the caller
 * recomputes on next access instead of running a timer, so a rule untouched for
 * five quiet periods decays five steps at once, not one.
 *
 * Never touches `notBeforeMs`. A server deadline is not something quiet time
 * earns the right to ignore - it expires on its own, by being a point in time.
 *
 * @param {PaceRule} rule @param {number} now @param {PaceTunables} [K]
 * @returns {PaceRule}
 */
export const decayRule = (rule, now, K = PACE_TUNABLES) => {
  if (!isValidRule(rule, undefined, K) || !isEpochMs(now)) return rule;
  if (rule.minIntervalMs <= 0) return rule;
  const since = now - Math.max(rule.lastBlockAt, rule.lastDecayAt);
  // A backwards clock is not evidence that quiet time passed. Never relax on it.
  if (!Number.isFinite(since) || since < 0) return rule;
  const periods = Math.floor(since / K.quietMs);
  if (periods < 1) return rule;
  return {
    ...rule,
    minIntervalMs: rule.minIntervalMs * (K.decay ** periods),
    lastDecayAt: now,
    updatedAt: Math.max(now, rule.updatedAt),
    seq: rule.seq + 1,
  };
};

/**
 * Decayed into irrelevance AND carrying no live deadline - the caller deletes
 * the record. Keeping a sub-floor rule would be a permanent row for a site that
 * stopped caring, and every row is one the user may have to read.
 *
 * @param {PaceRule} rule @param {number} now @param {PaceTunables} [K]
 */
export const isRetired = (rule, now, K = PACE_TUNABLES) =>
  isValidRule(rule, undefined, K)
  && isEpochMs(now)
  && rule.observations > 0
  && rule.minIntervalMs < K.retireFloorMs
  && rule.notBeforeMs <= now;

/**
 * @typedef {{ action: 'go' }
 *   | { action: 'wait', waitMs: number, untilMs: number, reason: 'server-deadline' | 'learned-interval' }
 *   | { action: 'handoff', waitMs: number, untilMs: number, reason: 'server-deadline' | 'learned-interval' }
 * } PaceVerdict
 */

/**
 * THE decision. Given a rule and the clock, may this request go now, must it
 * wait, or is the required wait past what peerd will sleep inline?
 *
 * The returned wait is never shorter than the distance to a live deadline. The
 * only additive term anywhere in this file is the skew guard, already folded
 * into `notBeforeMs` at observation time, and it can only delay.
 *
 * @param {PaceRule | null | undefined} rule   null = no rule for this origin
 * @param {Object} at
 * @param {number} at.now
 * @param {boolean} at.isWrite
 * @param {number} [at.maxInlineWaitMs]  the CALLER's own wait budget, clamped to
 *   the tunable ceiling. why a parameter: a browser action is bounded only by
 *   the turn and shows a visible wait bar, while a network request sits inside a
 *   caller-owned fetch timeout it must not eat. The same rule therefore hands
 *   off sooner on the network path than on the action path.
 * @param {PaceTunables} [K]
 * @returns {PaceVerdict | null}  null = the rule is unreadable; the caller fails closed
 */
export const planRequest = (rule, { now, isWrite, maxInlineWaitMs }, K = PACE_TUNABLES) => {
  if (rule === null || rule === undefined) return { action: 'go' };
  if (!isValidRule(rule, undefined, K) || !isEpochMs(now)) return null;

  const deadlineWait = rule.notBeforeMs > now ? rule.notBeforeMs - now : 0;
  // A write with no prior action on record is free: the interval is a GAP
  // between actions, and there is nothing to be a gap from. The deadline still
  // applies, which is why it is computed above and independently.
  const intervalWait = (isWrite && rule.minIntervalMs > 0 && rule.lastActionMs > 0)
    ? Math.max(0, (rule.lastActionMs + rule.minIntervalMs) - now)
    : 0;

  const waitMs = Math.max(deadlineWait, intervalWait);
  if (waitMs <= 0) return { action: 'go' };
  const reason = deadlineWait >= intervalWait ? 'server-deadline' : 'learned-interval';
  const untilMs = now + waitMs;
  const budget = clamp(
    Number.isFinite(maxInlineWaitMs) ? /** @type {number} */ (maxInlineWaitMs) : K.maxInlineWaitMs,
    0,
    K.maxInlineWaitMs,
  );
  if (waitMs > budget) return { action: 'handoff', waitMs, untilMs, reason };
  return { action: 'wait', waitMs, untilMs, reason };
};
