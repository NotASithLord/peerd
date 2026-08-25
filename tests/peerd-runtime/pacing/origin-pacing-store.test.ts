// The service-worker control plane for per-origin action pacing (#234): the
// durable record, the per-origin lane, and the fail-closed posture.
//
// The sleep is injected, so a "wait" is observable as an ordering fact rather
// than as wall-clock time.

import { describe, test, expect } from 'bun:test';
import {
  createOriginPacingStore, normalizePacingState, PACING_KEY,
} from '../../../extension/peerd-runtime/pacing/origin-pacing-store.js';

const memoryKv = () => {
  const values = new Map<string, any>();
  return {
    values,
    reads: 0,
    get: async function (this: any, key: string) { this.reads += 1; return values.get(key); },
    set: async (key: string, value: any) => { values.set(key, structuredClone(value)); },
  };
};

const clock = (start = 1_700_000_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; }, at: () => t };
};

/** A sleep that advances the fake clock instead of waiting. */
const fakeSleep = (c: ReturnType<typeof clock>) => async (ms: number, signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  c.advance(ms);
};

const store = (over: Record<string, any> = {}) => {
  const kv = memoryKv();
  const c = clock();
  return {
    kv,
    c,
    s: createOriginPacingStore({ kv, now: c.now, sleep: fakeSleep(c), ...over }),
  };
};

const ORIGIN = 'https://example.com';

describe('normalizePacingState', () => {
  test('absent state is an empty record, not a failure', () => {
    expect(normalizePacingState(undefined)).toEqual({ schema: 1, entries: {} });
  });

  test('a wrong schema, a bad shape, or one bad entry makes the WHOLE blob corrupt', () => {
    expect(normalizePacingState({ schema: 2, entries: {} })).toBeNull();
    expect(normalizePacingState([])).toBeNull();
    expect(normalizePacingState({ schema: 1, entries: { 'https://a.test': { nope: true } } })).toBeNull();
  });

  test('a valid record filed under the wrong key is refused', () => {
    const good = {
      version: 1, origin: 'https://a.test', notBeforeMs: 0, notBeforeSource: 'none',
      minIntervalMs: 0, lastActionMs: 0, strikes: 0, observations: 0,
      lastBlockAt: 0, lastDecayAt: 1, createdAt: 1, updatedAt: 1, seq: 0,
    };
    expect(normalizePacingState({ schema: 1, entries: { 'https://a.test': good } })).not.toBeNull();
    expect(normalizePacingState({ schema: 1, entries: { 'https://b.test': good } })).toBeNull();
  });
});

describe('observing a limit', () => {
  test('a 429 with Retry-After creates a durable rule anchored to the response', async () => {
    const { s, kv, c } = store();
    const at = c.at();
    await s.observe({ origin: ORIGIN, responseAtMs: at, status: 429, retryAfter: '10' });
    await s.settled();
    const saved = kv.values.get(PACING_KEY);
    expect(saved.entries[ORIGIN].notBeforeMs).toBeGreaterThan(at + 10_000);
    expect(saved.entries[ORIGIN].notBeforeSource).toBe('retry-after-seconds');
  });

  test('an ordinary 200 teaches nothing and writes nothing', async () => {
    const { s, kv } = store();
    await s.observe({ origin: ORIGIN, responseAtMs: 1, status: 200 });
    await s.settled();
    expect(kv.values.get(PACING_KEY)).toBeUndefined();
  });

  test('a 202 with Retry-After is polling guidance, not a limit', async () => {
    const { s } = store();
    await s.observe({ origin: ORIGIN, responseAtMs: 1, status: 202, retryAfter: '5' });
    expect(s.stats().size).toBe(0);
  });

  test('the rule survives a service-worker generation', async () => {
    const kv = memoryKv();
    const c = clock();
    const first = createOriginPacingStore({ kv, now: c.now, sleep: fakeSleep(c) });
    await first.observe({ origin: ORIGIN, responseAtMs: c.at(), status: 429, retryAfter: '20' });
    await first.settled();

    // A new factory models a restarted worker: only kv survives.
    const second = createOriginPacingStore({ kv, now: c.now, sleep: fakeSleep(c) });
    await second.hydrate();
    const clearance = await second.reserve(ORIGIN, { isWrite: true });
    expect(clearance.outcome).toBe('waited');
    expect(clearance.waitedMs).toBeGreaterThan(0);
  });

  test('at the cap a NEW origin is refused a rule while known origins keep updating', async () => {
    const { s, c } = store({ cap: 2 });
    await s.observe({ origin: 'https://a.test', responseAtMs: c.at(), status: 429 });
    await s.observe({ origin: 'https://b.test', responseAtMs: c.at(), status: 429 });
    await s.observe({ origin: 'https://c.test', responseAtMs: c.at(), status: 429 });
    expect(s.stats().size).toBe(2);
    expect(s.stats().capRefusals).toBe(1);
    // The known origin still escalates: the cap must not freeze existing rules.
    await s.observe({ origin: 'https://a.test', responseAtMs: c.at(), status: 429 });
    const rows = await s.list();
    expect(rows.find((r) => r.origin === 'https://a.test')!.observations).toBe(2);
  });
});

describe('the wait, and the per-origin lane', () => {
  test('a reservation waits out the deadline and reports how long', async () => {
    const { s, c } = store();
    await s.observe({ origin: ORIGIN, responseAtMs: c.at(), status: 429, retryAfter: '5' });
    const before = c.at();
    const clearance = await s.reserve(ORIGIN, { isWrite: true });
    expect(clearance.outcome).toBe('waited');
    expect(c.at() - before).toBeGreaterThanOrEqual(5_000);
  });

  test('a wait past the inline ceiling is a handoff, and nothing is sent', async () => {
    const { s, c } = store();
    await s.observe({ origin: ORIGIN, responseAtMs: c.at(), status: 429, retryAfter: '600' });
    const before = c.at();
    const clearance = await s.reserve(ORIGIN, { isWrite: true });
    expect(clearance.outcome).toBe('handoff');
    expect(c.at()).toBe(before);                 // it did not nap
    expect(clearance.untilMs).toBeGreaterThan(before);
  });

  test('two reservations on ONE origin cannot pass the limiter together', async () => {
    const { s, c } = store();
    // A learned interval with no live deadline, and one action already stamped.
    await s.observe({ origin: ORIGIN, responseAtMs: c.at(), status: 429, retryAfter: '1' });
    await s.reserve(ORIGIN, { isWrite: true });     // clears the deadline, stamps

    const order: string[] = [];
    const a = s.reserve(ORIGIN, { isWrite: true }).then(() => order.push('a'));
    const b = s.reserve(ORIGIN, { isWrite: true }).then(() => order.push('b'));
    await Promise.all([a, b]);
    expect(order).toEqual(['a', 'b']);
    const rows = await s.list();
    expect(rows[0].minIntervalMs).toBeGreaterThan(0);
  });

  test('reservations on DIFFERENT origins do not block each other', async () => {
    // A gated sleep, so "slow is still asleep" is an observable state rather
    // than a wall-clock race.
    const kv = memoryKv();
    const c = clock();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const s = createOriginPacingStore({
      kv,
      now: c.now,
      sleep: async (ms: number) => { await gate; c.advance(ms); },
    });
    await s.observe({ origin: 'https://slow.test', responseAtMs: c.at(), status: 429, retryAfter: '5' });

    const order: string[] = [];
    const slow = s.reserve('https://slow.test', { isWrite: true }).then(() => order.push('slow'));
    const fast = s.reserve('https://fast.test', { isWrite: true }).then(() => order.push('fast'));
    // fast settles while slow is still parked in its own lane's sleep.
    await fast;
    expect(order).toEqual(['fast']);
    release();
    await slow;
    expect(order).toEqual(['fast', 'slow']);
  });

  test('an origin with no rule goes immediately', async () => {
    const { s } = store();
    expect(await s.reserve('https://unknown.test', { isWrite: true })).toMatchObject({ outcome: 'go', waitedMs: 0 });
  });

  test('Stop during a wait rejects and frees the lane for the next caller', async () => {
    const { s, c } = store();
    await s.observe({ origin: ORIGIN, responseAtMs: c.at(), status: 429, retryAfter: '5' });
    const controller = new AbortController();
    controller.abort();
    await expect(s.reserve(ORIGIN, { isWrite: true, signal: controller.signal })).rejects.toThrow();
    // The lane is not wedged: a fresh reservation still resolves.
    const after = await s.reserve(ORIGIN, { isWrite: true });
    expect(['waited', 'go']).toContain(after.outcome);
  });

  test('the UI notice fires once per sleep, carrying the deadline the panel ticks from', async () => {
    const { s, c } = store();
    await s.observe({ origin: ORIGIN, responseAtMs: c.at(), status: 429, retryAfter: '5' });
    const seen: any[] = [];
    await s.reserve(ORIGIN, { isWrite: true, onWait: (info) => seen.push(info) });
    expect(seen).toHaveLength(1);
    expect(seen[0].origin).toBe(ORIGIN);
    expect(seen[0].untilMs).toBeGreaterThan(c.at() - 5_500);
    expect(seen[0].reason).toBe('server-deadline');
  });

  test('a notice callback that throws never changes the decision', async () => {
    const { s, c } = store();
    await s.observe({ origin: ORIGIN, responseAtMs: c.at(), status: 429, retryAfter: '5' });
    const clearance = await s.reserve(ORIGIN, {
      isWrite: true, onWait: () => { throw new Error('panel exploded'); },
    });
    expect(clearance.outcome).toBe('waited');
  });
});

describe('fail-closed on unreadable state', () => {
  const corrupt = () => {
    const kv = memoryKv();
    kv.values.set(PACING_KEY, { schema: 99, entries: 'nope' });
    const c = clock();
    return { kv, c, s: createOriginPacingStore({ kv, now: c.now, sleep: fakeSleep(c) }) };
  };

  test('a corrupt record refuses browser WRITES', async () => {
    const { s } = corrupt();
    await s.hydrate();
    expect((await s.reserve(ORIGIN, { isWrite: true })).outcome).toBe('unavailable');
    expect(s.peek(ORIGIN, { isWrite: true }).outcome).toBe('unavailable');
  });

  test('a corrupt record still lets READS through', async () => {
    const { s } = corrupt();
    await s.hydrate();
    expect((await s.reserve(ORIGIN, { isWrite: false })).outcome).toBe('go');
  });

  test('corrupt is NOT the same as empty: it is never silently reset', async () => {
    const { s, kv } = corrupt();
    await s.hydrate();
    expect(kv.values.get(PACING_KEY)).toEqual({ schema: 99, entries: 'nope' });
    expect(s.hydrationStatus()).toMatchObject({ ready: true, ok: false });
  });

  test('an observation never overwrites an unreadable record with a partial one', async () => {
    const { s, kv, c } = corrupt();
    await s.observe({ origin: ORIGIN, responseAtMs: c.at(), status: 429, retryAfter: '30' });
    await s.settled();
    // The evidence survives, and the store still refuses writes rather than
    // silently reporting itself healthy on a record it never read.
    expect(kv.values.get(PACING_KEY)).toEqual({ schema: 99, entries: 'nope' });
    expect(s.hydrationStatus().ok).toBe(false);
    expect((await s.reserve(ORIGIN, { isWrite: true })).outcome).toBe('unavailable');
  });

  test('the human "forget all" is the recovery path back to a readable record', async () => {
    const { s } = corrupt();
    await s.forgetAll();
    expect(s.hydrationStatus().ok).toBe(true);
    expect((await s.reserve(ORIGIN, { isWrite: true })).outcome).toBe('go');
  });

  test('a pre-hydrate write refuses rather than reading an empty map as "no limits"', async () => {
    const kv = memoryKv();
    const c = clock();
    const s = createOriginPacingStore({ kv, now: c.now, sleep: fakeSleep(c) });
    // peek is the synchronous path the dispatcher's ceiling check uses, and it
    // runs before hydrate() has resolved on a cold worker.
    expect(s.peek(ORIGIN, { isWrite: true }).outcome).toBe('unavailable');
    expect(s.peek(ORIGIN, { isWrite: false }).outcome).toBe('go');
  });
});

describe('engaged', () => {
  test('an untouched profile is not engaged, so callers can skip resolving an origin', async () => {
    const { s } = store();
    await s.hydrate();
    expect(s.engaged()).toBe(false);
  });

  test('one learned rule engages it', async () => {
    const { s, c } = store();
    await s.observe({ origin: ORIGIN, responseAtMs: c.at(), status: 429 });
    expect(s.engaged()).toBe(true);
  });

  test('unreadable state is ENGAGED, so the fail-closed path is never skipped', async () => {
    const kv = memoryKv();
    kv.values.set(PACING_KEY, { schema: 99 });
    const c = clock();
    const s = createOriginPacingStore({ kv, now: c.now, sleep: fakeSleep(c) });
    await s.hydrate();
    expect(s.engaged()).toBe(true);
  });

  test('a not-yet-hydrated store is engaged', () => {
    const s = createOriginPacingStore({ kv: memoryKv(), now: () => 1 });
    expect(s.engaged()).toBe(true);
  });
});

describe('the human controls', () => {
  test('forget removes one rule and audits it', async () => {
    const events: any[] = [];
    const kv = memoryKv();
    const c = clock();
    const s = createOriginPacingStore({
      kv, now: c.now, sleep: fakeSleep(c), onAudit: (e) => events.push(e),
    });
    await s.observe({ origin: ORIGIN, responseAtMs: c.at(), status: 429, retryAfter: '600' });
    expect((await s.forget(ORIGIN)).forgot).toBe(true);
    expect(await s.list()).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['origin_pacing_learned', 'origin_pacing_forgotten']);
    // And the removal is durable, not heap-only.
    expect(kv.values.get(PACING_KEY).entries[ORIGIN]).toBeUndefined();
  });

  test('forgetting an origin with no rule is a no-op, not an error', async () => {
    const { s } = store();
    expect(await s.forget('https://never.test')).toEqual({ ok: true, forgot: false });
  });

  test('forget all reports what it actually forgot', async () => {
    const { s, c } = store();
    await s.observe({ origin: 'https://a.test', responseAtMs: c.at(), status: 429, retryAfter: '600' });
    await s.observe({ origin: 'https://b.test', responseAtMs: c.at(), status: 429, retryAfter: '600' });
    expect(await s.forgetAll()).toEqual({ ok: true, forgot: 2 });
  });

  test('the two closures the dispatcher gets can never lower a rule', async () => {
    // The dispatcher is handed exactly peek + reserve. Neither may weaken a
    // rule, however many times a turn calls them - that is the whole reason a
    // ceilinged origin cannot be worn down by retrying.
    const { s, c } = store();
    await s.observe({ origin: ORIGIN, responseAtMs: c.at(), status: 429, retryAfter: '1' });
    const before = (await s.list())[0];
    for (let i = 0; i < 5; i += 1) {
      s.peek(ORIGIN, { isWrite: true });
      await s.reserve(ORIGIN, { isWrite: true });
    }
    const after = (await s.list())[0];
    expect(after.minIntervalMs).toBeGreaterThanOrEqual(before.minIntervalMs);
  });
});

describe('list', () => {
  test('rows carry what the settings page renders, newest refusal first', async () => {
    const { s, c } = store();
    await s.observe({ origin: 'https://old.test', responseAtMs: c.at(), status: 429, retryAfter: '600' });
    c.advance(1_000);
    await s.observe({ origin: 'https://new.test', responseAtMs: c.at(), status: 429, retryAfter: '600' });
    const rows = await s.list();
    expect(rows.map((r) => r.origin)).toEqual(['https://new.test', 'https://old.test']);
    expect(rows[0]).toMatchObject({ notBeforeSource: 'retry-after-seconds', observations: 1 });
  });

  test('a rule that decayed into irrelevance drops out of the list', async () => {
    const { s, c } = store();
    await s.observe({ origin: ORIGIN, responseAtMs: c.at(), status: 429 });
    expect((await s.list())).toHaveLength(1);
    c.advance(30 * 60_000 * 12);
    expect(await s.list()).toEqual([]);
  });
});
