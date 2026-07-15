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

function makeHarness(opts: { locked?: boolean } = {}) {
  let clock = 1_000_000;
  let locked = opts.locked ?? false;
  const store = new Map<string, any>();
  const fired: any[] = [];
  const alarms: (number | null)[] = [];
  const running = new Set<string>();          // routineIds whose prior run is "still going"
  let idSeq = 0;

  const scheduler = makeScheduler({
    fireRoutine: async (routine: any) => { fired.push(routine); return { sessionId: `sess-${routine.id}` }; },
    kv: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: any) => { store.set(k, v); },
    },
    isLocked: () => locked,
    isRunning: (routine: any) => running.has(routine.id),
    setAlarm: (when: number | null) => { alarms.push(when); },
    now: () => clock,
    makeId: () => `r${++idSeq}`,
  });

  return {
    scheduler, store, fired, alarms, running,
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
    lock: () => { locked = true; },
    unlock: () => { locked = false; },
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
});
