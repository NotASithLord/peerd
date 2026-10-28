import { expect, test } from 'bun:test';
import { soakOptions, runSoak } from '../../scripts/cdp/dweb-cluster-soak.mjs';

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
    probe: async () => {}, save: async (value: { completed: boolean }) => { receipts.push(value.completed); },
  });
  expect(result.cycles).toBe(61);
  expect(result.elapsedMs).toBe(60_000);
  expect(result.samples).toHaveLength(32);
  expect(result.samples[0].cycle).toBe(30);
  expect(receipts.slice(0, -1).every(value => !value)).toBe(true);
  expect(receipts.at(-1)).toBe(true);
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
