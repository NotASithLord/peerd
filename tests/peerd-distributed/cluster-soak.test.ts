import { expect, test } from 'bun:test';
import { soakOptions, idleBaselineOptions, runSoak } from '../../scripts/cdp/dweb-cluster-soak.mjs';

type Timed = <T>(name: string, operation: () => Promise<T>) => Promise<T>;

test('idle baseline requires real collection and bounds observer overhead and waiting', () => {
  expect(idleBaselineOptions(undefined, false)).toBeNull();
  expect(idleBaselineOptions({ durationMs: 60_000 }, true)).toEqual({ durationMs: 60_000, intervalMs: 30_000 });
  for (const metrics of [false, undefined, 'true']) {
    expect(() => idleBaselineOptions({ durationMs: 60_000 }, metrics)).toThrow('requires resourceMetrics');
  }
  for (const value of [null, { durationMs: 300_001 }, { durationMs: 60_000, intervalMs: 1000 },
    { durationMs: 1000 }, { durationMs: 60_000, skipFailures: true }]) {
    expect(() => idleBaselineOptions(value, true)).toThrow();
  }
});

test('soak is opt-in and rejects unbounded or mistyped configuration', () => {
  expect(soakOptions(undefined)).toBeNull();
  expect(soakOptions({ durationMs: 60_000 })).toEqual({ durationMs: 60_000, intervalMs: 30_000 });
  for (const value of [null, [], {}, { durationMs: '60000' }, { durationMs: Infinity },
    { durationMs: 86_400_001 }, { durationMs: 60_000, intervalMs: 0 },
    { durationMs: 60_000, intervalMs: 60_001 }, { durationMs: 60_000, ignoreFailures: true }]) {
    expect(() => soakOptions(value)).toThrow();
  }
});

test('a slow initial probe cannot certify sustained operation', async () => {
  let clock = 0;
  const starts: number[] = [];
  const result = await runSoak({ options: { durationMs: 60_000, intervalMs: 30_000 },
    now: () => clock, sleep: async (ms: number) => { clock += ms; },
    probe: async () => { starts.push(clock); clock += 70_000; }, save: async () => {},
  });
  expect(starts).toEqual([0, 70_000]);
  expect(result.completed).toBe(true);
  expect(result.cycles).toBe(2);
});

test('all cycles are counted while receipt storage remains bounded', async () => {
  let clock = 0;
  const receipts: boolean[] = [];
  const result = await runSoak({ options: { durationMs: 60_000, intervalMs: 1000 },
    now: () => clock, sleep: async (ms: number) => { clock += ms; },
    probe: async (timed: Timed) => { await timed('fetch', async () => 'not retained'); },
    save: async (value: { completed: boolean }) => { receipts.push(value.completed); },
  });
  expect(result.cycles).toBe(61);
  expect(result.elapsedMs).toBe(60_000);
  expect(result.samples).toHaveLength(32);
  expect(result.samples[0].cycle).toBe(30);
  expect(result.samples.every((sample: { stages: unknown[] }) => sample.stages.length === 1)).toBe(true);
  expect(result.samples[0].stages).toEqual([{ name: 'fetch', ms: 0, ok: true }]);
  expect(receipts.slice(0, -1).every(value => !value)).toBe(true);
  expect(receipts.at(-1)).toBe(true);
});

test('stage timings isolate a slow operation without retaining its returned payload', async () => {
  let clock = 0;
  const result = await runSoak({ options: { durationMs: 60_000, intervalMs: 30_000 },
    now: () => clock, sleep: async (ms: number) => { clock += ms; }, save: async () => {},
    probe: async (timed: Timed) => {
      expect(await timed('mesh', async () => { clock += 3; return 'private topology'; })).toBe('private topology');
      await timed('fetch', async () => { clock += 7000; });
    },
  });
  expect(result.samples[0].probeMs).toBe(7003);
  expect(result.samples[0].stages).toEqual([
    { name: 'mesh', ms: 3, ok: true }, { name: 'fetch', ms: 7000, ok: true },
  ]);
  expect(JSON.stringify(result)).not.toContain('private topology');
});

test('a failed timed stage preserves its duration and stops later work without counting a successful cycle', async () => {
  let clock = 0;
  let receipt: any;
  let later = false;
  const failure = new Error('unavailable');
  await expect(runSoak({ options: { durationMs: 60_000, intervalMs: 1000 },
    now: () => clock, sleep: async () => {}, save: async (value: unknown) => { receipt = structuredClone(value); },
    probe: async (timed: Timed) => {
      await timed('mesh', async () => { clock += 3; });
      await timed('fetch', async () => { clock += 7000; throw failure; });
      later = true;
    },
  })).rejects.toBe(failure);
  expect(later).toBe(false);
  expect(receipt).toMatchObject({ completed: false, cycles: 0, samples: [], failedSample: {
    cycle: 1, elapsedMs: 7003, probeMs: 7003,
    stages: [{ name: 'mesh', ms: 3, ok: true }, { name: 'fetch', ms: 7000, ok: false }],
  } });
});

test('unknown and repeated stage labels cannot grow a receipt', async () => {
  for (const name of ['unbounded label', 'mesh']) {
    let calls = 0;
    await expect(runSoak({ options: { durationMs: 60_000, intervalMs: 1000 },
      now: () => 0, sleep: async () => {}, save: async () => {},
      probe: async (timed: Timed) => {
        await timed('mesh', async () => { calls++; });
        await timed(name, async () => { calls++; });
      },
    })).rejects.toThrow('Invalid soak timing stage');
    expect(calls).toBe(1);
  }
});

test('a failed cycle preserves an incomplete receipt and is never retried into success', async () => {
  let clock = 0;
  let attempts = 0;
  let receipt = '';
  await expect(runSoak({ options: { durationMs: 60_000, intervalMs: 1000 },
    now: () => clock, sleep: async (ms: number) => { clock += ms; },
    probe: async () => { if (++attempts === 3) throw new Error('signed content unavailable'); },
    save: async (value: unknown) => { receipt = JSON.stringify(value); },
  })).rejects.toThrow('signed content unavailable');
  expect(attempts).toBe(3);
  expect(JSON.parse(receipt)).toMatchObject({ completed: false, cycles: 2,
    elapsedMs: 2000, error: 'signed content unavailable' });
});
