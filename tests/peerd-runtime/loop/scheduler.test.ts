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

const deferred = <T>() => Promise.withResolvers<T>();

const routineRecord = (id: string) => ({
  id, prompt: 'old', schedule: { kind: 'interval' as const, everyMs: HOUR }, mode: 'goal',
  enabled: true, createdAt: 1_000_000, nextRunAt: 1_000_000 + HOUR,
  lastRunAt: null, lastSessionId: null, runCount: 0,
});

function makeHarness(opts: { locked?: boolean; kv?: { get(k: string): Promise<any>; set(k: string, v: any): Promise<void> } } = {}) {
  let clock = 1_000_000;
  let locked = opts.locked ?? false;
  const store = new Map<string, any>();
  const fired: any[] = [];
  const alarms: (number | null)[] = [];
  const events: any[] = [];
  const running = new Set<string>();          // routineIds whose prior run is "still going"
  let idSeq = 0;

  const scheduler = makeScheduler({
    fireRoutine: async (routine: any) => { fired.push(routine); return { sessionId: `sess-${routine.id}` }; },
    kv: opts.kv ?? {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: any) => { store.set(k, v); },
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
    stored: () => store.get(SCHEDULE_ROUTINES_KEY) ?? {},
  };
}

describe('makeScheduler — registration', () => {
  it('adds a routine, computes its next run, persists it, and arms the alarm', async () => {
    const h = makeHarness();
    const res = await h.scheduler.add({ prompt: 'do a thing', every: '1h' });
    expect(res.ok).toBe(true);
    const r = (res as any).routine;
    expect(r.mode).toBe('goal');
    expect(r.nextRunAt).toBe(h.now() + HOUR);
    await settle(() => h.stored()[r.id] != null);
    expect(h.stored()[r.id].prompt).toBe('do a thing');
    expect(h.alarms.at(-1)).toBe(h.now() + HOUR);
  });

  it('honors mode: "turn" and rejects bad input', async () => {
    const h = makeHarness();
    expect(((await h.scheduler.add({ prompt: 'x', every: '1h', mode: 'turn' })) as any).routine.mode).toBe('turn');
    expect((await h.scheduler.add({ prompt: '  ', every: '1h' })).ok).toBe(false);
    expect((await h.scheduler.add({ prompt: 'x', every: 'whenever' })).ok).toBe(false);
  });

  it('enforces the routine count cap', async () => {
    const h = makeHarness();
    for (let i = 0; i < MAX_ROUTINES; i++) expect((await h.scheduler.add({ prompt: `r${i}`, every: '1h' })).ok).toBe(true);
    const over = await h.scheduler.add({ prompt: 'one too many', every: '1h' });
    expect(over.ok).toBe(false);
    expect((over as any).error).toBe('too-many-routines');
    expect(h.scheduler.list()).toHaveLength(MAX_ROUTINES);
  });

  it('hydrates before a cold add enforces the routine cap', async () => {
    const stored = Object.fromEntries(Array.from(
      { length: MAX_ROUTINES }, (_, index) => [`stored-${index}`, routineRecord(`stored-${index}`)],
    ));
    let writes = 0;
    const h = makeHarness({ kv: {
      get: async () => stored,
      set: async () => { writes += 1; },
    } });

    const result = await h.scheduler.add({ prompt: 'one too many', every: '1h' });
    expect(result).toEqual({ ok: false, error: 'too-many-routines' });
    expect(h.scheduler.list()).toHaveLength(MAX_ROUTINES);
    expect(writes).toBe(0);
  });

  it('an abort during cold hydration prevents the add side effects', async () => {
    const releaseRead = deferred<void>();
    const controller = new AbortController();
    let reads = 0;
    let writes = 0;
    const h = makeHarness({ kv: {
      get: async () => { reads += 1; await releaseRead.promise; },
      set: async () => { writes += 1; },
    } });
    const adding = h.scheduler.add({ prompt: 'stopped', every: '1h', signal: controller.signal });
    await settle(() => reads === 1);
    controller.abort();
    releaseRead.resolve();

    expect(await adding).toEqual({ ok: false, error: 'schedule-aborted' });
    expect(h.scheduler.list()).toEqual([]);
    expect(writes).toBe(0);
    expect(h.events).toEqual([]);
    expect(h.alarms.filter((when) => when != null)).toEqual([]);
  });

  it('removes a routine and clears the alarm when none remain', async () => {
    const h = makeHarness();
    const r = ((await h.scheduler.add({ prompt: 'x', every: '1h' })) as any).routine;
    expect(h.scheduler.remove(r.id)).toBe(true);
    expect(h.scheduler.list()).toHaveLength(0);
    expect(h.alarms.at(-1)).toBeNull();
    expect(h.scheduler.remove('nope')).toBe(false);
  });
});

describe('makeScheduler — tick fires due routines', () => {
  it('fires a due routine, advances it, and records the session', async () => {
    const h = makeHarness();
    const r = ((await h.scheduler.add({ prompt: 'x', every: '1h' })) as any).routine;
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
    await h.scheduler.add({ prompt: 'x', every: '1h' });
    h.advance(30 * MIN);
    expect((await h.scheduler.tick()).fired).toBe(0);
    expect(h.fired).toHaveLength(0);
  });

  it('collapses many missed slots into ONE catch-up fire', async () => {
    const h = makeHarness();
    const r = ((await h.scheduler.add({ prompt: 'x', every: '1h' })) as any).routine;
    h.advance(5 * HOUR + 20 * MIN);
    const out = await h.scheduler.tick();
    expect(out.fired).toBe(1);
    expect(h.scheduler.list()[0].nextRunAt).toBe(r.createdAt + 6 * HOUR);
  });

  it('caps firings per tick — a catch-up storm does not launch everything at once', async () => {
    const h = makeHarness();
    for (let i = 0; i < MAX_FIRINGS_PER_TICK + 2; i++) await h.scheduler.add({ prompt: `r${i}`, every: '1h' });
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
    let reentryArmed = false;
    /** @type {any} */
    let sched: ReturnType<typeof makeScheduler>;
    sched = makeScheduler({
      fireRoutine: async (r: any) => { fired.push(r); return { sessionId: `s-${r.id}` }; },
      kv: {
        get: async (k: string) => store.get(k),
        set: async (k: string, v: any) => {
          store.set(k, v);
          if (reentryArmed && !reentered) { reentered = true; await sched.tick(); } // concurrent wake mid-persist
        },
      },
      now: () => clock,
      makeId: () => `r${++idSeq}`,
    });
    for (let i = 0; i < MAX_FIRINGS_PER_TICK + 3; i++) await sched.add({ prompt: `p${i}`, every: '1h' });
    await settle(() => Object.keys(store.get(SCHEDULE_ROUTINES_KEY) ?? {}).length === MAX_FIRINGS_PER_TICK + 3);
    reentryArmed = true;
    clock += 2 * HOUR;                       // all due
    await sched.tick();
    expect(reentered).toBe(true);            // the re-entrant wake actually happened
    expect(fired.length).toBe(MAX_FIRINGS_PER_TICK);  // still capped for the whole call
  });

  it('skips a routine whose previous run is still going (no pile-up)', async () => {
    const h = makeHarness();
    const r = ((await h.scheduler.add({ prompt: 'x', every: '1m' })) as any).routine;
    h.running.add(r.id);          // its prior goal run is still active
    h.advance(5 * MIN);
    const out = await h.scheduler.tick();
    expect(out.fired).toBe(0);
    expect(out.skipped).toBe(1);
    expect(h.fired).toHaveLength(0);
    // advanced a slot so it retries next cadence instead of busy-looping
    expect(h.scheduler.list()[0].nextRunAt).toBeGreaterThan(h.now());
    await settle(() => h.stored()[r.id]?.nextRunAt > h.now());
    expect(h.stored()[r.id].nextRunAt).toBeGreaterThan(h.now());
  });

  it('does not fire or report a routine when its durable advance fails', async () => {
    let writes = 0;
    let stored: any;
    const h = makeHarness({
      kv: {
        get: async () => stored,
        set: async (_key: string, value: any) => {
          writes += 1;
          if (writes === 2) throw new Error('disk full');
          stored = structuredClone(value);
        },
      },
    });
    const routine = ((await h.scheduler.add({ prompt: 'x', every: '1h' })) as any).routine;
    const dueAt = routine.nextRunAt;
    await settle(() => writes === 1);
    h.advance(2 * HOUR);

    await expect(h.scheduler.tick()).rejects.toThrow('disk full');
    expect(h.fired).toEqual([]);
    expect(h.events.some((event) => event.type === 'schedule/firing')).toBe(false);
    expect(h.scheduler.list()[0]).toMatchObject({ nextRunAt: dueAt, lastRunAt: null, runCount: 0 });
    expect(h.alarms.at(-1)).toBe(dueAt);

    await settle(() => writes === 3);
    expect(stored[routine.id]).toMatchObject({ nextRunAt: dueAt, lastRunAt: null, runCount: 0 });
    expect((await h.scheduler.tick()).fired).toBe(1);
    await settle(() => h.fired.length === 1);
    expect(h.fired.map((entry) => entry.id)).toEqual([routine.id]);
  });

  it.each(['remove', 'disable'] as const)('%s during persistence prevents firing', async (action) => {
    let writes = 0;
    const releaseAdvance = deferred<void>();
    const h = makeHarness({
      kv: {
        get: async () => undefined,
        set: async () => {
          writes += 1;
          if (writes === 2) await releaseAdvance.promise;
        },
      },
    });
    const routine = ((await h.scheduler.add({ prompt: 'x', every: '1h' })) as any).routine;
    await settle(() => writes === 1);
    h.advance(2 * HOUR);

    const ticking = h.scheduler.tick();
    await settle(() => writes === 2);
    if (action === 'remove') h.scheduler.remove(routine.id);
    else h.scheduler.setEnabled(routine.id, false);
    releaseAdvance.resolve();

    expect((await ticking).fired).toBe(0);
    await settle(() => writes === 3);
    expect(h.fired).toEqual([]);
  });
});

describe('makeScheduler — vault-locked deferral', () => {
  it('defers firing while locked and arms a BACKOFF alarm (no past-time wake storm)', async () => {
    const h = makeHarness({ locked: true });
    const r = ((await h.scheduler.add({ prompt: 'x', every: '1h' })) as any).routine;
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
    const r = ((await h.scheduler.add({ prompt: 'x', every: '1h' })) as any).routine;
    expect(h.scheduler.setEnabled(r.id, false)).toBe(true);
    h.advance(3 * HOUR);
    expect((await h.scheduler.tick()).fired).toBe(0);
    h.scheduler.setEnabled(r.id, true);
    expect(h.scheduler.list()[0].nextRunAt).toBeGreaterThan(h.now());
    expect((await h.scheduler.tick()).fired).toBe(0);
  });
});

describe('makeScheduler — durability (load on boot)', () => {
  it('serializes mirror writes so an older snapshot cannot restore removed state', async () => {
    const releaseFirst = deferred<void>();
    const completed: number[] = [];
    let calls = 0;
    let stored: any;
    const h = makeHarness({
      kv: {
        get: async () => stored,
        set: async (_key: string, value: any) => {
          const call = ++calls;
          const snapshot = structuredClone(value);
          if (call === 1) await releaseFirst.promise;
          stored = snapshot;
          completed.push(call);
        },
      },
    });
    const routine = ((await h.scheduler.add({ prompt: 'x', every: '1h' })) as any).routine;
    await settle(() => calls === 1);
    h.scheduler.remove(routine.id);
    releaseFirst.resolve();
    await settle(() => completed.length === 2);

    expect(completed).toEqual([1, 2]);
    expect(stored).toEqual({});
  });

  it('keeps local add and remove authoritative across stale IO', async () => {
    const releaseRead = deferred<void>();
    const releaseRemove = deferred<void>();
    let reads = 0;
    let writes = 0;
    let finished = 0;
    let persisted: any;
    const h = makeHarness({
      kv: {
        get: async () => {
          reads += 1;
          await releaseRead.promise;
          return { stale: routineRecord('stale') };
        },
        set: async (_key: string, value: any) => {
          writes += 1;
          if (writes === 1) persisted = structuredClone(value);
          else await releaseRemove.promise;
          finished += 1;
          if (writes === 2) throw new Error('disk full');
        },
      },
    });
    const loading = h.scheduler.load();
    await settle(() => reads === 1);
    const adding = h.scheduler.add({ prompt: 'local', every: '1h' });
    releaseRead.resolve();

    expect((await loading).loaded).toBe(1);
    expect((await adding).ok).toBe(true);
    await settle(() => finished === 1);
    expect(h.scheduler.list().map((routine) => routine.id).sort()).toEqual(['r1', 'stale']);
    expect(Object.keys(persisted).sort()).toEqual(['r1', 'stale']);
    expect(h.scheduler.remove('r1')).toBe(true);
    await settle(() => writes === 2);
    expect((await h.scheduler.load()).loaded).toBe(0);
    expect(h.scheduler.list().map((routine) => routine.id)).toEqual(['stale']);
    releaseRemove.resolve();
    await settle(() => finished === 2);
    expect((await h.scheduler.load()).loaded).toBe(0);
    expect(reads).toBe(1);
  });

  it('rehydrates routines from the kv mirror and re-arms', async () => {
    const h1 = makeHarness();
    const r = ((await h1.scheduler.add({ prompt: 'survive me', every: '2h' })) as any).routine;
    await settle(() => h1.stored()[r.id] != null);
    const mirror = h1.stored();

    let reads = 0;
    const h2 = makeHarness({ kv: {
      get: async () => {
        reads += 1;
        if (reads === 1) throw new Error('read failed');
        return mirror;
      },
      set: async () => {},
    } });
    expect((await h2.scheduler.load()).loaded).toBe(0);
    expect((await h2.scheduler.load()).loaded).toBe(1);
    expect((await h2.scheduler.load()).loaded).toBe(0);
    expect(reads).toBe(2);
    const live = h2.scheduler.list()[0];
    expect(live.id).toBe(r.id);
    expect(live.prompt).toBe('survive me');
    expect(h2.alarms.at(-1)).toBe(live.nextRunAt);
  });

});
