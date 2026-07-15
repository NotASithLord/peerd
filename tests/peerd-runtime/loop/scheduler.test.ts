// The background Routine runner (loop/scheduler.js). Pins the control loop with
// fakes (no real model / Chrome): add/remove/setEnabled, the durable kv mirror,
// alarm arming, and — the heart of the feature — tick() as a catch-up pass that
// fires due routines, defers while the vault is locked, and collapses missed
// slots into a single run.

import { describe, it, expect } from 'bun:test';
import {
  makeScheduler, SCHEDULE_ROUTINES_KEY,
} from '../../../extension/peerd-runtime/loop/scheduler.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Yield to the event loop until `pred` holds (fire-and-forget firings settle). */
const settle = async (pred: () => boolean, tries = 200) => {
  for (let i = 0; i < tries && !pred(); i++) await new Promise((r) => setTimeout(r, 0));
};

type Harness = ReturnType<typeof makeHarness>;
function makeHarness(opts: { locked?: boolean } = {}) {
  let clock = 1_000_000;
  let locked = opts.locked ?? false;
  const store = new Map<string, any>();
  const fired: any[] = [];
  const alarms: (number | null)[] = [];
  let idSeq = 0;

  const scheduler = makeScheduler({
    fireRoutine: async (routine: any) => { fired.push(routine); return { sessionId: `sess-${routine.id}` }; },
    kv: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: any) => { store.set(k, v); },
    },
    isLocked: () => locked,
    setAlarm: (when: number | null) => { alarms.push(when); },
    now: () => clock,
    makeId: () => `r${++idSeq}`,
  });

  return {
    scheduler, store, fired, alarms,
    advance: (ms: number) => { clock += ms; },
    setClock: (t: number) => { clock = t; },
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
    expect(r.prompt).toBe('do a thing');
    expect(r.mode).toBe('goal');            // default
    expect(r.nextRunAt).toBe(h.now() + HOUR);
    // durable mirror written
    expect(h.stored()[r.id].prompt).toBe('do a thing');
    // alarm armed for the soonest run
    expect(h.alarms.at(-1)).toBe(h.now() + HOUR);
  });

  it('honors mode: "turn"', () => {
    const h = makeHarness();
    const r = (h.scheduler.add({ prompt: 'x', every: '1h', mode: 'turn' }) as any).routine;
    expect(r.mode).toBe('turn');
  });

  it('rejects an empty prompt or unparseable cadence', () => {
    const h = makeHarness();
    expect(h.scheduler.add({ prompt: '  ', every: '1h' }).ok).toBe(false);
    expect(h.scheduler.add({ prompt: 'x', every: 'whenever' }).ok).toBe(false);
    expect(h.scheduler.add({ prompt: 'x' } as any).ok).toBe(false);
  });

  it('removes a routine and re-arms (clears) the alarm', () => {
    const h = makeHarness();
    const r = (h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    expect(h.scheduler.remove(r.id)).toBe(true);
    expect(h.scheduler.list()).toHaveLength(0);
    expect(h.stored()[r.id]).toBeUndefined();
    expect(h.alarms.at(-1)).toBeNull();     // nothing left → alarm cleared
    expect(h.scheduler.remove('nope')).toBe(false);
  });
});

describe('makeScheduler — tick fires due routines', () => {
  it('fires a due routine, advances its next run, and records the session', async () => {
    const h = makeHarness();
    const r = (h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    h.advance(HOUR + MIN);                  // now past nextRunAt
    const out = await h.scheduler.tick();
    expect(out).toEqual({ fired: 1, deferred: 0 });
    expect(h.fired.map((f) => f.id)).toEqual([r.id]);
    // advanced to the next FUTURE slot (strictly after now)
    const live = h.scheduler.list()[0];
    expect(live.nextRunAt).toBeGreaterThan(h.now());
    expect(live.runCount).toBe(1);
    expect(live.lastRunAt).toBe(h.now());
    await settle(() => h.scheduler.list()[0].lastSessionId != null);
    expect(h.scheduler.list()[0].lastSessionId).toBe(`sess-${r.id}`);
  });

  it('does not fire a routine that is not yet due', async () => {
    const h = makeHarness();
    h.scheduler.add({ prompt: 'x', every: '1h' });
    h.advance(30 * MIN);
    expect(await h.scheduler.tick()).toEqual({ fired: 0, deferred: 0 });
    expect(h.fired).toHaveLength(0);
  });

  it('collapses many missed slots into ONE catch-up fire (browser was off)', async () => {
    const h = makeHarness();
    const r = (h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    h.advance(5 * HOUR + 20 * MIN);         // five+ intervals elapsed while off
    const out = await h.scheduler.tick();
    expect(out.fired).toBe(1);              // ONE run, not five
    expect(h.fired).toHaveLength(1);
    const live = h.scheduler.list()[0];
    expect(live.nextRunAt).toBe(r.createdAt + 6 * HOUR);  // next grid slot ahead
    expect(live.nextRunAt).toBeGreaterThan(h.now());
  });
});

describe('makeScheduler — vault-locked deferral', () => {
  it('defers firing while locked, then fires on the unlock re-tick', async () => {
    const h = makeHarness({ locked: true });
    const r = (h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    h.advance(HOUR + MIN);
    // locked → deferred, nothing fired, routine STILL due (nextRunAt unchanged)
    const deferred = await h.scheduler.tick();
    expect(deferred).toEqual({ fired: 0, deferred: 1 });
    expect(h.fired).toHaveLength(0);
    expect(h.scheduler.list()[0].nextRunAt).toBe(r.nextRunAt);
    // unlock + re-tick → now it fires (the "as soon as peerd is back on" path)
    h.unlock();
    const out = await h.scheduler.tick();
    expect(out.fired).toBe(1);
    expect(h.fired.map((f) => f.id)).toEqual([r.id]);
  });
});

describe('makeScheduler — enable/disable', () => {
  it('a disabled routine never fires; re-enabling re-anchors it forward', async () => {
    const h = makeHarness();
    const r = (h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    expect(h.scheduler.setEnabled(r.id, false)).toBe(true);
    h.advance(3 * HOUR);
    expect(await h.scheduler.tick()).toEqual({ fired: 0, deferred: 0 });
    expect(h.fired).toHaveLength(0);
    // re-enable: next run is computed forward from now (no stale backlog fire)
    h.scheduler.setEnabled(r.id, true);
    const live = h.scheduler.list()[0];
    expect(live.enabled).toBe(true);
    expect(live.nextRunAt).toBeGreaterThan(h.now());
    expect(await h.scheduler.tick()).toEqual({ fired: 0, deferred: 0 });
  });
});

describe('makeScheduler — durability (load on boot)', () => {
  it('rehydrates routines from the kv mirror', async () => {
    const h1 = makeHarness();
    const r = (h1.scheduler.add({ prompt: 'survive me', every: '2h' }) as any).routine;
    const mirror = h1.stored();               // what storage.local would hold

    // Fresh runner (a new SW lifetime) sharing the same store contents.
    const h2 = makeHarness();
    h2.store.set(SCHEDULE_ROUTINES_KEY, mirror);
    const { loaded } = await h2.scheduler.load();
    expect(loaded).toBe(1);
    const live = h2.scheduler.list()[0];
    expect(live.id).toBe(r.id);
    expect(live.prompt).toBe('survive me');
    // load() re-arms the alarm from the rehydrated routine
    expect(h2.alarms.at(-1)).toBe(live.nextRunAt);
  });

  it('load is idempotent and skips ids already live', async () => {
    const h = makeHarness();
    const r = (h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    h.store.set(SCHEDULE_ROUTINES_KEY, { [r.id]: { ...r } });
    expect((await h.scheduler.load()).loaded).toBe(0);   // already in memory
    expect(h.scheduler.list()).toHaveLength(1);
  });
});
