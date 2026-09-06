import { describe, expect, test } from 'bun:test';
import { makeBoundedModuleLoader } from '../../extension/shared/bounded-module-load.js';

describe('bounded module load', () => {
  test('times out callers without duplicating the pending module evaluation', async () => {
    let resolve!: (value: { ready: true }) => void;
    let loads = 0;
    const pending = new Promise<{ ready: true }>((done) => { resolve = done; });
    const load = makeBoundedModuleLoader(() => {
      loads += 1;
      return pending;
    }, { timeoutMs: 2 });

    await expect(load()).rejects.toMatchObject({
      code: 'module-load-timeout',
      outcomeKnown: true,
      retryable: true,
      phase: 'startup',
    });
    await expect(load()).rejects.toMatchObject({
      code: 'module-load-timeout',
      outcomeKnown: true,
    });
    expect(loads).toBe(1);

    resolve({ ready: true });
    expect(await load()).toEqual({ ready: true });
    expect(loads).toBe(1);
  });

  test('clears a rejected evaluation for one bounded retry', async () => {
    let loads = 0;
    const load = makeBoundedModuleLoader(async () => {
      loads += 1;
      if (loads === 1) throw new Error('transient');
      return { ready: true };
    });

    await expect(load()).rejects.toMatchObject({
      code: 'module-load-failed',
      outcomeKnown: true,
      retryable: true,
      phase: 'startup',
    });
    expect(await load()).toEqual({ ready: true });
    expect(loads).toBe(2);
  });

});
