// The pure policy core of adaptive per-origin pacing (docs/store/ADAPTIVE-PACING.md,
// PR #213). Every transition is a function of (rule, signal, now) with the clock
// and RNG injected, so the arithmetic is pinned exactly rather than approximated.
//
// The load-bearing properties, in order of how much a regression would cost:
//   1. DESCENT IS CONSTRAINED — the agent can raise pacing but never lower it;
//      the only ways down are automatic decay and a reversible probe. This is
//      the anti-injection property: a page that talks the actor into "clearing"
//      a rule would get peerd hammering a site on the user's real logged-in
//      account. There is no clearRule() to test because there deliberately isn't one.
//   2. A block always yields a rule (a block with no cadence sample still learns).
//   3. Decay is lazy + multi-period (rules self-heal; no permanent tax).
//   4. First action is free; pacing is a catch-up, not a fixed tax.

import { describe, test, expect } from 'bun:test';
import {
  PACE_TUNABLES, newRule, nextRuleOnBlock, decay, isRetired, needsHandOff,
  waitForAction, startProbe, probeExpired, resolveProbe, applyAgentSet,
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
    expect(r.observations).toBe(0);
    expect(r.probe).toBe(null);
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
    expect(r.source).toBe('learned');
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
    expect(r.source).toBe('retry-after');   // honoring it is the whole compliance story
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
    expect(lo).toBeCloseTo(r.minIntervalMs * (1 - r.jitterFrac), 6);
    expect(hi).toBeCloseTo(r.minIntervalMs * (1 + r.jitterFrac), 6);
    expect(lo).toBeLessThan(hi);
  });

  test('clock skew never stalls an action', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    expect(waitForAction(r, T0 + 10_000, T0, noJitter)).toBe(0);   // "last action" in the future
  });
});

describe('web-pace — probe is the reversible way down', () => {
  test('a probe paces at the trial interval, and is clamped to at most the current one', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    const p = startProbe(r, 500, 60_000, T0);
    expect(p.probe).toEqual({ trialMs: 500, until: T0 + 60_000, prevMinIntervalMs: r.minIntervalMs });
    expect(waitForAction(p, T0, T0, noJitter)).toBe(500);          // the TRIAL is enforced, not the rule
    // a "probe" that asked to go slower is not a probe — clamped to the current value
    expect(startProbe(r, 99_999, 60_000, T0).probe?.trialMs).toBe(r.minIntervalMs);
    expect(startProbe(p, 10, 60_000, T0)).toEqual(p);              // already probing → window not restarted
    expect(probeExpired(p, T0 + 59_999)).toBe(false);
    expect(probeExpired(p, T0 + 60_000)).toBe(true);
  });

  test('a CLEAN probe adopts the lower value (and can make the rule retirable)', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    const done = resolveProbe(startProbe(r, 100, 60_000, T0), false, T0 + 60_000, K);
    expect(done.minIntervalMs).toBe(100);
    expect(done.probe).toBe(null);
    expect(isRetired(done, K)).toBe(true);   // 100 < retireFloorMs → the site stopped caring
  });

  test('a BLOCKED probe snaps back, re-escalates from the trial, and resets the quiet timer', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    const p = startProbe(r, 500, 60_000, T0);
    const after = resolveProbe(p, true, T0 + 60_000, K);
    expect(after.probe).toBe(null);
    // it must NOT keep the trial value it just got blocked at…
    expect(after.minIntervalMs).toBeGreaterThan(500);
    // …and must not merely restore the old one either — the trial taught us more
    expect(after.minIntervalMs).toBe(r.minIntervalMs * K.growth);
    expect(after.lastBlockAt).toBe(T0 + 60_000);   // quiet timer reset → decay can't undo the lesson
    expect(after.observations).toBe(r.observations + 1);
  });
});

// The reason this module has no clearRule(): lowering is the direction an
// injected page benefits from. Raising is self-limiting; retiring a rule makes
// peerd hammer a site on the user's REAL logged-in session. An SW-side re-check
// can validate a call's args but never its intent, so the descent simply isn't
// a decision the actor is allowed to make.
describe('web-pace — the agent may raise pacing, never lower it (anti-injection)', () => {
  test('a raise is honored and attributed to the agent', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 1_000, now: T0 }, K);
    expect(r.minIntervalMs).toBe(2_000);
    const raised = applyAgentSet(r, 5_000, T0 + 1, K);
    expect(raised.minIntervalMs).toBe(5_000);
    expect(raised.source).toBe('agent');
  });

  test('every lowering request is a NO-OP — including the zero a "clear" would use', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 4_000, now: T0 }, K);
    for (const attempt of [0, 1, 500, r.minIntervalMs - 1, r.minIntervalMs]) {
      expect(applyAgentSet(r, attempt, T0 + 1, K).minIntervalMs).toBe(r.minIntervalMs);
    }
    // …and junk can't sneak past the guard either
    expect(applyAgentSet(r, NaN, T0 + 1, K)).toEqual(r);
    expect(applyAgentSet(r, -5_000, T0 + 1, K).minIntervalMs).toBe(r.minIntervalMs);
  });

  test('a raise is still clamped to the ceiling (no agent-driven multi-minute nap)', () => {
    const r = nextRuleOnBlock(newRule('https://x.com', T0), { recentIntervalMs: 1_000, now: T0 }, K);
    expect(applyAgentSet(r, 10 * 60_000, T0 + 1, K).minIntervalMs).toBe(K.maxPaceMs);
  });

  test('the export surface offers no clear/reset escape hatch — descent is decay or probe only', async () => {
    // Pinned exactly: adding a clearRule()/resetRule() later fails here, which
    // is the point. The only downward transitions are decay() (time, automatic)
    // and resolveProbe() (bounded, reverts on a block).
    const mod = await import('../../extension/peerd-runtime/web-pace/reducer.js');
    expect(Object.keys(mod).sort()).toEqual([
      'PACE_TUNABLES', 'applyAgentSet', 'decay', 'isRetired', 'needsHandOff',
      'newRule', 'nextRuleOnBlock', 'probeExpired', 'resolveProbe', 'startProbe', 'waitForAction',
    ].sort());
  });
});
