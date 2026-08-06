// The pure policy core of adaptive per-origin pacing (issue #234). Every
// transition is a function of (rule, signal, now) with the clock
// and RNG injected, so the arithmetic is pinned exactly rather than approximated.
//
// The load-bearing properties, in order of how much a regression would cost:
//   1. DESCENT IS CONSTRAINED — the only ways down are automatic decay and a
//      one-action reversible probe. There is no model-controlled set or clear.
//   2. A block always yields a rule (a block with no cadence sample still learns).
//   3. Decay is lazy + multi-period (rules self-heal; no permanent tax).
//   4. First action is free; pacing is a catch-up, not a fixed tax.

import { describe, test, expect } from 'bun:test';
import {
  PACE_RULE_VERSION, PACE_TUNABLES, isValidRule, newRule, nextRuleOnBlock,
  decay, isRetired, needsHandOff, waitForAction, startProbe, probeExpired,
  probeAllowsAction, beginProbeAction, noteCleanProbeAction, resolveProbe,
} from '../../extension/peerd-runtime/web-pace/reducer.js';

const K = PACE_TUNABLES;
const T0 = 1_000_000;
// A deterministic RNG: 0.5 → the jitter term is exactly 0 (rng()*2-1 === 0), so
// the catch-up arithmetic is assertable without a band.
const noJitter = () => 0.5;

describe('web-pace — the default is OFF', () => {
  test('a fresh rule costs nothing: no interval, no wait', () => {
    const r = newRule('https://x.com', T0);
    expect(r.minIntervalMs).toBe(0);
    expect(r.version).toBe(PACE_RULE_VERSION);
    expect(r.observations).toBe(0);
    expect(r.probe).toBe(null);
    expect(isRetired(r, K)).toBe(false);
    // even with a prior action a moment ago, a rule-less origin runs full speed
    expect(waitForAction(r, T0 - 1, T0, noJitter)).toBe(0);
  });

  test('waitForAction on a null rule is 0 (an origin peerd never got blocked by)', () => {
    expect(waitForAction(null, T0 - 1, T0, noJitter)).toBe(0);
  });
});

describe('web-pace — learning from a block', () => {
  test('sizes the interval from the cadence that ACTUALLY got blocked', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    expect(r.minIntervalMs).toBe(4_000 * K.slowdownMult);   // "we were doing X → go slower than X"
    expect(r.observations).toBe(1);
    expect(r.lastBlockAt).toBe(T0);
    expect(r.lastEscalationSource).toBe('learned');
  });

  test('a block with NO cadence sample still learns a rule (the seed floor)', () => {
    // An SW restart lost the interval ring, or the block landed on action #1.
    // max() over unknowns would be 0 — i.e. "learn nothing from a real block".
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { now: T0 }, K);
    expect(r.minIntervalMs).toBe(K.seedMs);
  });

  test("an explicit Retry-After wins when it is larger, and is recorded as the site's own ask", () => {
    const r = nextRuleOnBlock(
      newRule('https://x.com', T0),
      { recentIntervalMs: 100, retryAfterMs: 9_000, now: T0 },
      K,
    );
    expect(r.minIntervalMs).toBe(9_000);
    expect(r.lastEscalationSource).toBe('retry-after');
  });

  test('a smaller Retry-After does not claim credit for a cadence-sized rule', () => {
    const r = nextRuleOnBlock(
      newRule('https://x.com', T0),
      { recentIntervalMs: 4_000, retryAfterMs: 1_500, now: T0 },
      K,
    );
    expect(r.minIntervalMs).toBe(8_000);
    expect(r.lastEscalationSource).toBe('learned');
  });

  test('negative and non-finite samples cannot create or rewrite a rule', () => {
    const fresh = newRule('https://x.com', T0);
    expect(nextRuleOnBlock(fresh, { recentIntervalMs: -1, retryAfterMs: -2, now: T0 }, K).minIntervalMs)
      .toBe(K.seedMs);
    expect(nextRuleOnBlock(fresh, { now: NaN }, K)).toEqual(fresh);
    expect(nextRuleOnBlock(fresh, { now: Infinity }, K)).toEqual(fresh);
  });

  test('repeat blocks compound (still too fast) and stay bounded by the ceiling', () => {
    let r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 2_000, now: T0 }, K);
    const first = r.minIntervalMs;
    r = nextRuleOnBlock(r, { now: T0 + 1 }, K);
    expect(r.minIntervalMs).toBe(first * K.growth);
    expect(r.observations).toBe(2);

    // hammer it well past the ceiling — pacing must never promise a multi-minute nap
    for (let i = 0; i < 20; i++) r = nextRuleOnBlock(r, { now: T0 + 2 + i }, K);
    expect(r.minIntervalMs).toBe(K.maxPaceMs);
    expect(needsHandOff(r, K)).toBe(true);   // → posture ladder, not a sleep
  });

  test('malformed persisted state is rejected and cannot fail open', () => {
    const valid = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 2_000, now: T0 }, K);
    const wrongOrigin = { ...valid, origin: 'https://attacker.example' };
    const invalidInterval = { ...valid, minIntervalMs: NaN };
    const invalidJitter = { ...valid, jitterFrac: 1 };
    const incoherentTime = {
      ...valid,
      createdAt: T0 + 10_000,
      updatedAt: T0 + 10_000,
      lastBlockAt: 0,
      lastDecayAt: 0,
    };
    expect(isValidRule(valid, 'https://x.com', K)).toBe(true);
    expect(isValidRule(wrongOrigin, 'https://x.com', K)).toBe(false);
    expect(isValidRule(invalidInterval, 'https://x.com', K)).toBe(false);
    expect(isValidRule(invalidJitter, 'https://x.com', K)).toBe(false);
    expect(isValidRule(incoherentTime, 'https://x.com', K)).toBe(false);
    expect(waitForAction(invalidInterval, T0, T0 + 1, noJitter, K)).toBe(null);
    expect(waitForAction(invalidJitter, T0, T0 + 1, () => 0, K)).toBe(null);
    expect(needsHandOff(invalidInterval, K)).toBe(true);
    expect(nextRuleOnBlock(invalidInterval, { now: T0 + 1 }, K)).toEqual(invalidInterval);
  });

  test('a block on a regressed clock preserves a valid monotonic rule', () => {
    const prior = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 2_000, now: T0 }, K);
    const next = nextRuleOnBlock(prior, { now: -1 }, K);
    expect(isValidRule(next, 'https://x.com', K)).toBe(true);
    expect(next.lastBlockAt).toBe(prior.updatedAt);
    expect(next.updatedAt).toBe(prior.updatedAt);
  });
});

describe('web-pace — decay self-heals a one-off block', () => {
  test('quiet time relaxes the rule; not yet quiet is a no-op', () => {
    const blocked = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    expect(decay(blocked, T0 + K.quietMs - 1, K).minIntervalMs).toBe(blocked.minIntervalMs);
    expect(decay(blocked, T0 + K.quietMs + 1, K).minIntervalMs).toBe(blocked.minIntervalMs * K.decay);
  });

  test('decay is LAZY: five quiet periods later it decays five steps, not one', () => {
    // Rules are recomputed on next access rather than on a timer, so a single
    // decay() call must account for all the quiet time that actually elapsed.
    const blocked = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    const d = decay(blocked, T0 + K.quietMs * 5 + 1, K);
    expect(d.minIntervalMs).toBeCloseTo(blocked.minIntervalMs * (K.decay ** 5), 6);
  });

  test('a site that stopped caring eventually retires its own rule', () => {
    let r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    expect(isRetired(r, K)).toBe(false);
    r = decay(r, T0 + K.quietMs * 40, K);       // a long quiet stretch
    expect(r.minIntervalMs).toBeLessThan(K.retireFloorMs);
    expect(isRetired(r, K)).toBe(true);          // → caller deletes the record; no permanent tax
  });

  test('decay underflow still retires a learned rule', () => {
    const blocked = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    const decayed = decay(blocked, T0 + K.quietMs * 10_000, K);
    expect(decayed.minIntervalMs).toBe(0);
    expect(isRetired(decayed, K)).toBe(true);
  });

  test('never decays mid-probe, and never on a backwards clock', () => {
    const blocked = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    const probing = startProbe(blocked, 500, 60_000, T0);
    expect(decay(probing, T0 + K.quietMs * 5, K)).toEqual(probing);   // the probe owns the value
    expect(decay(blocked, T0 - K.quietMs * 5, K)).toEqual(blocked);   // clock skew → don't relax
  });
});

describe('web-pace — the per-action wait is a catch-up, not a tax', () => {
  test('first action on an origin is free even under a rule', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    expect(waitForAction(r, undefined, T0, noJitter)).toBe(0);
  });

  test('only undefined means no prior action; malformed cadence fails closed', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    for (const invalid of [NaN, Infinity, -Infinity, -1, null]) {
      expect(waitForAction(r, invalid as unknown as number, T0, noJitter, K)).toBe(null);
    }
  });

  test('only the shortfall is waited — natural latency already counts', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 1_000, now: T0 }, K);
    expect(r.minIntervalMs).toBe(2_000);
    // 1500ms already elapsed since the last action → wait the remaining 500
    expect(waitForAction(r, T0, T0 + 1_500, noJitter)).toBe(500);
    // an action that followed a slow read waits nothing at all
    expect(waitForAction(r, T0, T0 + 5_000, noJitter)).toBe(0);
  });

  test('jitter stays within ±jitterFrac of the interval (a metronome is its own tell)', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 1_000, now: T0 }, K);
    const lo = waitForAction(r, T0, T0, () => 0);   // jitter = -jitterFrac
    const hi = waitForAction(r, T0, T0, () => 1);   // jitter = +jitterFrac
    if (lo === null || hi === null) throw new Error('valid rules must produce a wait');
    expect(lo).toBeCloseTo(r.minIntervalMs * (1 - r.jitterFrac), 6);
    expect(hi).toBeCloseTo(r.minIntervalMs * (1 + r.jitterFrac), 6);
    expect(lo).toBeLessThan(hi);
  });

  test('clock skew cannot turn a learned interval into a bypass', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    expect(waitForAction(r, T0 + 10_000, T0, noJitter)).toBe(r.minIntervalMs);
    expect(waitForAction(r, T0, NaN, noJitter)).toBe(r.minIntervalMs);
  });

  test('invalid RNG is neutral and the actual wait never exceeds the ceiling', () => {
    const nearCeiling = {
      ...nextRuleOnBlock(newRule('https://x.com', T0), { retryAfterMs: K.maxPaceMs - 1, now: T0 }, K),
    };
    expect(waitForAction(nearCeiling, T0, T0, () => Infinity, K)).toBe(nearCeiling.minIntervalMs);
    expect(waitForAction(nearCeiling, T0, T0, () => 1, K)).toBe(K.maxPaceMs);
  });

  test('a handoff rule never authorizes an action or a wait', () => {
    const ceiling = nextRuleOnBlock(
      newRule('https://x.com', T0),
      { retryAfterMs: K.maxPaceMs, now: T0 },
      K,
    );
    expect(needsHandOff(ceiling, K)).toBe(true);
    expect(waitForAction(ceiling, undefined, T0, noJitter, K)).toBe(null);
    expect(waitForAction(ceiling, T0, T0, noJitter, K)).toBe(null);
  });
});

describe('web-pace — probe is the reversible way down', () => {
  test('a probe offers one action at a clamped trial interval', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    const p = startProbe(r, 500, 60_000, T0);
    expect(p.probe).toEqual({
      trialMs: 500,
      startedAt: T0,
      until: T0 + 60_000,
      prevMinIntervalMs: r.minIntervalMs,
      actionStartedAt: null,
      cleanObservedAt: null,
    });
    expect(waitForAction(p, T0, T0, noJitter)).toBe(500);
    expect(waitForAction(p, undefined, T0, noJitter)).toBe(null);
    expect(probeAllowsAction(p, T0, K)).toBe(true);
    expect(beginProbeAction(p, -1, T0 + 1, K)).toEqual(p);
    const begun = beginProbeAction(p, T0, T0 + 1, K);
    expect(begun.probe?.actionStartedAt).toBe(T0 + 1);
    expect(probeAllowsAction(begun, T0 + 2, K)).toBe(false);
    expect(waitForAction(begun, T0, T0 + 2, noJitter, K)).toBe(null);
    expect(beginProbeAction(begun, T0, T0 + 2, K)).toEqual(begun);
    // a "probe" that asked to go slower is not a probe — clamped to the current value
    expect(startProbe(r, 99_999, 60_000, T0).probe?.trialMs).toBe(r.minIntervalMs);
    expect(startProbe(p, 10, 60_000, T0)).toEqual(p);              // already probing → window not restarted
    expect(probeExpired(p, T0 + 59_999)).toBe(false);
    expect(probeExpired(p, T0 + 60_000)).toBe(true);
  });

  test('a clean observed action adopts the lower value only after the window and settle time', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    const p = startProbe(r, 100, 60_000, T0);
    const begun = beginProbeAction(p, T0, T0 + 1, K);
    const observed = noteCleanProbeAction(begun, T0 + 1, T0 + 2, K);
    expect(resolveProbe(observed, 'clean', T0 + 59_999, K)).toEqual(observed);
    expect(resolveProbe(observed, 'clean', T0 + 60_000, K).probe).toBe(null);
    const done = resolveProbe(observed, 'clean', T0 + 60_000, K);
    expect(done.minIntervalMs).toBe(100);
    expect(done.probe).toBe(null);
    expect(isRetired(done, K)).toBe(true);   // 100 < retireFloorMs → the site stopped caring
  });

  test('a probe cannot resolve clean without a reserved and observed action', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    const idle = startProbe(r, 100, 60_000, T0);
    expect(resolveProbe(idle, 'clean', T0 + 60_000, K)).toEqual(idle);
    expect(beginProbeAction(idle, T0, T0 - 1, K)).toEqual(idle);
    expect(beginProbeAction(idle, T0, T0 + 60_000, K)).toEqual(idle);
    const begun = beginProbeAction(idle, T0, T0 + 1, K);
    expect(noteCleanProbeAction(begun, T0, T0 + 2, K)).toEqual(begun);
    expect(resolveProbe(begun, 'clean', T0 + 60_000, K)).toEqual(begun);
  });

  test('a result observed after the window can settle, while a delayed block still wins', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    const begun = beginProbeAction(startProbe(r, 500, 60_000, T0), T0, T0 + 59_999, K);
    const observedAt = T0 + 60_500;
    const observed = noteCleanProbeAction(begun, T0 + 59_999, observedAt, K);
    expect(resolveProbe(observed, 'clean', observedAt + K.probeSettleMs - 1, K)).toEqual(observed);
    const blocked = resolveProbe(observed, 'blocked', observedAt + 1, K);
    expect(blocked.probe).toBe(null);
    expect(blocked.minIntervalMs).toBeGreaterThan(r.minIntervalMs);
  });

  test('probe inputs are finite, non-negative, and window-bounded', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    for (const bad of [NaN, Infinity, -Infinity, -1]) {
      expect(startProbe(r, bad, 60_000, T0, K)).toEqual(r);
    }
    for (const bad of [NaN, Infinity, -Infinity, 0, -1]) {
      expect(startProbe(r, 500, bad, T0, K)).toEqual(r);
    }
    expect(startProbe(r, 500, 1, T0, K).probe?.until).toBe(T0 + K.minProbeWindowMs);
    expect(startProbe(r, 500, K.maxProbeWindowMs * 2, T0, K).probe?.until)
      .toBe(T0 + K.maxProbeWindowMs);
    expect(startProbe(r, 500, 60_000, NaN, K)).toEqual(r);
    expect(startProbe(r, 500, 60_000, T0 - 1, K)).toEqual(r);
  });

  test('a blocked probe snaps back, re-escalates, and resets the quiet timer', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    const p = beginProbeAction(startProbe(r, 500, 60_000, T0), T0, T0 + 1, K);
    const after = resolveProbe(p, 'blocked', T0 + 60_000, K);
    expect(after.probe).toBe(null);
    // it must NOT keep the trial value it just got blocked at…
    expect(after.minIntervalMs).toBeGreaterThan(500);
    // …and must not merely restore the old one either — the trial taught us more
    expect(after.minIntervalMs).toBe(r.minIntervalMs * K.growth);
    expect(after.lastBlockAt).toBe(T0 + 60_000);   // quiet timer reset → decay can't undo the lesson
    expect(after.observations).toBe(r.observations + 1);
  });

  test('an inconclusive or zero-interval probe cannot leave a dead rule behind', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    const idle = startProbe(r, 0, 60_000, T0);
    expect(resolveProbe(idle, 'inconclusive', T0 + 1, K)).toEqual({
      ...r,
      updatedAt: T0 + 1,
    });
    const begun = beginProbeAction(idle, T0, T0 + 1, K);
    const observed = noteCleanProbeAction(begun, T0 + 1, T0 + 2, K);
    const done = resolveProbe(observed, 'clean', T0 + 60_000, K);
    expect(done.minIntervalMs).toBe(0);
    expect(isRetired(done, K)).toBe(true);
  });
});

describe('web-pace — the export surface has no model-controlled rule mutation', () => {
  test('descent remains decay or the one-action probe state machine', async () => {
    const mod = await import('../../extension/peerd-runtime/web-pace/reducer.js');
    expect(Object.keys(mod).sort()).toEqual([
      'PACE_RULE_VERSION', 'PACE_TUNABLES', 'beginProbeAction', 'decay',
      'isRetired', 'isValidRule', 'needsHandOff', 'newRule',
      'nextRuleOnBlock', 'noteCleanProbeAction', 'probeAllowsAction',
      'probeExpired', 'resolveProbe', 'startProbe', 'waitForAction',
    ].sort());
  });
});
