import { expect, test } from 'bun:test';
import { makeKernelLazyOwner } from '../../extension/background/kernel-lazy-owner.js';

test('a timed-out owner keeps one in-flight construction', async () => {
  let loads = 0;
  let release!: (value: any) => void;
  const pending = new Promise((resolve) => { release = resolve; });
  const load = makeKernelLazyOwner({
    loadTimeoutMs: 1,
    load: async () => { loads += 1; return pending; },
  }, (value) => value);
  await expect(load()).rejects.toMatchObject({
    code: 'kernel-route-owner-timeout', outcomeKnown: true,
    phase: 'startup', retryable: true,
  });
  await expect(load()).rejects.toMatchObject({
    code: 'kernel-route-owner-timeout', outcomeKnown: true,
  });
  expect(loads).toBe(1);
  release({ ready: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await expect(load()).resolves.toMatchObject({ ready: true });
  expect(loads).toBe(1);
});

test('construction failures are explicit startup failures', async () => {
  const load = makeKernelLazyOwner({
    load: async () => { throw new Error('offline'); },
  }, (value) => value);
  await expect(load()).rejects.toMatchObject({
    code: 'kernel-route-owner-load-failed', outcomeKnown: true,
    phase: 'startup', retryable: true,
  });
});
