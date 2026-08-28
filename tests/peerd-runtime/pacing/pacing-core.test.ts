// The pure policy core of adaptive per-origin action pacing (#234).
//
// The first two describe blocks pin the exact defects that closed PR #218:
// Retry-After treated as an interval from the prior action rather than an
// absolute deadline from the response, and an adjustment that could move an
// action EARLIER than the time a server named. Everything else is arithmetic.

import { describe, test, expect } from 'bun:test';
import {
  PACE_TUNABLES,
  isBlockingStatus, isRateLimitSignal, parseRetryAfter,
  newRule, isValidRule, nextRuleOnBlock, noteActionAt,
  decayRule, isRetired, planRequest,
} from '../../../extension/peerd-runtime/pacing/pacing-core.js';

type Rule = ReturnType<typeof newRule>;

const T0 = 1_700_000_000_000;
const rule = (over: Partial<Rule> = {}): Rule => ({ ...newRule('https://example.com', T0), ...over });

describe('Retry-After is an ABSOLUTE deadline anchored to the response (#218 defect 1)', () => {
  test('delta-seconds is measured from the response, not from the prior action', () => {
    // The #218 example: an action at t=0, a 429 seen at t=5s, `Retry-After: 9`.
    // The server asked for t=14s. An interval-from-the-prior-action reading
    // would have permitted t=9s.
    const observedAt = T0 + 5_000;
    const blocked = nextRuleOnBlock(
      rule({ lastActionMs: T0 }),
      { responseAtMs: observedAt, status: 429, retryAfter: '9' },
    );
    expect(blocked.notBeforeMs).toBe(observedAt + 9_000 + PACE_TUNABLES.skewGuardMs);
    expect(blocked.notBeforeMs).toBeGreaterThan(T0 + 9_000);
  });

  test('the deadline does not move when the prior action was earlier or later', () => {
    const observedAt = T0 + 5_000;
    const signal = { responseAtMs: observedAt, status: 429, retryAfter: '30' };
    const early = nextRuleOnBlock(rule({ lastActionMs: T0 }), signal);
    const late = nextRuleOnBlock(rule({ lastActionMs: observedAt - 1 }), signal);
    expect(early.notBeforeMs).toBe(late.notBeforeMs);
  });

  test('an HTTP-date Retry-After parses (the form the provider adapters drop)', () => {
    const at = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    const parsed = parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', at - 60_000);
    expect(parsed).not.toBeNull();
    expect(parsed!.source).toBe('retry-after-date');
    expect(parsed!.deadlineMs).toBe(at);
  });

  test('a past HTTP-date asks for nothing rather than inventing a deadline', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', T0)).toBeNull();
  });

  test('garbage falls back to the status backoff, never to zero', () => {
    expect(parseRetryAfter('3 hours', T0)).toBeNull();
    expect(parseRetryAfter('-1', T0)).toBeNull();
    const blocked = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429, retryAfter: '3 hours' });
    expect(blocked.notBeforeMs).toBe(T0 + PACE_TUNABLES.statusBackoffMs);
    expect(blocked.notBeforeSource).toBe('status-backoff');
  });

  test('a very long Retry-After is clamped rather than held as a live rule for a day', () => {
    const blocked = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 503, retryAfter: '604800' });
    expect(blocked.notBeforeMs).toBe(T0 + PACE_TUNABLES.maxDeadlineMs);
  });

  test('a second, shorter block never shortens a live deadline', () => {
    const long = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429, retryAfter: '600' });
    const short = nextRuleOnBlock(long, { responseAtMs: T0 + 1_000, status: 429, retryAfter: '1' });
    expect(short.notBeforeMs).toBe(long.notBeforeMs);
  });
});

describe('no adjustment may move an action earlier than a stated deadline (#218 defect 2)', () => {
  test('the planned wait always reaches at least the deadline', () => {
    // Sweep every offset inside the window. A one-sided guard means the wait is
    // never shorter than the distance to the deadline; the old negative jitter
    // is what this sweep would catch.
    const blocked = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429, retryAfter: '10' });
    for (let offset = 0; offset < 10_000; offset += 97) {
      const now = T0 + offset;
      const verdict = planRequest(blocked, { now, isWrite: true });
      expect(verdict).not.toBeNull();
      if (verdict!.action === 'go') throw new Error(`released early at +${offset}ms`);
      expect(now + verdict!.waitMs).toBeGreaterThanOrEqual(blocked.notBeforeMs);
    }
  });

  test('the skew guard only ever delays', () => {
    const blocked = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429, retryAfter: '10' });
    expect(blocked.notBeforeMs).toBeGreaterThan(T0 + 10_000);
  });

  test('a deadline gates reads too, not only writes', () => {
    const blocked = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429, retryAfter: '10' });
    const verdict = planRequest(blocked, { now: T0 + 1_000, isWrite: false });
    expect(verdict!.action).toBe('wait');
    expect(verdict!.action === 'wait' && verdict!.reason).toBe('server-deadline');
  });
});

describe('what counts as a rate-limit signal', () => {
  test('429 and 503 are blocking; 403 alone is not', () => {
    expect(isBlockingStatus(429)).toBe(true);
    expect(isBlockingStatus(503)).toBe(true);
    expect(isBlockingStatus(403)).toBe(false);
  });

  test('Retry-After on a 403 counts, on a 200 it does not', () => {
    expect(isRateLimitSignal(403, '30')).toBe(true);
    // A 202 with Retry-After is polling guidance for a job, not a rate limit.
    expect(isRateLimitSignal(202, '5')).toBe(false);
    expect(isRateLimitSignal(200, '5')).toBe(false);
  });
});

describe('the learned interval gates writes only', () => {
  test('a first block seeds an interval even with no cadence sample', () => {
    const blocked = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429 });
    expect(blocked.minIntervalMs).toBe(PACE_TUNABLES.seedMs);
    expect(blocked.observations).toBe(1);
  });

  test('it is sized from the cadence that actually got blocked', () => {
    const blocked = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429, recentIntervalMs: 4_000 });
    expect(blocked.minIntervalMs).toBe(4_000 * PACE_TUNABLES.slowdownMult);
  });

  test('a repeat block compounds, and the ceiling holds', () => {
    let r = rule();
    for (let i = 0; i < 12; i += 1) r = nextRuleOnBlock(r, { responseAtMs: T0 + i, status: 429 });
    expect(r.minIntervalMs).toBe(PACE_TUNABLES.maxIntervalMs);
  });

  test('a write waits out the interval; a read does not', () => {
    const paced = noteActionAt(
      nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429, recentIntervalMs: 1_000 }),
      T0 + 1,
    );
    const at = T0 + 500;
    expect(planRequest(paced, { now: at, isWrite: true })!.action).toBe('wait');
    // No live deadline is left by then, so the read is free.
    const clear = { ...paced, notBeforeMs: 0, notBeforeSource: 'none' as const };
    expect(planRequest(clear, { now: at, isWrite: false })!.action).toBe('go');
  });

  test('the first write on an origin is free: an interval is a gap from something', () => {
    const blocked = { ...nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429 }), notBeforeMs: 0, notBeforeSource: 'none' as const };
    expect(blocked.lastActionMs).toBe(0);
    expect(planRequest(blocked, { now: T0 + 10, isWrite: true })!.action).toBe('go');
  });

  test('the wait is a catch-up: elapsed time counts toward the interval', () => {
    const paced = noteActionAt(
      { ...nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429, recentIntervalMs: 5_000 }), notBeforeMs: 0, notBeforeSource: 'none' as const },
      T0 + 1,
    );
    const verdict = planRequest(paced, { now: T0 + 9_001, isWrite: true });
    expect(verdict!.action).toBe('wait');
    expect(verdict!.action === 'wait' && verdict!.waitMs).toBe(1_000);
  });
});

describe('the ceiling hands off instead of napping', () => {
  test('a wait past the inline ceiling is a handoff, not a longer sleep', () => {
    const blocked = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429, retryAfter: '600' });
    const verdict = planRequest(blocked, { now: T0 + 1_000, isWrite: true });
    expect(verdict!.action).toBe('handoff');
    expect(verdict!.action === 'handoff' && verdict!.untilMs).toBe(blocked.notBeforeMs);
  });

  test('a wait inside the ceiling sleeps', () => {
    const blocked = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429, retryAfter: '5' });
    expect(planRequest(blocked, { now: T0 + 1_000, isWrite: true })!.action).toBe('wait');
  });

  test('a caller with a smaller budget hands off sooner on the SAME rule', () => {
    // The network path sits inside a caller-owned fetch timeout it must not eat;
    // a browser action is bounded by the turn and shows a wait bar instead.
    const blocked = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429, retryAfter: '10' });
    const at = { now: T0 + 1_000, isWrite: true };
    expect(planRequest(blocked, at)!.action).toBe('wait');
    expect(planRequest(blocked, { ...at, maxInlineWaitMs: 5_000 })!.action).toBe('handoff');
  });

  test('a caller cannot raise the ceiling past the tunable maximum', () => {
    const blocked = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429, retryAfter: '600' });
    const verdict = planRequest(blocked, {
      now: T0 + 1_000, isWrite: true, maxInlineWaitMs: Number.MAX_SAFE_INTEGER,
    });
    expect(verdict!.action).toBe('handoff');
  });
});

describe('descent', () => {
  test('quiet time decays the learned floor, multi-period in one step', () => {
    const blocked = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429, recentIntervalMs: 4_000 });
    const later = decayRule(blocked, T0 + (PACE_TUNABLES.quietMs * 3) + 1);
    expect(later.minIntervalMs).toBe(8_000 * (PACE_TUNABLES.decay ** 3));
  });

  test('decay never touches a server deadline', () => {
    const blocked = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429, retryAfter: '600' });
    const later = decayRule(blocked, T0 + PACE_TUNABLES.quietMs + 1);
    expect(later.notBeforeMs).toBe(blocked.notBeforeMs);
  });

  test('a backwards clock never relaxes a rule', () => {
    const blocked = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429 });
    expect(decayRule(blocked, T0 - 60_000)).toBe(blocked);
  });

  test('a rule decayed under the floor with no live deadline is retired', () => {
    let r = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429 });
    r = { ...r, notBeforeMs: 0, notBeforeSource: 'none' };
    const much = decayRule(r, T0 + (PACE_TUNABLES.quietMs * 10) + 1);
    expect(isRetired(much, T0 + (PACE_TUNABLES.quietMs * 10) + 1)).toBe(true);
  });

  test('a rule is NOT retired while its deadline is still live', () => {
    const r = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429, retryAfter: '600' });
    const tiny = { ...r, minIntervalMs: 1 };
    expect(isRetired(tiny, T0 + 1_000)).toBe(false);
  });

  test('a never-blocked rule is not retirable, so a fresh record is not deleted on sight', () => {
    expect(isRetired(rule(), T0)).toBe(false);
  });

  test('there is no exported way to clear or lower a rule directly', async () => {
    const core = await import('../../../extension/peerd-runtime/pacing/pacing-core.js');
    const names = Object.keys(core);
    expect(names.some((n) => /^(clear|reset|set|lower|relax)/i.test(n))).toBe(false);
  });
});

describe('validation fails closed', () => {
  test('a well-formed rule validates, and the origin can be pinned', () => {
    const blocked = nextRuleOnBlock(rule(), { responseAtMs: T0, status: 429 });
    expect(isValidRule(blocked)).toBe(true);
    expect(isValidRule(blocked, 'https://example.com')).toBe(true);
    // A valid record replayed under another key must be refused: it would apply
    // one site's pause to a different site.
    expect(isValidRule(blocked, 'https://evil.test')).toBe(false);
  });

  test('a rule the validator refuses makes the planner return null, not "go"', () => {
    expect(planRequest({ ...rule(), minIntervalMs: -1 } as any, { now: T0, isWrite: true })).toBeNull();
    expect(planRequest('nonsense' as any, { now: T0, isWrite: true })).toBeNull();
  });

  test('no rule at all means go', () => {
    expect(planRequest(null, { now: T0, isWrite: true })).toEqual({ action: 'go' });
  });

  test('structurally impossible combinations are refused', () => {
    expect(isValidRule({ ...rule(), notBeforeMs: 0, notBeforeSource: 'status-backoff' })).toBe(false);
    expect(isValidRule({ ...rule(), observations: 0, lastBlockAt: T0 })).toBe(false);
    expect(isValidRule({ ...rule(), minIntervalMs: PACE_TUNABLES.maxIntervalMs + 1 })).toBe(false);
    expect(isValidRule({ ...rule(), version: 2 })).toBe(false);
    expect(isValidRule({ ...rule(), seq: -1 })).toBe(false);
  });

  test('seq increases on every transition that changes the record', () => {
    const base = rule();
    const blocked = nextRuleOnBlock(base, { responseAtMs: T0, status: 429 });
    expect(blocked.seq).toBe(base.seq + 1);
    expect(noteActionAt(blocked, T0 + 5).seq).toBe(blocked.seq + 1);
  });
});
