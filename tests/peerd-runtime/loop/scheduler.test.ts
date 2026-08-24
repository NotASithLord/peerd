// The background Routine runner (loop/scheduler.js). Pins the control loop with
// fakes (no real model / Chrome): add/remove/setEnabled, the durable kv mirror,
// alarm arming, and — the heart of the feature — tick() as a catch-up pass that
// fires due routines, defers while the vault is locked, collapses missed slots,
// caps concurrency, skips still-running routines, and enforces the count cap.

import { describe, it, expect } from 'bun:test';
import {
  makeScheduler, SCHEDULE_ROUTINES_KEY, MAX_ROUTINES, MAX_FIRINGS_PER_TICK, LOCKED_BACKOFF_MS,
} from '../../../extension/peerd-runtime/loop/scheduler.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Yield to the event loop until `pred` holds (fire-and-forget firings settle). */
const settle = async (pred: () => boolean, tries = 200) => {
  for (let i = 0; i < tries && !pred(); i++) await new Promise((r) => setTimeout(r, 0));
};

function makeHarness(opts: {
  locked?: boolean,
  fireRoutine?: (routine: any) => Promise<any>,
} = {}) {
  let clock = 1_000_000;
  let locked = opts.locked ?? false;
  const store = new Map<string, any>();
  const fired: any[] = [];
  const alarms: (number | null)[] = [];
  const events: any[] = [];
  const running = new Set<string>();          // routineIds whose prior run is "still going"
  let idSeq = 0;
  let failWrites = false;

  const scheduler = makeScheduler({
    fireRoutine: opts.fireRoutine ?? (async (routine: any) => {
      fired.push(routine); return { sessionId: `sess-${routine.id}` };
    }),
    kv: {
      get: async (k: string) => structuredClone(store.get(k)),
      set: async (k: string, v: any) => {
        if (failWrites) throw new Error('storage unavailable');
        store.set(k, structuredClone(v));
      },
    },
    isLocked: () => locked,
    isRunning: (routine: any) => running.has(routine.id),
    setAlarm: (when: number | null) => { alarms.push(when); },
    onEvent: (event: any) => { events.push(event); },
    now: () => clock,
    makeId: () => `r${++idSeq}`,
  });

  return {
    scheduler, store, fired, alarms, events, running,
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    lock: () => { locked = true; },
    unlock: () => { locked = false; },
    failWrites: (value = true) => { failWrites = value; },
    stored: () => store.get(SCHEDULE_ROUTINES_KEY) ?? {},
  };
}

describe('makeScheduler — registration', () => {
  it('adds a routine, computes its next run, persists it, and arms the alarm', () => {
    const h = makeHarness();
    const res = h.scheduler.add({ prompt: 'do a thing', every: '1h' });
    expect(res.ok).toBe(true);
    const r = (res as any).routine;
    expect(r.mode).toBe('goal');
    expect(r.nextRunAt).toBe(h.now() + HOUR);
    expect(h.stored()[r.id].prompt).toBe('do a thing');
    expect(h.alarms.at(-1)).toBe(h.now() + HOUR);
  });

  it('honors mode: "turn" and rejects bad input', () => {
    const h = makeHarness();
    expect((h.scheduler.add({ prompt: 'x', every: '1h', mode: 'turn' }) as any).routine.mode).toBe('turn');
    expect(h.scheduler.add({ prompt: '  ', every: '1h' }).ok).toBe(false);
    expect(h.scheduler.add({ prompt: 'x', every: 'whenever' }).ok).toBe(false);
  });

  it('enforces the routine count cap', () => {
    const h = makeHarness();
    for (let i = 0; i < MAX_ROUTINES; i++) expect(h.scheduler.add({ prompt: `r${i}`, every: '1h' }).ok).toBe(true);
    const over = h.scheduler.add({ prompt: 'one too many', every: '1h' });
    expect(over.ok).toBe(false);
    expect((over as any).error).toBe('too-many-routines');
    expect(h.scheduler.list()).toHaveLength(MAX_ROUTINES);
  });

  it('removes a routine and clears the alarm when none remain', () => {
    const h = makeHarness();
    const r = (h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    expect(h.scheduler.remove(r.id)).toBe(true);
    expect(h.scheduler.list()).toHaveLength(0);
    expect(h.alarms.at(-1)).toBeNull();
    expect(h.scheduler.remove('nope')).toBe(false);
  });
});

describe('makeScheduler — tick fires due routines', () => {
  it('fires a due routine, advances it, and records the session', async () => {
    const h = makeHarness();
    const r = (h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    h.advance(HOUR + MIN);
    const out = await h.scheduler.tick();
    expect(out.fired).toBe(1);
    expect(h.fired.map((f) => f.id)).toEqual([r.id]);
    const live = h.scheduler.list()[0];
    expect(live.nextRunAt).toBeGreaterThan(h.now());
    expect(live.runCount).toBe(1);
    await settle(() => h.scheduler.list()[0].lastSessionId != null);
    expect(h.scheduler.list()[0].lastSessionId).toBe(`sess-${r.id}`);
  });

  it('does not fire a routine that is not yet due', async () => {
    const h = makeHarness();
    h.scheduler.add({ prompt: 'x', every: '1h' });
    h.advance(30 * MIN);
    expect((await h.scheduler.tick()).fired).toBe(0);
    expect(h.fired).toHaveLength(0);
  });

  it('collapses many missed slots into ONE catch-up fire', async () => {
    const h = makeHarness();
    const r = (h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    h.advance(5 * HOUR + 20 * MIN);
    const out = await h.scheduler.tick();
    expect(out.fired).toBe(1);
    expect(h.scheduler.list()[0].nextRunAt).toBe(r.createdAt + 6 * HOUR);
  });

  it('caps firings per tick — a catch-up storm does not launch everything at once', async () => {
    const h = makeHarness();
    for (let i = 0; i < MAX_FIRINGS_PER_TICK + 2; i++) h.scheduler.add({ prompt: `r${i}`, every: '1h' });
    h.advance(2 * HOUR);          // all due
    const out = await h.scheduler.tick();
    expect(out.fired).toBe(MAX_FIRINGS_PER_TICK);   // throttled, not all N
    expect(h.fired).toHaveLength(MAX_FIRINGS_PER_TICK);
  });

  it('caps firings across the WHOLE tick() call even when a re-tick lands mid-persist', async () => {
    // Regression: the firing cap must bind the whole tick() call, not each
    // re-tick pass. Simulate a concurrent wake (alarm/unlock) arriving during a
    // persist await by re-entering tick() once from kv.set — it should set the
    // re-tick flag (run another pass), NOT reset a per-pass counter and stampede.
    let clock = 1_000_000;
    const store = new Map<string, any>();
    const fired: any[] = [];
    let idSeq = 0;
    let reentered = false;
    /** @type {any} */
    let sched: ReturnType<typeof makeScheduler>;
    sched = makeScheduler({
      fireRoutine: async (r: any) => { fired.push(r); return { sessionId: `s-${r.id}` }; },
      kv: {
        get: async (k: string) => store.get(k),
        set: async (k: string, v: any) => {
          store.set(k, v);
          if (!reentered) { reentered = true; await sched.tick(); } // concurrent wake mid-persist
        },
      },
      now: () => clock,
      makeId: () => `r${++idSeq}`,
    });
    for (let i = 0; i < MAX_FIRINGS_PER_TICK + 3; i++) sched.add({ prompt: `p${i}`, every: '1h' });
    clock += 2 * HOUR;                       // all due
    await sched.tick();
    expect(reentered).toBe(true);            // the re-entrant wake actually happened
    expect(fired.length).toBe(MAX_FIRINGS_PER_TICK);  // still capped for the whole call
  });

  it('skips a routine whose previous run is still going (no pile-up)', async () => {
    const h = makeHarness();
    const r = (h.scheduler.add({ prompt: 'x', every: '1m' }) as any).routine;
    h.running.add(r.id);          // its prior goal run is still active
    h.advance(5 * MIN);
    const out = await h.scheduler.tick();
    expect(out.fired).toBe(0);
    expect(out.skipped).toBe(1);
    expect(h.fired).toHaveLength(0);
    // advanced a slot so it retries next cadence instead of busy-looping
    expect(h.scheduler.list()[0].nextRunAt).toBeGreaterThan(h.now());
  });
});

describe('makeScheduler — vault-locked deferral', () => {
  it('defers firing while locked and arms a BACKOFF alarm (no past-time wake storm)', async () => {
    const h = makeHarness({ locked: true });
    const r = (h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    h.advance(HOUR + MIN);
    const deferred = await h.scheduler.tick();
    expect(deferred).toEqual({ fired: 0, deferred: 1, skipped: 0 });
    expect(h.fired).toHaveLength(0);
    expect(h.scheduler.list()[0].nextRunAt).toBe(r.nextRunAt);   // untouched, still due
    // the alarm was armed for a backoff, NOT the past due time (which would storm)
    expect(h.alarms.at(-1)).toBe(h.now() + LOCKED_BACKOFF_MS);
    // unlock + re-tick → fires
    h.unlock();
    expect((await h.scheduler.tick()).fired).toBe(1);
    expect(h.fired.map((f) => f.id)).toEqual([r.id]);
  });
});

describe('makeScheduler — enable/disable', () => {
  it('a disabled routine never fires; re-enabling re-anchors it forward', async () => {
    const h = makeHarness();
    const r = (h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    expect(h.scheduler.setEnabled(r.id, false)).toBe(true);
    h.advance(3 * HOUR);
    expect((await h.scheduler.tick()).fired).toBe(0);
    h.scheduler.setEnabled(r.id, true);
    expect(h.scheduler.list()[0].nextRunAt).toBeGreaterThan(h.now());
    expect((await h.scheduler.tick()).fired).toBe(0);
  });
});

describe('makeScheduler — durability (load on boot)', () => {
  it('rehydrates routines from the kv mirror and re-arms', async () => {
    const h1 = makeHarness();
    const r = (h1.scheduler.add({ prompt: 'survive me', every: '2h' }) as any).routine;
    const mirror = h1.stored();

    const h2 = makeHarness();
    h2.store.set(SCHEDULE_ROUTINES_KEY, mirror);
    expect((await h2.scheduler.load()).loaded).toBe(1);
    const live = h2.scheduler.list()[0];
    expect(live.id).toBe(r.id);
    expect(live.prompt).toBe('survive me');
    expect(h2.alarms.at(-1)).toBe(live.nextRunAt);
  });

  it('load is idempotent and skips ids already live', async () => {
    const h = makeHarness();
    const r = (h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    h.store.set(SCHEDULE_ROUTINES_KEY, { [r.id]: { ...r } });
    expect((await h.scheduler.load()).loaded).toBe(0);
    expect(h.scheduler.list()).toHaveLength(1);
  });

  it('keeps a pending firing through recycle and reports it outcome-unknown without replay', async () => {
    const h1 = makeHarness();
    const routine = (h1.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    h1.store.set(SCHEDULE_ROUTINES_KEY, {
      [routine.id]: {
        ...routine,
        lastRunAt: routine.nextRunAt,
        nextRunAt: routine.nextRunAt + HOUR,
        runCount: 1,
        pendingRunAt: routine.nextRunAt,
      },
    });
    const h2 = makeHarness();
    h2.store.set(SCHEDULE_ROUTINES_KEY, h1.store.get(SCHEDULE_ROUTINES_KEY));
    expect(await h2.scheduler.load()).toEqual({ loaded: 1 });
    expect(h2.fired).toEqual([]);
    expect(h2.scheduler.list()[0]).toMatchObject({
      pendingRunAt: null,
      lastOutcomeUnknownAt: routine.nextRunAt,
      runCount: 1,
    });
    expect(h2.events).toContainEqual({
      type: 'schedule/outcome-unknown', id: routine.id,
    });
    expect(h2.stored()[routine.id].pendingRunAt).toBeNull();
  });
});

describe('makeScheduler execution custody', () => {
  it('never executes when the pending custody marker is not durable', async () => {
    const calls: string[] = [];
    const h = makeHarness({ fireRoutine: async (routine) => { calls.push(routine.id); } });
    h.scheduler.add({ prompt: 'x', every: '1h' });
    h.advance(HOUR + MIN);
    h.failWrites();
    expect(await h.scheduler.tick()).toMatchObject({ fired: 0 });
    expect(calls).toEqual([]);
    expect(h.scheduler.list()[0]).toMatchObject({
      runCount: 0,
      lastRunAt: null,
      pendingRunAt: null,
      nextRunAt: h.now() + LOCKED_BACKOFF_MS,
    });
    expect(h.events).toContainEqual({
      type: 'schedule/retry', id: 'r1', code: 'schedule-storage-unavailable',
    });
  });

  it('keeps tick pending until bounded execution admission settles', async () => {
    let release = (_value: any) => {};
    const admitted = new Promise((resolve) => { release = resolve; });
    const h = makeHarness({ fireRoutine: async () => admitted });
    h.scheduler.add({ prompt: 'x', every: '1h' });
    h.advance(HOUR + MIN);
    let settled = false;
    const ticking = h.scheduler.tick().then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(h.scheduler.list()[0].pendingRunAt).toBe(h.now());
    release({ sessionId: 'scheduled-session' });
    expect(await ticking).toMatchObject({ fired: 1 });
    expect(h.scheduler.list()[0]).toMatchObject({
      pendingRunAt: null, lastSessionId: 'scheduled-session',
    });
  });

  it('retries only a known pre-commit refusal without consuming the cadence slot', async () => {
    const refusal = Object.assign(new Error('host did not accept custody'), {
      code: 'controller-host-missing', outcomeKnown: true,
    });
    const h = makeHarness({ fireRoutine: async () => { throw refusal; } });
    h.scheduler.add({ prompt: 'x', every: '1h' });
    h.advance(HOUR + MIN);
    await h.scheduler.tick();
    expect(h.scheduler.list()[0]).toMatchObject({
      runCount: 0,
      lastRunAt: null,
      pendingRunAt: null,
      lastOutcomeUnknownAt: null,
      nextRunAt: h.now() + LOCKED_BACKOFF_MS,
    });
    expect(h.events).toContainEqual({
      type: 'schedule/retry', id: 'r1', code: 'controller-host-missing',
    });
  });

  it('never replays a post-commit loss and makes the unknown outcome durable', async () => {
    const loss = Object.assign(new Error('channel lost after commit'), {
      code: 'controller-channel-lost', outcomeKnown: false,
    });
    const h = makeHarness({ fireRoutine: async () => { throw loss; } });
    h.scheduler.add({ prompt: 'x', every: '1h' });
    h.advance(HOUR + MIN);
    await h.scheduler.tick();
    const routine = h.scheduler.list()[0];
    expect(routine).toMatchObject({
      runCount: 1,
      pendingRunAt: null,
      lastOutcomeUnknownAt: h.now(),
    });
    expect(routine.nextRunAt).toBeGreaterThan(h.now());
    expect(h.events).toContainEqual({ type: 'schedule/outcome-unknown', id: 'r1' });
    expect(h.stored()[routine.id].lastOutcomeUnknownAt).toBe(h.now());
  });

  it('retains the pending marker when result persistence fails after host custody', async () => {
    let h: ReturnType<typeof makeHarness>;
    h = makeHarness({ fireRoutine: async () => {
      h.failWrites();
      return { sessionId: 'committed-session' };
    } });
    h.scheduler.add({ prompt: 'x', every: '1h' });
    h.advance(HOUR + MIN);
    await expect(h.scheduler.tick()).rejects.toThrow('storage unavailable');
    const stored = h.stored().r1;
    expect(stored.pendingRunAt).toBe(h.now());
    expect(stored.lastSessionId).toBeNull();

    const recovered = makeHarness();
    recovered.store.set(SCHEDULE_ROUTINES_KEY, structuredClone(h.stored()));
    await recovered.scheduler.load();
    expect(recovered.fired).toEqual([]);
    expect(recovered.scheduler.list()[0]).toMatchObject({
      pendingRunAt: null,
      lastOutcomeUnknownAt: h.now(),
    });
  });

  it('releases every concurrent firing when result persistence fails', async () => {
    let h: ReturnType<typeof makeHarness>;
    const fired: string[] = [];
    h = makeHarness({ fireRoutine: async (routine) => {
      fired.push(routine.id);
      if (fired.length <= 2) h.failWrites();
      return { sessionId: `session-${routine.id}` };
    } });
    h.scheduler.add({ prompt: 'one', every: '1h' });
    h.scheduler.add({ prompt: 'two', every: '1h' });
    h.advance(HOUR + MIN);
    await expect(h.scheduler.tick()).rejects.toThrow('storage unavailable');

    h.failWrites(false);
    h.advance(HOUR);
    await h.scheduler.tick();
    expect(fired).toEqual(['r1', 'r2', 'r1', 'r2']);
  });
});
