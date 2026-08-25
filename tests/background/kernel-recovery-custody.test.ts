import { describe, expect, test } from 'bun:test';
import { createKernelRecoveryCustody } from '../../extension/background/kernel-recovery-custody.js';

describe('kernel recovery custody', () => {
  const empty = { 'schedule.routines.v1': {}, 'goal.runs.v1': {} };
  const make = (overrides: Record<string, any> = {}) => {
    let loads = 0;
    const alarms: any[] = [];
    const stored = overrides.stored ?? empty;
    const custody = createKernelRecoveryCustody({
      kv: { get: async (key: string) => stored[key] },
      alarms: overrides.alarmCreate
        ? { create: overrides.alarmCreate }
        : { create: async (...args: any[]) => { alarms.push(args); } },
      dwebActive: () => overrides.dwebActive === true,
      load: overrides.load ?? (async () => { loads += 1; return { loaded: true }; }),
      now: () => 1_000,
    });
    return { custody, alarms, loads: () => loads };
  };

  test('stays cold only when no durable work needs recovery', async () => {
    const { custody, alarms, loads } = make();
    await expect(custody.resume()).resolves.toEqual({ loaded: false });
    expect(loads()).toBe(0);
    expect(alarms).toEqual([]);
  });

  test('loads for routines, active goals, dweb, or uncertain storage', async () => {
    for (const overrides of [
      { stored: { ...empty, 'schedule.routines.v1': { routine: {} } } },
      { stored: { ...empty, 'goal.runs.v1': { session: {} } } },
      { dwebActive: true },
      { stored: new Proxy({}, { get() { throw new Error('storage unavailable'); } }) },
      { stored: { ...empty, 'goal.runs.v1': 'corrupt' } },
      { stored: { ...empty, 'schedule.routines.v1': [] } },
    ]) {
      const { custody, loads } = make(overrides);
      await expect(custody.resume()).resolves.toEqual({ loaded: true });
      expect(loads()).toBe(1);
    }
  });

  test('coalesces every concurrent recovery source', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let loads = 0;
    const { custody } = make({
      stored: { ...empty, 'goal.runs.v1': { session: {} } },
      load: async () => { loads += 1; await held; return { loaded: true }; },
    });
    const startup = custody.resume();
    const alarm = custody.resume();
    const unlock = custody.resume();
    expect(alarm).toBe(startup);
    expect(unlock).toBe(startup);
    await Promise.all([Promise.resolve(), Promise.resolve(), Promise.resolve()]);
    expect(loads).toBe(1);
    release();
    await Promise.all([startup, alarm, unlock]);
  });

  test('re-arms recovery after locked startup and resumes on unlock', async () => {
    let attempt = 0;
    const { custody, alarms } = make({
      stored: { ...empty, 'schedule.routines.v1': { routine: {} } },
      load: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('vault locked');
        return { loaded: true };
      },
    });
    await expect(custody.resume()).rejects.toThrow('vault locked');
    expect(alarms).toEqual([['peerd-schedule', { when: 31_000 }]]);
    await expect(custody.resume()).resolves.toEqual({ loaded: true });
  });

  test('preserves the load failure when retry alarm creation fails', async () => {
    let alarmAttempts = 0;
    const { custody } = make({
      stored: { ...empty, 'goal.runs.v1': { session: {} } },
      load: async () => { throw new Error('runtime unavailable'); },
      alarmCreate: async () => {
        alarmAttempts += 1;
        throw new Error('alarms unavailable');
      },
    });
    await expect(custody.resume()).rejects.toThrow('runtime unavailable');
    expect(alarmAttempts).toBe(1);
  });

  test('bounds retry backoff and resets it after recovery', async () => {
    let shouldFail = true;
    const { custody, alarms } = make({
      stored: { ...empty, 'schedule.routines.v1': { routine: {} } },
      load: async () => {
        if (shouldFail) throw new Error('runtime unavailable');
        return { loaded: true };
      },
    });
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await expect(custody.resume()).rejects.toThrow('runtime unavailable');
    }
    expect(alarms.map(([, info]) => info.when)).toEqual([
      31_000, 61_000, 121_000, 241_000, 301_000, 301_000, 301_000,
    ]);
    shouldFail = false;
    await expect(custody.resume()).resolves.toEqual({ loaded: true });
    shouldFail = true;
    await expect(custody.resume()).rejects.toThrow('runtime unavailable');
    expect(alarms.at(-1)).toEqual(['peerd-schedule', { when: 31_000 }]);
  });
});
