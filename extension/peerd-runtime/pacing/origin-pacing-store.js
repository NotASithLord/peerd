// @ts-check
// The service-worker control plane for adaptive per-origin action pacing.
// Pure policy lives next door in pacing-core.js; this file is the imperative
// shell that owns the kv blob, the per-origin lane, and the sleep. Same split,
// and the same home, as actor/learned-origins.js: an in-memory read authority
// over injected persistence, with every mutator reachable only from settings.
//
// WHY IT LIVES IN THE SERVICE WORKER, and nowhere else. An actor runs in its own
// keyless Worker heap and reaches tools through a relay that rebuilds its
// context and never trusts the worker's arguments. If pacing state lived out
// there, "how fast may I act on this site" would be answerable by the same heap
// that just ingested the site's own content. So the store is SW-resident, it is
// reachable from a tool context only through two read-shaped closures, and every
// mutator is on a settings route the dispatcher structurally cannot address.
//
// TWO SERIALIZATION AXES, deliberately separate:
//
//   lanes        one FIFO per canonical origin, held THROUGH the wait. This is
//                what makes "concurrent sessions on one origin cannot pass the
//                limiter together" true: session B enters the lane only after
//                session A has waited and stamped, so B sizes its own wait from
//                A's action rather than racing it.
//   writeChain   one chain for kv persistence. The blob is a single key, so
//                per-origin write lanes would not buy concurrency - they would
//                just let two origins clobber each other's copy of the blob.
//
// why observations do NOT ride the action lane: a blocking response arriving
// while a reservation is asleep must reach the record immediately, or the
// sleeper re-plans against a deadline it should already have seen. Observations
// therefore mutate the in-memory map synchronously and persist behind the write
// chain. The in-memory map is the read authority within one service-worker
// generation; `seq` is what defends ordering ACROSS generations, since MV3 can
// evict the worker mid-flight and a resurrected one must not overwrite a newer
// record with an older one.
//
// FAIL-CLOSED, and the exact shape of it. Unlike learnedOrigins next door -
// which fails OPEN, because a missed entry only declines to ADD a protection -
// unreadable pacing state here means peerd cannot prove an action is outside a
// pause a site asked for. Browser WRITE actions refuse; reads continue. That
// asymmetry is issue #234's decision, not an accident.

import { createKeyedQueue } from '/peerd-engine/background.js';
import { abortableSleep } from '/shared/util.js';
import {
  PACE_TUNABLES, PACE_RULE_VERSION,
  decayRule, isRetired, isValidRule, newRule,
  nextRuleOnBlock, noteActionAt,
  planRequest, isRateLimitSignal,
} from './pacing-core.js';

/** @typedef {import('./pacing-core.js').PaceRule} PaceRule */

export const PACING_KEY = 'pacing.origins.v1';
export const PACING_SCHEMA = 1;

/**
 * How many origins peerd is willing to remember a rule for.
 *
 * why refusing beats evicting, and why the direction is INVERTED from the usual
 * cache argument: forgetting a pacing rule makes peerd act FASTER on a site that
 * already asked it to slow down. Eviction is the unsafe move here, so at the cap
 * a NEW origin is refused a rule while known origins keep updating. Reaching
 * this many separately rate-limited origins in one profile is an outlier, and
 * the refusal is logged rather than silent.
 */
export const DEFAULT_PACING_CAP = 1_000;

/**
 * Total inline wait a single reservation may accumulate across re-plans. The
 * per-decision ceiling is PACE_TUNABLES.maxInlineWaitMs; this bounds the case
 * where a concurrent observation extends the deadline while a reservation is
 * already asleep, so a reservation cannot be walked forward indefinitely.
 */
export const MAX_RESERVATION_WAIT_MS = 60_000;

/**
 * @param {unknown} raw
 * @returns {{ schema: number, entries: Record<string, PaceRule> } | null}
 *   null means CORRUPT - the caller refuses rather than resetting to empty.
 */
export const normalizePacingState = (raw) => {
  if (raw == null) return { schema: PACING_SCHEMA, entries: Object.create(null) };
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = /** @type {Record<string, any>} */ (raw);
  if (value.schema !== PACING_SCHEMA) return null;
  if (!value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) return null;
  /** @type {Record<string, PaceRule>} */
  const entries = Object.create(null);
  for (const [origin, entry] of Object.entries(value.entries)) {
    // The origin key must match the record's own origin: a valid rule replayed
    // under another key would apply one site's pause to a different site.
    if (!isValidRule(entry, origin)) return null;
    entries[origin] = /** @type {PaceRule} */ (entry);
  }
  return { schema: PACING_SCHEMA, entries };
};

/**
 * @typedef {Object} PacingClearance
 * @property {'go' | 'waited' | 'handoff' | 'unavailable'} outcome
 * @property {number} waitedMs   how long this reservation actually slept
 * @property {string} [origin]   the canonical origin the decision was keyed on
 * @property {'server-deadline' | 'learned-interval'} [reason]
 * @property {number} [untilMs]  for a handoff, when the origin frees up
 */

/**
 * @param {Object} deps
 * @param {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<any> }} deps.kv
 * @param {() => number} [deps.now]
 * @param {number} [deps.cap]
 * @param {typeof PACE_TUNABLES} [deps.tunables]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleep]
 * @param {(info: { origin: string, untilMs: number, waitMs: number, reason: string }) => void} [deps.onWait]
 *   default live-wait notice, used when the call site does not pass its own.
 *   why a default at all: the network path runs inside a tool's own fetch and
 *   has no per-call notice to thread, but a user staring at a stalled turn needs
 *   the same explanation whichever path is waiting.
 * @param {(event: { type: string, details?: Record<string, any> }) => void} [deps.onAudit]
 *   fired for every user-visible pacing event. The SW turns it into an audit
 *   entry. why the STORE owns this and not the routes: emitting from both
 *   double-records every removal and counts a bulk clear twice, which is the bug
 *   the learned-origins route header already warns about.
 */
export const createOriginPacingStore = ({
  kv,
  now = Date.now,
  cap = DEFAULT_PACING_CAP,
  tunables = PACE_TUNABLES,
  sleep = abortableSleep,
  onAudit,
  onWait: defaultOnWait,
}) => {
  const K = tunables;
  /** The read authority within this service-worker generation.
   * @type {Map<string, PaceRule>} */
  const rules = new Map();
  const lanes = createKeyedQueue();
  /** @type {Promise<void>} */
  let writeChain = Promise.resolve();
  let ready = false;
  let loadFailed = false;
  /** @type {Promise<void> | null} */
  let hydrating = null;
  let capRefusals = 0;

  /** @param {string} message @param {unknown} [error] */
  const report = (message, error) => {
    if (error) console.warn(`[pacing] ${message}`, error);
    else console.warn(`[pacing] ${message}`);
  };

  /** @param {{ type: string, details?: Record<string, any> }} event */
  const audit = (event) => {
    try { onAudit?.(event); }
    catch { /* best-effort: an audit failure must never change a pacing decision */ }
  };

  const runHydrate = async () => {
    try {
      const state = normalizePacingState(await kv.get(PACING_KEY));
      if (!state) {
        // Corrupt is NOT empty. Refusing to adopt it keeps browser writes
        // failing closed until a human clears the list, rather than quietly
        // handing every rate-limited site a clean slate.
        loadFailed = true;
        report('stored state is unreadable; browser writes fail closed until it is cleared');
        return;
      }
      for (const [origin, rule] of Object.entries(state.entries)) rules.set(origin, rule);
    } catch (e) {
      loadFailed = true;
      report('load failed; browser writes fail closed until the next boot', e);
    } finally {
      ready = true;
    }
  };

  /**
   * Idempotent and awaitable. The SW kicks this at boot without awaiting, but
   * any caller that must answer authoritatively - an enforcement decision, or a
   * settings list - has to wait for it. A pre-hydrate read would report an empty
   * rule set, which for this store means "act freely on a site that asked us not
   * to".
   * @returns {Promise<void>}
   */
  const hydrate = () => {
    if (ready) return Promise.resolve();
    if (!hydrating) hydrating = runHydrate();
    return hydrating;
  };

  const hydrationStatus = () => Object.freeze({ ready, ok: ready && !loadFailed });

  /**
   * Persist a synchronous snapshot so adjacent mutations cannot mix state.
   * @returns {Promise<void>}
   */
  const persist = () => {
    /** @type {Record<string, PaceRule>} */
    const entries = Object.create(null);
    for (const [origin, rule] of rules) entries[origin] = rule;
    const snapshot = { schema: PACING_SCHEMA, entries };
    const pending = writeChain.then(() => kv.set(PACING_KEY, snapshot)).then(() => undefined);
    writeChain = pending.catch((e) => {
      loadFailed = true;
      report('save failed; browser writes fail closed until the state is cleared', e);
    });
    return pending;
  };

  /**
   * Read a rule, applying lazy decay. Returns null when the origin has no rule,
   * which the planner reads as "no pacing".
   * @param {string} origin @param {number} at
   * @returns {PaceRule | null}
   */
  const currentRule = (origin, at) => {
    const stored = rules.get(origin);
    if (!stored) return null;
    const decayed = decayRule(stored, at, K);
    if (decayed !== stored) {
      if (isRetired(decayed, at, K)) {
        rules.delete(origin);
        persist();
        return null;
      }
      rules.set(origin, decayed);
      persist();
      return decayed;
    }
    if (isRetired(stored, at, K)) {
      rules.delete(origin);
      persist();
      return null;
    }
    return stored;
  };

  /**
   * Record a trusted observation about one origin. The ONLY way a rule is ever
   * created or escalated.
   *
   * why `responseAtMs` is a parameter and not read from the clock here: the
   * deadline a server states is anchored to ITS response, and this call can be
   * a tick or two later. Anchoring to the response is the whole fix for the
   * defect that closed PR #218.
   *
   * @param {Object} signal
   * @param {string} signal.origin        canonical origin (already normalized)
   * @param {number} signal.responseAtMs  epoch ms the response was observed
   * @param {number} [signal.status]
   * @param {unknown} [signal.retryAfter] raw Retry-After header value
   * @returns {Promise<void>}
   */
  const observe = async ({ origin, responseAtMs, status, retryAfter }) => {
    if (typeof origin !== 'string' || !origin) return;
    await hydrate();
    // Never learn into state we could not read. Persisting here would overwrite
    // the unreadable record with a partial one built from whatever this session
    // happened to see - destroying the evidence while writes still fail closed,
    // since loadFailed does not clear itself. The human "forget all" is the one
    // sanctioned way back to a readable record.
    if (loadFailed) return;
    // why a clean answer records nothing: escalation already compounds from the
    // rule's own current value, and decay is what walks it back down. A "we were
    // fine once" counter would be state nothing reads - and a write on every
    // successful request to a paced origin.
    if (!isRateLimitSignal(status, retryAfter)) return;
    const existing = rules.get(origin) ?? null;
    let base = existing;
    if (!base) {
      if (rules.size >= cap) {
        capRefusals += 1;
        report(`at the ${cap}-origin cap; not learning a rule for ${origin}`);
        return;
      }
      base = newRule(origin, responseAtMs);
    }
    const recentIntervalMs = base.lastActionMs > 0 && responseAtMs > base.lastActionMs
      ? responseAtMs - base.lastActionMs
      : undefined;
    const next = nextRuleOnBlock(base, { responseAtMs, status, retryAfter, recentIntervalMs }, K);
    if (next === base && existing) return;
    rules.set(origin, next);
    // Awaited: a server deadline is the compliance-critical half, and it has to
    // survive an eviction that lands one tick later.
    await persist();
    audit({
      type: 'origin_pacing_learned',
      details: {
        origin,
        reason: next.notBeforeSource,
        durationMs: Math.max(0, next.notBeforeMs - responseAtMs),
      },
    });
  };

  /**
   * The read-only pre-check. Synchronous once hydrated, so the dispatcher can
   * refuse at the ceiling before it burns a user confirmation on an action that
   * cannot run.
   *
   * @param {string | null} origin
   * @param {{ isWrite: boolean, maxInlineWaitMs?: number }} opts
   * @returns {PacingClearance}
   */
  const peek = (origin, { isWrite, maxInlineWaitMs }) => {
    if (!ready || loadFailed) {
      // Reads continue on unreadable state; writes do not. A read cannot make
      // peerd act inside a pause, it can only observe.
      return isWrite
        ? { outcome: 'unavailable', waitedMs: 0 }
        : { outcome: 'go', waitedMs: 0 };
    }
    if (!origin) return { outcome: 'go', waitedMs: 0 };
    const at = now();
    const verdict = planRequest(currentRule(origin, at), { now: at, isWrite, maxInlineWaitMs }, K);
    if (!verdict) return { outcome: 'unavailable', waitedMs: 0, origin };
    if (verdict.action === 'handoff') {
      return {
        outcome: 'handoff', waitedMs: 0, origin,
        reason: verdict.reason, untilMs: verdict.untilMs,
      };
    }
    return { outcome: 'go', waitedMs: 0, origin };
  };

  /**
   * Reserve the next action on `origin`, waiting if the site's limits require
   * it. Runs inside that origin's FIFO lane and HOLDS the lane through the
   * sleep - that is what makes the spacing real across concurrent sessions.
   *
   * The stamp lands at the end of the wait, before the caller runs its own
   * post-wait rechecks. So an action the caller then refuses still consumed an
   * interval slot. That is the safe direction (peerd waits longer than strictly
   * needed) and it keeps the lane from being held across an unbounded caller.
   *
   * @param {string | null} origin
   * @param {Object} opts
   * @param {boolean} opts.isWrite
   * @param {AbortSignal} [opts.signal]
   * @param {number} [opts.maxInlineWaitMs]  the caller's own wait budget
   * @param {(info: { origin: string, untilMs: number, waitMs: number, reason: string }) => void} [opts.onWait]
   *   fired once per sleep so the UI can show a live wait with a Stop control.
   * @returns {Promise<PacingClearance>}
   */
  const reserve = async (origin, { isWrite, signal, onWait, maxInlineWaitMs }) => {
    await hydrate();
    if (!ready || loadFailed) {
      return isWrite
        ? { outcome: 'unavailable', waitedMs: 0 }
        : { outcome: 'go', waitedMs: 0 };
    }
    if (!origin) return { outcome: 'go', waitedMs: 0 };
    return lanes.enqueue(origin, async () => {
      let waitedMs = 0;
      for (;;) {
        const at = now();
        const verdict = planRequest(currentRule(origin, at), { now: at, isWrite, maxInlineWaitMs }, K);
        if (!verdict) return { outcome: 'unavailable', waitedMs, origin };
        if (verdict.action === 'handoff') {
          return {
            outcome: 'handoff', waitedMs, origin,
            reason: verdict.reason, untilMs: verdict.untilMs,
          };
        }
        if (verdict.action === 'go') {
          const stamped = isWrite ? currentRule(origin, at) : null;
          if (stamped) {
            const next = noteActionAt(stamped, at, K);
            if (next !== stamped) { rules.set(origin, next); await persist(); }
          }
          return {
            outcome: waitedMs > 0 ? 'waited' : 'go',
            waitedMs,
            origin,
          };
        }
        // why re-plan rather than sleep once: an observation can extend the
        // deadline while this reservation is already asleep. Bounding the TOTAL
        // means a site cannot walk one reservation forward forever - past the
        // bound it becomes the visible handoff instead of an invisible nap.
        if (waitedMs + verdict.waitMs > MAX_RESERVATION_WAIT_MS) {
          return {
            outcome: 'handoff', waitedMs, origin,
            reason: verdict.reason, untilMs: verdict.untilMs,
          };
        }
        try {
          (onWait ?? defaultOnWait)?.({
            origin, untilMs: verdict.untilMs, waitMs: verdict.waitMs, reason: verdict.reason,
          });
        } catch { /* a UI notice must never change the decision */ }
        await sleep(verdict.waitMs, signal);
        waitedMs += verdict.waitMs;
      }
    });
  };

  /**
   * The human-facing list. Shaped here rather than in the route so the route
   * stays a transport and the numbers cannot drift between surfaces.
   * @returns {Promise<Array<{ origin: string, minIntervalMs: number, notBeforeMs: number,
   *   notBeforeSource: string, observations: number, lastBlockAt: number }>>}
   */
  const list = async () => {
    await hydrate();
    const at = now();
    return [...rules.keys()]
      .map((origin) => currentRule(origin, at))
      .filter(/** @returns {rule is PaceRule} */ (rule) => rule !== null)
      .map((rule) => ({
        origin: rule.origin,
        minIntervalMs: Math.round(rule.minIntervalMs),
        notBeforeMs: rule.notBeforeMs,
        notBeforeSource: rule.notBeforeSource,
        observations: rule.observations,
        lastBlockAt: rule.lastBlockAt,
      }))
      .sort((a, b) => b.lastBlockAt - a.lastBlockAt || a.origin.localeCompare(b.origin));
  };

  /**
   * Forget one origin's rule. The ONLY non-decay descent path, and it exists
   * only because the caller is a person on the settings page - never a
   * heuristic, and never anything reachable from a tool.
   * @param {string} origin
   * @returns {Promise<{ ok: boolean, forgot: boolean }>}
   */
  const forget = async (origin) => {
    await hydrate();
    if (typeof origin !== 'string' || !rules.has(origin)) return { ok: true, forgot: false };
    rules.delete(origin);
    await persist();
    audit({ type: 'origin_pacing_forgotten', details: { origin, reason: 'user' } });
    return { ok: true, forgot: true };
  };

  /**
   * Forget every rule. Also the recovery path for an unreadable blob: writing a
   * fresh empty state is what lets browser writes stop failing closed.
   * @returns {Promise<{ ok: boolean, forgot: number }>}
   */
  const forgetAll = async () => {
    await hydrate();
    const count = rules.size;
    rules.clear();
    await persist();
    loadFailed = false;
    audit({ type: 'origin_pacing_forgotten', details: { reason: 'user_all', count } });
    return { ok: true, forgot: count };
  };

  /**
   * Does pacing have anything to say at all?
   *
   * why callers need this: resolving the live origin costs a tabs round-trip,
   * and on a profile that no site has ever rate-limited - the overwhelmingly
   * common case - that round-trip would be spent on every browser write to
   * learn nothing. Unreadable state answers TRUE, so the fail-closed path is
   * never skipped as an optimization.
   * @returns {boolean}
   */
  const engaged = () => !ready || loadFailed || rules.size > 0;

  /** Test/diagnostic view. Never consulted by an enforcement decision. */
  const stats = () => Object.freeze({
    size: rules.size, capRefusals, ready, ok: ready && !loadFailed,
  });

  return Object.freeze({
    hydrate, hydrationStatus, engaged, observe, peek, reserve, list, forget, forgetAll, stats,
    settled: () => writeChain.then(() => undefined, () => undefined),
    version: PACE_RULE_VERSION,
  });
};
