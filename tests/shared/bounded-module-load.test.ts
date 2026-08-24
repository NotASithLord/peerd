import { describe, expect, test } from 'bun:test';
import { makeRetryableLazy } from '../../extension/background/service-worker-control-plane.js';
import { makeLazyFirefoxActorControl } from '../../extension/background/service-worker-control-plane.js';
import {
  isActorHostStartupFailure, runActorWithStartupRetry,
} from '../../extension/background/actor-startup-retry.js';
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

  test('bounds the cold control-plane loader without duplicate evaluation', async () => {
    let resolve!: (value: { ready: true }) => void;
    let loads = 0;
    const pending = new Promise<{ ready: true }>((done) => { resolve = done; });
    const load = makeRetryableLazy(() => {
      loads += 1;
      return pending;
    }, 2);

    await expect(load()).rejects.toMatchObject({
      code: 'module-load-timeout', outcomeKnown: true, retryable: true, phase: 'startup',
    });
    await expect(load()).rejects.toMatchObject({ code: 'module-load-timeout' });
    expect(loads).toBe(1);
    resolve({ ready: true });
    expect(await load()).toEqual({ ready: true });
  });

  test('a frozen Firefox actor host load settles once with a stable refusal', async () => {
    let loads = 0;
    let attempts = 0;
    const control = makeLazyFirefoxActorControl({
      enabled: true,
      browser: { storage: { session: {} } },
      key: 'test', intervalMs: 10, ackTimeoutMs: 10,
      onLost: () => {}, workerUrl: 'worker.js', loadTimeoutMs: 2,
      loadDirectActorHost: () => {
        loads += 1;
        return new Promise(() => {});
      },
    });
    const host = control.directActorHost!;
    host.bindRelayRoutes({});

    const settled = await runActorWithStartupRetry({
      run: () => {
        attempts += 1;
        return host.sendMessage({ type: 'actor/run', job: { runId: 'frozen' } });
      },
      isStartupFailure: isActorHostStartupFailure,
    });

    expect({ loads, attempts }).toEqual({ loads: 1, attempts: 1 });
    expect(settled).toMatchObject({
      exhausted: true,
      result: {
        started: false, phase: 'startup', code: 'actor_host_load_timeout',
        outcomeKnown: true, error: 'Temporarily unavailable. Try again.',
      },
    });
  });

});
