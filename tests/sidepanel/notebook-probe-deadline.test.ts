import { expect, test } from 'bun:test';
import { withNotebookProbeDeadline } from '../../scripts/cdp/notebook-probe-deadline.mjs';

type ProbeStep = <T>(read: () => Promise<T>) => Promise<T>;

test('Notebook host deadline preserves successful values and operation failures', async () => {
  expect(await withNotebookProbeDeadline(async (step: ProbeStep) => step(async () => 42), 100)).toBe(42);
  const error = new Error('actual CDP failure');
  await expect(withNotebookProbeDeadline(async () => { throw error; }, 100)).rejects.toBe(error);
});

test('Notebook host deadline rejects a lost reply and fences late measurement work', async () => {
  let reply!: (value: number) => void;
  let nextMeasurement = false;
  const pending = new Promise<number>((resolve) => { reply = resolve; });
  const probe = withNotebookProbeDeadline(async (step: ProbeStep) => {
    await step(() => pending);
    await step(async () => { nextMeasurement = true; });
  }, 10);
  await expect(probe).rejects.toThrow('Notebook probe exceeded its 10ms host deadline');
  reply(42);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(nextMeasurement).toBe(false);
});
