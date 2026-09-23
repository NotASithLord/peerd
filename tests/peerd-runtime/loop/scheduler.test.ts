import { describe, it, expect } from 'bun:test';
import {
  makeScheduler, SCHEDULE_ROUTINES_KEY, MAX_ROUTINES, MAX_FIRINGS_PER_TICK, LOCKED_BACKOFF_MS,
} from '../../../extension/peerd-runtime/loop/scheduler.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

function makeHarness(opts: {
  locked?: boolean,
  fireRoutine?: (routine: any) => Promise<any>,
  beforeRead?: () => void,
  beforeWrite?: (value: any) => void | Promise<void>,
  onEvent?: (event: any) => void,
} = {}) {
  let clock = 1_000_000;
  let locked = opts.locked ?? false;
  const store = new Map<string, any>();
  const fired: any[] = [];
  const alarms: (number | null)[] = [];
  const events: any[] = [];
  const running = new Set<string>();
  let idSeq = 0;
  let failWrites = false;

  const scheduler = makeScheduler({
    fireRoutine: opts.fireRoutine ?? (async (routine: any) => {
      fired.push(routine); return { sessionId: `sess-${routine.id}` };
    }),
    kv: {
      get: async (k: string) => { opts.beforeRead?.(); return structuredClone(store.get(k)); },
      set: async (k: string, v: any) => {
        await opts.beforeWrite?.(v);
        if (failWrites) throw new Error('storage unavailable');
        store.set(k, structuredClone(v));
      },
    },
    isLocked: () => locked,
    isRunning: (routine: any) => running.has(routine.id),
    setAlarm: (when: number | null) => { alarms.push(when); },
    onEvent: (event: any) => { events.push(event); opts.onEvent?.(event); },
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

describe('makeScheduler - registration', () => {
  it('a cold cancel waits for hydration and durably removes the stored routine', async () => {
    const original = makeHarness();
    await original.scheduler.add({ prompt: 'existing routine', every: '1h' });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let stored = original.stored();
    const scheduler = makeScheduler({
      fireRoutine: async () => {},
      kv: {
        get: async () => { entered.resolve(); await release.promise; return structuredClone(stored); },
        set: async (_key, value) => { stored = structuredClone(value); },
      },
    });
    let settled = false;
    const cancelling = scheduler.remove('r1').then((result) => { settled = true; return result; });
    await entered.promise;
    expect(settled).toBe(false);
    release.resolve();
    expect(await cancelling).toBe(true);
    expect(scheduler.list()).toEqual([]);
    expect(stored).toEqual({});
  });
  it('a cold list waits for the durable routines before returning', async () => {
    const original = makeHarness();
    await original.scheduler.add({ prompt: 'existing routine', every: '1h' });
    const entered = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const scheduler = makeScheduler({
      fireRoutine: async () => {},
      kv: {
        get: async () => {
          entered.resolve();
          await releaseRead.promise;
          return original.stored();
        },
        set: async () => {},
      },
    });
    let returned = false;
    const listing = scheduler.listReady().then((routines) => {
      returned = true;
      return routines;
    });
    await entered.promise;
    expect(returned).toBe(false);
    releaseRead.resolve();
    expect(await listing).toMatchObject([{ prompt: 'existing routine' }]);
  });

  it('adds a routine, computes its next run, persists it, and arms the alarm', async () => {
    const h = makeHarness();
    const res = await h.scheduler.add({ prompt: 'do a thing', every: '1h' });
    expect(res.ok).toBe(true);
    const r = (res as any).routine;
    expect(r.mode).toBe('goal');
    expect(r.nextRunAt).toBe(h.now() + HOUR);
    expect(h.stored()[r.id].prompt).toBe('do a thing');
    expect(h.alarms.at(-1)).toBe(h.now() + HOUR);
  });

  it('honors mode: "turn" and rejects bad input', async () => {
    const h = makeHarness();
    expect((await h.scheduler.add({ prompt: 'x', every: '1h', mode: 'turn' }) as any).routine.mode).toBe('turn');
    expect((await h.scheduler.add({ prompt: '  ', every: '1h' })).ok).toBe(false);
    expect((await h.scheduler.add({ prompt: 'x', every: 'whenever' })).ok).toBe(false);
  });

  it('loads stored routines before enforcing the count cap', async () => {
    const h = makeHarness();
    for (let i = 0; i < MAX_ROUTINES; i++) expect((await h.scheduler.add({ prompt: `r${i}`, every: '1h' })).ok).toBe(true);
    const reboot = makeHarness();
    reboot.store.set(SCHEDULE_ROUTINES_KEY, h.stored());
    const over = await reboot.scheduler.add({ prompt: 'one too many', every: '1h' });
    expect(over.ok).toBe(false);
    expect((over as any).error).toBe('too-many-routines');
    expect(reboot.scheduler.list()).toHaveLength(MAX_ROUTINES);
    expect(reboot.stored()).toEqual(h.stored());
  });

  it('removes a routine and clears the alarm when none remain', async () => {
    const h = makeHarness();
    const r = (await h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    const reboot = makeHarness();
    reboot.store.set(SCHEDULE_ROUTINES_KEY, h.stored());
    expect(await reboot.scheduler.remove(r.id)).toBe(true);
    expect(reboot.scheduler.list()).toHaveLength(0);
    expect(reboot.alarms.at(-1)).toBeNull();
    expect(await reboot.scheduler.remove('nope')).toBe(false);
  });

  it('does not publish a routine until its durable write succeeds', async () => {
    const h = makeHarness();
    h.failWrites();
    await expect(h.scheduler.add({ prompt: 'not durable', every: '1h' }))
      .rejects.toMatchObject({ outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: true });
    expect(h.scheduler.list()).toEqual([]);
    expect(h.stored()).toEqual({});
    expect(h.alarms).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('serializes writes and excludes a failed add from the next snapshot', async () => {
    const firstWrite = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const opts: NonNullable<Parameters<typeof makeHarness>[0]> = { beforeWrite: async (snapshot) => {
      opts.beforeWrite = undefined;
      entered.resolve();
      await firstWrite.promise;
      expect(Object.keys(snapshot)).toEqual(['r1']);
      throw new Error('first write failed');
    } };
    const h = makeHarness(opts);
    const first = h.scheduler.add({ prompt: 'first', every: '1h' }).catch((cause) => cause);
    await entered.promise;
    const second = h.scheduler.add({ prompt: 'second', every: '1h' });
    firstWrite.resolve();
    expect(await first).toMatchObject({ message: 'first write failed' });
    await second;
    expect(Object.keys(h.stored())).toEqual(['r2']);
    expect(h.scheduler.list().map((r) => r.id)).toEqual(['r2']);
  });

  it('restores a routine when durable removal fails', async () => {
    const h = makeHarness();
    const routine = (await h.scheduler.add({ prompt: 'keep me', every: '1h' }) as any).routine;
    const durable = structuredClone(h.stored());
    const alarmsBefore = [...h.alarms];
    const eventsBefore = [...h.events];
    h.failWrites();
    await expect(h.scheduler.remove(routine.id))
      .rejects.toMatchObject({ outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: true });
    expect(h.scheduler.list().map((entry) => entry.id)).toEqual([routine.id]);
    expect(h.stored()).toEqual(durable);
    expect(h.alarms).toEqual(alarmsBefore);
    expect(h.events).toEqual(eventsBefore);
  });
});

describe('makeScheduler - tick fires due routines', () => {
  it('waits until due, collapses missed slots, and dispatches before its event', async () => {
    let firedBeforeEvent = false;
    const h = makeHarness({ onEvent: (event) => {
      if (event.type === 'schedule/firing') firedBeforeEvent = h.fired.length === 1;
    } });
    const r = (await h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    h.advance(30 * MIN);
    expect((await h.scheduler.tick()).fired).toBe(0);
    expect(h.fired).toEqual([]);
    h.advance(5 * HOUR - 10 * MIN);
    expect((await h.scheduler.tick()).fired).toBe(1);
    expect(h.fired.map((f) => f.id)).toEqual([r.id]);
    expect(firedBeforeEvent).toBe(true);
    expect(h.scheduler.list()[0]).toMatchObject({
      nextRunAt: r.createdAt + 6 * HOUR, runCount: 1, lastSessionId: `sess-${r.id}`,
    });
  });

  it.each([false, true])('caps firings across the full tick with a concurrent wake: %s', async (reenter) => {
    const opts: NonNullable<Parameters<typeof makeHarness>[0]> = {};
    const h = makeHarness(opts);
    for (let i = 0; i < MAX_FIRINGS_PER_TICK + 3; i++) await h.scheduler.add({ prompt: `p${i}`, every: '1h' });
    let reentered = false;
    opts.beforeWrite = async () => {
      if (reenter && !reentered) { reentered = true; await h.scheduler.tick(); }
    };
    h.advance(2 * HOUR);
    expect((await h.scheduler.tick()).fired).toBe(MAX_FIRINGS_PER_TICK);
    expect(reentered).toBe(reenter);
    expect(h.fired).toHaveLength(MAX_FIRINGS_PER_TICK);
  });

  it('skips a routine whose previous run is still going (no pile-up)', async () => {
    const h = makeHarness();
    const r = (await h.scheduler.add({ prompt: 'x', every: '1m' }) as any).routine;
    h.running.add(r.id);
    h.advance(5 * MIN);
    const out = await h.scheduler.tick();
    expect(out.fired).toBe(0);
    expect(out.skipped).toBe(1);
    expect(h.fired).toHaveLength(0);
    expect(h.scheduler.list()[0].nextRunAt).toBeGreaterThan(h.now());
  });
});

describe('makeScheduler - vault-locked deferral', () => {
  it('defers firing while locked and arms a BACKOFF alarm (no past-time wake storm)', async () => {
    const h = makeHarness({ locked: true });
    const r = (await h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    h.advance(HOUR + MIN);
    const deferred = await h.scheduler.tick();
    expect(deferred).toEqual({ fired: 0, deferred: 1, skipped: 0 });
    expect(h.fired).toHaveLength(0);
    expect(h.scheduler.list()[0].nextRunAt).toBe(r.nextRunAt);
    expect(h.alarms.at(-1)).toBe(h.now() + LOCKED_BACKOFF_MS);
    h.unlock();
    expect((await h.scheduler.tick()).fired).toBe(1);
    expect(h.fired.map((f) => f.id)).toEqual([r.id]);
  });
});

describe('makeScheduler - enable/disable', () => {
  it('a disabled routine never fires; re-enabling re-anchors it forward', async () => {
    const h = makeHarness();
    const r = (await h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    expect(h.scheduler.setEnabled(r.id, false)).toBe(true);
    h.advance(3 * HOUR);
    expect((await h.scheduler.tick()).fired).toBe(0);
    h.scheduler.setEnabled(r.id, true);
    expect(h.scheduler.list()[0].nextRunAt).toBeGreaterThan(h.now());
    expect((await h.scheduler.tick()).fired).toBe(0);
  });
});

describe('makeScheduler - durability (load on boot)', () => {
  it('rehydrates routines from the kv mirror and re-arms', async () => {
    const h1 = makeHarness();
    const r = (await h1.scheduler.add({ prompt: 'survive me', every: '2h' }) as any).routine;
    const mirror = h1.stored();

    const h2 = makeHarness();
    h2.store.set(SCHEDULE_ROUTINES_KEY, mirror);
    expect((await h2.scheduler.load()).loaded).toBe(1);
    const live = h2.scheduler.list()[0];
    expect(live.id).toBe(r.id);
    expect(live.prompt).toBe('survive me');
    expect(h2.alarms.at(-1)).toBe(live.nextRunAt);
  });

  it('retries a failed cold read before an add can overwrite stored routines', async () => {
    const source = makeHarness();
    const routine = (await source.scheduler.add({ prompt: 'stored', every: '1h' }) as any).routine;
    const opts = { beforeRead: () => { throw new Error('read failed'); } } as NonNullable<Parameters<typeof makeHarness>[0]>;
    const h = makeHarness(opts);
    h.store.set(SCHEDULE_ROUTINES_KEY, { old: { ...routine, id: 'old' } });
    await expect(h.scheduler.add({ prompt: 'new', every: '1h' })).rejects.toThrow('read failed');
    expect(Object.keys(h.stored())).toEqual(['old']);
    opts.beforeRead = undefined;
    await h.scheduler.add({ prompt: 'new', every: '1h' });
    expect(Object.keys(h.stored())).toEqual(['old', 'r1']);
  });

  it('load is idempotent and skips ids already live', async () => {
    const h = makeHarness();
    const r = (await h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    h.store.set(SCHEDULE_ROUTINES_KEY, { [r.id]: { ...r } });
    expect((await h.scheduler.load()).loaded).toBe(0);
    expect(h.scheduler.list()).toHaveLength(1);
  });

  it('keeps a pending firing through recycle and reports it outcome-unknown without replay', async () => {
    const h1 = makeHarness();
    const routine = (await h1.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
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
    await h.scheduler.add({ prompt: 'x', every: '1h' });
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

  it.each(['remove', 'disable', 'enable-again', 'lock', 'running'])('cancels before dispatch after %s during the pending write', async (action) => {
    const opts: NonNullable<Parameters<typeof makeHarness>[0]> = {};
    const h = makeHarness(opts);
    const routine = (await h.scheduler.add({ prompt: 'x', every: '1h' }) as any).routine;
    const dueAt = routine.nextRunAt;
    let removal: Promise<boolean> | undefined;
    opts.beforeWrite = async (snapshot) => {
      opts.beforeWrite = undefined;
      if (action === 'remove') removal = h.scheduler.remove(routine.id);
      if (action === 'disable' || action === 'enable-again') h.scheduler.setEnabled(routine.id, false);
      if (action === 'enable-again') h.scheduler.setEnabled(routine.id, true);
      if (action === 'lock') h.lock();
      if (action === 'running') h.running.add(routine.id);
      expect(snapshot.r1).toMatchObject({ enabled: true, pendingRunAt: h.now() });
    };
    h.advance(HOUR + MIN);
    expect((await h.scheduler.tick()).fired).toBe(0);
    await removal;
    expect(h.fired).toEqual([]);
    if (action === 'remove') expect(h.stored()).toEqual({});
    else expect(h.stored().r1).toMatchObject({ pendingRunAt: null, runCount: 0, lastRunAt: null });
    if (action === 'lock') {
      expect(h.stored().r1.nextRunAt).toBe(dueAt);
      h.unlock();
      expect((await h.scheduler.tick()).fired).toBe(1);
    } else expect((await h.scheduler.tick()).fired).toBe(0);
  });

  it('keeps tick pending until bounded execution admission settles', async () => {
    let release = (_value: any) => {};
    const admitted = new Promise((resolve) => { release = resolve; });
    const h = makeHarness({ fireRoutine: async () => admitted });
    await h.scheduler.add({ prompt: 'x', every: '1h' });
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

  it.each([true, false])('retries a refusal only when its outcome is known: %s', async (outcomeKnown) => {
    const code = outcomeKnown ? 'controller-host-missing' : 'controller-channel-lost';
    const h = makeHarness({ fireRoutine: async () => { throw Object.assign(new Error(code), { code, outcomeKnown }); } });
    await h.scheduler.add({ prompt: 'x', every: '1h' });
    h.advance(HOUR + MIN);
    await h.scheduler.tick();
    const routine = h.scheduler.list()[0];
    expect(routine).toMatchObject({
      runCount: outcomeKnown ? 0 : 1, pendingRunAt: null,
      lastRunAt: outcomeKnown ? null : h.now(),
      lastOutcomeUnknownAt: outcomeKnown ? null : h.now(),
    });
    expect(routine.nextRunAt).toBeGreaterThan(h.now());
    if (outcomeKnown) expect(routine.nextRunAt).toBe(h.now() + LOCKED_BACKOFF_MS);
    expect(h.events).toContainEqual(outcomeKnown
      ? { type: 'schedule/retry', id: 'r1', code }
      : { type: 'schedule/outcome-unknown', id: 'r1' });
    expect(h.stored().r1).toEqual(routine);
  });

  it.each([1, 2])('keeps %i pending markers after a result-write failure and releases every firing', async (count) => {
    const fired: string[] = [];
    const h = makeHarness({ fireRoutine: async (routine) => {
      fired.push(routine.id);
      if (fired.length === count) h.failWrites();
      return { sessionId: `session-${routine.id}` };
    } });
    for (let i = 0; i < count; i++) await h.scheduler.add({ prompt: `routine ${i}`, every: '1h' });
    h.advance(HOUR + MIN);
    await expect(h.scheduler.tick()).rejects.toThrow('storage unavailable');
    for (const record of Object.values(h.stored()) as any[]) {
      expect(record).toMatchObject({ pendingRunAt: h.now(), lastSessionId: null });
    }
    const recovered = makeHarness();
    recovered.store.set(SCHEDULE_ROUTINES_KEY, structuredClone(h.stored()));
    await recovered.scheduler.load();
    expect(recovered.fired).toEqual([]);
    for (const record of recovered.scheduler.list()) {
      expect(record).toMatchObject({ pendingRunAt: null, lastOutcomeUnknownAt: h.now() });
    }
    h.failWrites(false);
    h.advance(HOUR);
    await h.scheduler.tick();
    const ids = recovered.scheduler.list().map((r) => r.id);
    expect(fired).toEqual([...ids, ...ids]);
  });
});
