import { describe, expect, test } from 'bun:test';
import {
  makeDirectActorHost,
  makeRefCountedFirefoxBackgroundLifetime,
  makeStorageSessionKeepAlive,
} from '../../extension/background/direct-actor-host.js';

describe('shared Firefox event-page lifetime', () => {
  test('one heartbeat spans overlapping actor and lazy module work', async () => {
    let starts = 0;
    let stops = 0;
    let releaseModule = () => {};
    const lifetime = makeRefCountedFirefoxBackgroundLifetime({
      start: () => { starts += 1; },
      stop: () => { stops += 1; },
    });
    const actor = lifetime.createHandle();
    await actor.start();
    const moduleWork = lifetime.run(() => new Promise<string>((resolve) => {
      releaseModule = () => resolve('done');
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lifetime.snapshot()).toEqual({ active: 2, lost: false });
    expect(starts).toBe(1);
    await actor.stop();
    expect(stops).toBe(0);
    releaseModule();
    await expect(moduleWork).resolves.toBe('done');
    expect(stops).toBe(1);
  });

  test('reports replay-safe reads known and dispatched effects unknown on lifetime loss', async () => {
    const lifetime = makeRefCountedFirefoxBackgroundLifetime({
      start: () => {},
      stop: () => {},
    });
    const read = lifetime.run(() => new Promise(() => {}), {
      outcomeKnownOnLoss: true,
      code: 'read-lost',
    });
    const effect = lifetime.run(() => new Promise(() => {}), {
      outcomeKnownOnLoss: false,
      code: 'effect-lost',
    });
    void read.catch(() => {});
    void effect.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    lifetime.fail(new Error('event page heartbeat stopped'));
    const [readResult, effectResult] = await Promise.allSettled([read, effect]);
    expect(readResult).toMatchObject({
      status: 'rejected',
      reason: { code: 'read-lost', outcomeKnown: true, phase: 'run' },
    });
    expect(effectResult).toMatchObject({
      status: 'rejected',
      reason: { code: 'effect-lost', outcomeKnown: false, phase: 'run' },
    });
    expect(lifetime.snapshot()).toEqual({ active: 0, lost: false });
  });

  test('fails known-safe before feature dispatch when heartbeat startup fails', async () => {
    const lifetime = makeRefCountedFirefoxBackgroundLifetime({
      start: () => { throw new Error('storage unavailable'); },
      stop: () => {},
    });
    let ran = false;
    await expect(lifetime.run(async () => { ran = true; })).rejects.toMatchObject({
      code: 'firefox-background-lifetime-startup-failed',
      outcomeKnown: true,
      phase: 'startup',
    });
    expect(ran).toBe(false);
  });
});

describe('Firefox actor host storage.session heartbeat', () => {
  test('changes a session key until the active lease stops', async () => {
    const calls: Array<{ set: { leaseId: string, sequence: number } } | { remove: string }> = [];
    let tick = () => {};
    let cleared = 0;
    let keepAlive: ReturnType<typeof makeStorageSessionKeepAlive>;
    keepAlive = makeStorageSessionKeepAlive({
      key: 'keepalive',
      intervalMs: 10_000,
      ackTimeoutMs: 1_000,
      makeLeaseId: () => 'lease-1',
      storage: {
        set: async (items) => {
          const value = items.keepalive as { leaseId: string, sequence: number };
          calls.push({ set: value });
          queueMicrotask(() => keepAlive.onChanged({ keepalive: { newValue: value } }));
        },
        remove: async (key) => { calls.push({ remove: key }); },
      },
      setIntervalFn: ((callback: () => void) => { tick = callback; return 7; }) as typeof setInterval,
      clearIntervalFn: ((id: number) => { expect(id).toBe(7); cleared += 1; }) as typeof clearInterval,
    });

    await keepAlive.start();
    expect(calls).toEqual([
      { remove: 'keepalive' },
      { set: { leaseId: 'lease-1', sequence: 1 } },
    ]);
    expect(keepAlive.onChanged({ other: { newValue: 1 } })).toBe(false);

    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.at(-1)).toEqual({ set: { leaseId: 'lease-1', sequence: 2 } });

    await keepAlive.stop();
    expect(calls.at(-1)).toEqual({ remove: 'keepalive' });
    expect(cleared).toBe(1);
  });

  test('an active heartbeat failure ends the lease and reports it', async () => {
    let writes = 0;
    let tick = () => {};
    const losses: string[] = [];
    let cleared = 0;
    let keepAlive: ReturnType<typeof makeStorageSessionKeepAlive>;
    keepAlive = makeStorageSessionKeepAlive({
      key: 'keepalive',
      intervalMs: 10_000,
      ackTimeoutMs: 1_000,
      makeLeaseId: () => 'lease-1',
      onLost: (error) => { losses.push(error.message); },
      storage: {
        remove: async () => {},
        set: async (items) => {
          writes += 1;
          if (writes === 2) throw new Error('session storage stopped');
          const value = items.keepalive as { leaseId: string, sequence: number };
          queueMicrotask(() => keepAlive.onChanged({ keepalive: { newValue: value } }));
        },
      },
      setIntervalFn: ((callback: () => void) => { tick = callback; return 7; }) as typeof setInterval,
      clearIntervalFn: (() => { cleared += 1; }) as typeof clearInterval,
    });

    await keepAlive.start();
    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(losses).toEqual(['session storage stopped']);
    expect(cleared).toBe(1);
  });

  test('an unexpected heartbeat generation fails the active lease', async () => {
    const losses: string[] = [];
    let keepAlive: ReturnType<typeof makeStorageSessionKeepAlive>;
    keepAlive = makeStorageSessionKeepAlive({
      key: 'keepalive',
      intervalMs: 10_000,
      ackTimeoutMs: 1_000,
      makeLeaseId: () => 'lease-1',
      onLost: (error) => { losses.push(error.message); },
      storage: {
        remove: async () => {},
        set: async (items) => {
          const value = items.keepalive as { leaseId: string, sequence: number };
          queueMicrotask(() => keepAlive.onChanged({ keepalive: { newValue: value } }));
        },
      },
      setIntervalFn: (() => 7) as unknown as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
    });

    await keepAlive.start();
    expect(keepAlive.onChanged({
      keepalive: { newValue: { leaseId: 'other', sequence: 99 } },
    })).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(losses).toEqual(['actor host storage heartbeat changed unexpectedly']);
  });

  test('ignores a delayed owned deletion from an older lease generation', async () => {
    const losses: string[] = [];
    let nextLease = 0;
    let keepAlive: ReturnType<typeof makeStorageSessionKeepAlive>;
    keepAlive = makeStorageSessionKeepAlive({
      key: 'keepalive',
      intervalMs: 10_000,
      ackTimeoutMs: 1_000,
      makeLeaseId: () => `lease-${nextLease += 1}`,
      onLost: (error) => { losses.push(error.message); },
      storage: {
        remove: async () => {},
        set: async (items) => {
          const value = items.keepalive as { leaseId: string, sequence: number };
          queueMicrotask(() => keepAlive.onChanged({ keepalive: { newValue: value } }));
        },
      },
      setIntervalFn: (() => 7) as unknown as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
    });

    await keepAlive.start();
    await keepAlive.stop();
    await keepAlive.start();
    expect(keepAlive.onChanged({
      keepalive: { oldValue: { leaseId: 'lease-1', sequence: 1 } },
    })).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(losses).toEqual([]);
    expect(keepAlive.onChanged({
      keepalive: { oldValue: { leaseId: 'lease-2', sequence: 1 } },
    })).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(losses).toEqual(['actor host storage heartbeat changed unexpectedly']);
  });

  test('reports a lost lease before best-effort removal finishes', async () => {
    let tick = () => {};
    let removes = 0;
    let finishRemoval = () => {};
    const blockedRemoval = new Promise<void>((resolve) => { finishRemoval = resolve; });
    const losses: string[] = [];
    let writes = 0;
    let keepAlive: ReturnType<typeof makeStorageSessionKeepAlive>;
    keepAlive = makeStorageSessionKeepAlive({
      key: 'keepalive',
      intervalMs: 10_000,
      ackTimeoutMs: 1_000,
      makeLeaseId: () => 'lease-1',
      onLost: (error) => { losses.push(error.message); },
      storage: {
        remove: async () => {
          removes += 1;
          if (removes > 1) await blockedRemoval;
        },
        set: async (items) => {
          writes += 1;
          if (writes === 2) throw new Error('heartbeat failed');
          const value = items.keepalive as { leaseId: string, sequence: number };
          queueMicrotask(() => keepAlive.onChanged({ keepalive: { newValue: value } }));
        },
      },
      setIntervalFn: ((callback: () => void) => { tick = callback; return 7; }) as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
    });

    await keepAlive.start();
    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(losses).toEqual(['heartbeat failed']);
    expect(removes).toBe(2);
    finishRemoval();
  });

  test('waits for a late heartbeat write before removing its generation', async () => {
    let tick = () => {};
    let writes = 0;
    let removes = 0;
    let finishLateWrite = () => {};
    const lateWrite = new Promise<void>((resolve) => { finishLateWrite = resolve; });
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const losses: string[] = [];
    let keepAlive: ReturnType<typeof makeStorageSessionKeepAlive>;
    keepAlive = makeStorageSessionKeepAlive({
      key: 'keepalive',
      intervalMs: 10_000,
      ackTimeoutMs: 1_000,
      makeLeaseId: () => 'lease-1',
      onLost: (error) => { losses.push(error.message); },
      storage: {
        remove: async () => { removes += 1; },
        set: async (items) => {
          writes += 1;
          if (writes === 2) return lateWrite;
          const value = items.keepalive as { leaseId: string, sequence: number };
          queueMicrotask(() => keepAlive.onChanged({ keepalive: { newValue: value } }));
        },
      },
      setIntervalFn: ((callback: () => void) => { tick = callback; return 7; }) as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
      setTimeoutFn: ((callback: () => void) => {
        nextTimer += 1;
        timers.set(nextTimer, callback);
        return nextTimer;
      }) as typeof setTimeout,
      clearTimeoutFn: ((id: number) => { timers.delete(id); }) as typeof clearTimeout,
    });

    await keepAlive.start();
    expect(removes).toBe(1);
    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    timers.get(Math.max(...timers.keys()))?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(losses).toEqual(['actor host storage heartbeat was not acknowledged']);
    expect(removes).toBe(1);

    finishLateWrite();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removes).toBe(2);
  });

  test('a stopped lease ignores a queued heartbeat', async () => {
    let tick = () => {};
    let writes = 0;
    let keepAlive: ReturnType<typeof makeStorageSessionKeepAlive>;
    keepAlive = makeStorageSessionKeepAlive({
      key: 'keepalive',
      intervalMs: 10_000,
      ackTimeoutMs: 1_000,
      makeLeaseId: () => 'lease-1',
      storage: {
        remove: async () => {},
        set: async (items) => {
          writes += 1;
          const value = items.keepalive as { leaseId: string, sequence: number };
          queueMicrotask(() => keepAlive.onChanged({ keepalive: { newValue: value } }));
        },
      },
      setIntervalFn: ((callback: () => void) => { tick = callback; return 7; }) as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
    });

    await keepAlive.start();
    tick();
    await keepAlive.stop();
    expect(writes).toBe(1);
  });

  test('refuses startup when the initial heartbeat event is not acknowledged', async () => {
    const scheduled = new Map<number, () => void>();
    let nextTimer = 0;
    let intervals = 0;
    const keepAlive = makeStorageSessionKeepAlive({
      key: 'keepalive',
      intervalMs: 10_000,
      ackTimeoutMs: 1_000,
      makeLeaseId: () => 'lease-1',
      storage: {
        remove: async () => {},
        set: async () => {},
      },
      setIntervalFn: (() => { intervals += 1; return 7; }) as unknown as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
      setTimeoutFn: ((callback: () => void) => {
        nextTimer += 1;
        scheduled.set(nextTimer, callback);
        return nextTimer;
      }) as typeof setTimeout,
      clearTimeoutFn: ((id: number) => { scheduled.delete(id); }) as typeof clearTimeout,
    });

    const start = keepAlive.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    scheduled.get(Math.max(...scheduled.keys()))?.();
    await expect(start).rejects.toThrow('was not acknowledged');
    expect(intervals).toBe(0);
  });

  test('bounds startup when cold-start heartbeat cleanup never settles', async () => {
    const scheduled = new Map<number, () => void>();
    let nextTimer = 0;
    let writes = 0;
    const keepAlive = makeStorageSessionKeepAlive({
      key: 'keepalive',
      intervalMs: 10_000,
      ackTimeoutMs: 1_000,
      storage: {
        remove: () => new Promise<void>(() => {}),
        set: async () => { writes += 1; },
      },
      setTimeoutFn: ((callback: () => void) => {
        nextTimer += 1;
        scheduled.set(nextTimer, callback);
        return nextTimer;
      }) as typeof setTimeout,
      clearTimeoutFn: ((id: number) => { scheduled.delete(id); }) as typeof clearTimeout,
    });

    const start = keepAlive.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    scheduled.get(Math.max(...scheduled.keys()))?.();

    await expect(start).rejects.toThrow('cleanup is still pending');
    expect(writes).toBe(0);
  });
});

describe('direct actor host', () => {
  test('keeps run and relays in-process behind an object-identity sender', async () => {
    let accepted = false;
    let runJob: any = null;
    const host = makeDirectActorHost({
      workerUrl: 'moz-extension://id/offscreen/actor-worker.js',
      run: async (job: any, deps: any) => {
        runJob = job;
        return deps.sendToSW('actor/model-call', { relayToken: 'grant', args: {} });
      },
      abort: () => {},
    });
    host.bindRelayRoutes({
      'actor/model-call': (_message: any, sender: unknown) => {
        accepted = host.isRelaySender(sender);
        return { ok: true, events: [] };
      },
    });

    const result = await host.sendMessage({ type: 'actor/run', job: { actorSessionId: 'actor-1' } });
    expect(result.ok).toBe(true);
    expect(runJob.actorSessionId).toBe('actor-1');
    expect(accepted).toBe(true);
    expect(host.isRelaySender({})).toBe(false);
  });

  test('refuses a run until relay routes are bound', async () => {
    let ran = false;
    const host = makeDirectActorHost({
      workerUrl: 'worker.js',
      run: async () => { ran = true; return { ok: true }; },
      abort: () => {},
    });
    expect(await host.sendMessage({ type: 'actor/run', job: {} })).toMatchObject({
      ok: false, started: false, code: 'actor_host_not_ready',
    });
    expect(ran).toBe(false);
  });

  test('routes abort directly without exposing a runtime route', async () => {
    const aborted: string[] = [];
    const host = makeDirectActorHost({
      workerUrl: 'worker.js',
      run: async () => ({ ok: true }),
      abort: (runId: string) => { aborted.push(runId); },
    });
    expect(await host.sendMessage({ type: 'actor/abort', runId: 'run-1' })).toEqual({ ok: true });
    expect(aborted).toEqual(['run-1']);
  });

  test('keeps one refcounted event-page lease while any actor run is active', async () => {
    const releases: Array<() => void> = [];
    let starts = 0;
    let stops = 0;
    const host = makeDirectActorHost({
      workerUrl: 'worker.js',
      run: () => new Promise((resolve) => { releases.push(() => resolve({ ok: true })); }),
      abort: () => {},
      startKeepAlive: () => { starts += 1; },
      stopKeepAlive: () => { stops += 1; },
    });
    host.bindRelayRoutes({});

    const first = host.sendMessage({ type: 'actor/run', job: { actorSessionId: 'a' } });
    const second = host.sendMessage({ type: 'actor/run', job: { actorSessionId: 'b' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toBe(1);

    releases[0]();
    await first;
    expect(stops).toBe(0);
    releases[1]();
    await second;
    expect(stops).toBe(1);
  });

  test('fails closed before actor execution when the event-page lease cannot start', async () => {
    let ran = false;
    let stops = 0;
    const host = makeDirectActorHost({
      workerUrl: 'worker.js',
      run: async () => { ran = true; return { ok: true }; },
      abort: () => {},
      startKeepAlive: () => { throw new Error('session storage unavailable'); },
      stopKeepAlive: () => { stops += 1; },
    });
    host.bindRelayRoutes({});

    expect(await host.sendMessage({ type: 'actor/run', job: {} })).toMatchObject({
      ok: false,
      started: false,
      code: 'actor_host_keepalive_failed',
    });
    expect(ran).toBe(false);
    expect(stops).toBe(1);
  });

  test('can start a later lease after a failed lease is cleaned up', async () => {
    let starts = 0;
    let stops = 0;
    let runs = 0;
    const host = makeDirectActorHost({
      workerUrl: 'worker.js',
      run: async () => { runs += 1; return { ok: true }; },
      abort: () => {},
      startKeepAlive: () => {
        starts += 1;
        if (starts === 1) throw new Error('first start failed');
      },
      stopKeepAlive: () => { stops += 1; },
    });
    host.bindRelayRoutes({});

    expect(await host.sendMessage({ type: 'actor/run', job: {} })).toMatchObject({
      ok: false,
      started: false,
      code: 'actor_host_keepalive_failed',
    });
    expect(await host.sendMessage({ type: 'actor/run', job: {} })).toEqual({ ok: true });
    expect({ starts, stops, runs }).toEqual({ starts: 2, stops: 2, runs: 1 });
  });

  test('serializes a new lease after the previous asynchronous clear', async () => {
    const runReleases = new Map<string, () => void>();
    let starts = 0;
    let stops = 0;
    let finishFirstStop = () => {};
    const firstStop = new Promise<void>((resolve) => { finishFirstStop = resolve; });
    const host = makeDirectActorHost({
      workerUrl: 'worker.js',
      run: (job: any) => new Promise((resolve) => {
        runReleases.set(job.actorSessionId, () => resolve({ ok: true }));
      }),
      abort: () => {},
      startKeepAlive: () => { starts += 1; },
      stopKeepAlive: () => {
        stops += 1;
        return stops === 1 ? firstStop : undefined;
      },
    });
    host.bindRelayRoutes({});

    const first = host.sendMessage({ type: 'actor/run', job: { actorSessionId: 'a' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    runReleases.get('a')?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ starts, stops }).toEqual({ starts: 1, stops: 1 });

    const second = host.sendMessage({ type: 'actor/run', job: { actorSessionId: 'b' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toBe(1);
    finishFirstStop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toBe(2);
    runReleases.get('b')?.();

    await Promise.all([first, second]);
    expect(stops).toBe(2);
  });

  test('aborts and reports an unknown outcome if the event-page lease is lost', async () => {
    const aborted: string[] = [];
    const host = makeDirectActorHost({
      workerUrl: 'worker.js',
      run: () => new Promise(() => {}),
      abort: (runId: string) => { aborted.push(runId); },
      startKeepAlive: () => {},
      stopKeepAlive: () => {},
    });
    host.bindRelayRoutes({});

    const result = host.sendMessage({
      type: 'actor/run',
      job: { runId: 'run-lost', actorSessionId: 'actor-lost' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.failKeepAlive(new Error('session heartbeat stopped'));

    expect(await result).toMatchObject({
      ok: false,
      started: true,
      code: 'actor_host_keepalive_lost',
      outcomeKnown: false,
    });
    expect(aborted).toEqual(['run-lost']);
  });

  test('settles unknown without waiting for a stuck heartbeat write or cleanup', async () => {
    let intervalTick = () => {};
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    let writes = 0;
    let host: ReturnType<typeof makeDirectActorHost>;
    let keepAlive: ReturnType<typeof makeStorageSessionKeepAlive>;
    keepAlive = makeStorageSessionKeepAlive({
      key: 'keepalive',
      intervalMs: 10_000,
      ackTimeoutMs: 1_000,
      makeLeaseId: () => 'lease-1',
      onLost: (error) => host.failKeepAlive(error),
      storage: {
        remove: async () => {},
        set: async (items) => {
          writes += 1;
          if (writes === 2) return new Promise<void>(() => {});
          const value = items.keepalive as { leaseId: string, sequence: number };
          queueMicrotask(() => keepAlive.onChanged({ keepalive: { newValue: value } }));
        },
      },
      setIntervalFn: ((callback: () => void) => { intervalTick = callback; return 7; }) as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
      setTimeoutFn: ((callback: () => void) => {
        nextTimer += 1;
        timers.set(nextTimer, callback);
        return nextTimer;
      }) as typeof setTimeout,
      clearTimeoutFn: ((id: number) => { timers.delete(id); }) as typeof clearTimeout,
    });
    const aborted: string[] = [];
    let runs = 0;
    host = makeDirectActorHost({
      workerUrl: 'worker.js',
      run: () => { runs += 1; return new Promise(() => {}); },
      abort: (runId: string) => { aborted.push(runId); },
      startKeepAlive: keepAlive.start,
      stopKeepAlive: keepAlive.stop,
    });
    host.bindRelayRoutes({});

    const result = host.sendMessage({
      type: 'actor/run', job: { runId: 'run-stuck', actorSessionId: 'actor-stuck' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    intervalTick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    timers.get(Math.max(...timers.keys()))?.();

    expect(await Promise.race([
      result,
      new Promise((_, reject) => setTimeout(() => reject(new Error('loss did not settle')), 100)),
    ])).toMatchObject({
      ok: false, started: true, code: 'actor_host_keepalive_lost', outcomeKnown: false,
    });
    expect(aborted).toEqual(['run-stuck']);
    expect(runs).toBe(1);

    const probe = host.sendMessage({
      type: 'actor/run', job: { actorSessionId: '__probe__', probeOnly: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    timers.get(Math.max(...timers.keys()))?.();
    expect(await probe).toMatchObject({
      ok: false, started: false, code: 'actor_host_keepalive_failed',
    });
    expect(runs).toBe(1);
  });

  test('settles a successful run while normal heartbeat cleanup is stuck', async () => {
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    let removes = 0;
    let runs = 0;
    let keepAlive: ReturnType<typeof makeStorageSessionKeepAlive>;
    keepAlive = makeStorageSessionKeepAlive({
      key: 'keepalive',
      intervalMs: 10_000,
      ackTimeoutMs: 1_000,
      makeLeaseId: () => 'lease-1',
      storage: {
        remove: () => {
          removes += 1;
          return removes === 1 ? Promise.resolve() : new Promise<void>(() => {});
        },
        set: async (items) => {
          const value = items.keepalive as { leaseId: string, sequence: number };
          queueMicrotask(() => keepAlive.onChanged({ keepalive: { newValue: value } }));
        },
      },
      setIntervalFn: (() => 7) as unknown as typeof setInterval,
      clearIntervalFn: (() => {}) as typeof clearInterval,
      setTimeoutFn: ((callback: () => void) => {
        nextTimer += 1;
        timers.set(nextTimer, callback);
        return nextTimer;
      }) as typeof setTimeout,
      clearTimeoutFn: ((id: number) => { timers.delete(id); }) as typeof clearTimeout,
    });
    const host = makeDirectActorHost({
      workerUrl: 'worker.js',
      run: async () => { runs += 1; return { ok: true }; },
      abort: () => {},
      startKeepAlive: keepAlive.start,
      stopKeepAlive: keepAlive.stop,
    });
    host.bindRelayRoutes({});

    expect(await Promise.race([
      host.sendMessage({ type: 'actor/run', job: { actorSessionId: 'actor-1' } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('successful run did not settle')), 100)),
    ])).toEqual({ ok: true });
    expect(removes).toBe(2);

    const later = host.sendMessage({ type: 'actor/run', job: { actorSessionId: 'actor-2' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cleanupTimeout = Math.max(...timers.keys());
    timers.get(cleanupTimeout)?.();
    expect(await later).toMatchObject({
      ok: false, started: false, code: 'actor_host_keepalive_failed',
    });
    expect(runs).toBe(1);
  });

  test('keeps a lost lease latched until an explicit probe reestablishes it', async () => {
    let runs = 0;
    let starts = 0;
    const host = makeDirectActorHost({
      workerUrl: 'worker.js',
      run: async (job: any) => {
        runs += 1;
        return job.probeOnly === true ? { ok: true, probe: true } : new Promise(() => {});
      },
      abort: () => {},
      startKeepAlive: () => { starts += 1; },
      stopKeepAlive: () => {},
    });
    host.bindRelayRoutes({});

    const first = host.sendMessage({
      type: 'actor/run',
      job: { runId: 'run-1', actorSessionId: 'actor-1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.failKeepAlive(new Error('heartbeat lost'));

    expect(await host.sendMessage({
      type: 'actor/run', job: { runId: 'run-2', actorSessionId: 'actor-2' },
    })).toMatchObject({ ok: false, started: false, code: 'actor_host_keepalive_failed' });
    expect(await first).toMatchObject({
      ok: false, started: true, code: 'actor_host_keepalive_lost', outcomeKnown: false,
    });
    expect(await host.sendMessage({
      type: 'actor/run', job: { runId: 'run-3', actorSessionId: 'actor-3' },
    })).toMatchObject({ ok: false, started: false, code: 'actor_host_keepalive_failed' });
    expect(runs).toBe(1);

    expect(await host.sendMessage({
      type: 'actor/run', job: { actorSessionId: '__probe__', probeOnly: true },
    })).toEqual({ ok: true, probe: true });
    expect({ runs, starts }).toEqual({ runs: 2, starts: 2 });
  });
});
