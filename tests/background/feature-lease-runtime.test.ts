import { describe, expect, test } from 'bun:test';
import { createProductionFeatureLeaseRuntime } from '../../extension/background/feature-lease-runtime.js';
import { FEATURE_LEASE_INTENT_KEY } from '../../extension/background/feature-lease-coordinator.js';
import {
  createOffscreenFeatureLeaseHost,
  FEATURE_LEASE_HOST_PROTOCOL,
} from '../../extension/offscreen/feature-lease-host.js';

const BUILD = `0.7.0:${'a'.repeat(64)}`;

const event = () => {
  const listeners: ((value?: any) => void)[] = [];
  return {
    addListener(fn: (value?: any) => void) { listeners.push(fn); },
    fire(value?: any) { for (const listener of [...listeners]) listener(value); },
  };
};

const makePort = () => {
  const onMessage = event();
  const onDisconnect = event();
  return {
    onMessage,
    onDisconnect,
    postMessage(message?: any) {
      if (message?.type !== 'feature-lease/heartbeat') return;
      queueMicrotask(() => onMessage.fire({
        type: 'feature-lease/heartbeat-ack',
        protocol: FEATURE_LEASE_HOST_PROTOCOL,
        hostEpoch: message.hostEpoch,
        heartbeatId: message.heartbeatId,
      }));
    },
    disconnect() { onDisconnect.fire(); },
  };
};

const makeStore = () => {
  const values = new Map<string, any>();
  return {
    async get(key: string) { return structuredClone(values.get(key)); },
    async set(key: string, value: any) { values.set(key, structuredClone(value)); },
  };
};

const makeEnvironment = () => {
  let host: ReturnType<typeof createOffscreenFeatureLeaseHost> | null = null;
  let nextHost = 0;
  let ensureCount = 0;
  let closeCount = 0;
  let failStarts = 0;
  const startGates = new Map<string, Promise<void>>();
  const starts: string[] = [];
  const stops: string[] = [];
  const adopts: string[] = [];
  const ports: ReturnType<typeof makePort>[] = [];

  const createHost = () => {
    const hostEpoch = `host-epoch-${String(++nextHost).padStart(8, '0')}`;
    host = createOffscreenFeatureLeaseHost({
      expectedBuildId: BUILD,
      newId: () => hostEpoch,
      startScope: async (scope) => {
        starts.push(scope);
        await startGates.get(scope);
        if (failStarts > 0) { failStarts -= 1; throw new Error('transient-host-start'); }
        return { started: scope };
      },
      stopScope: async (scope) => { stops.push(scope); return { stopped: scope }; },
      adoptScope: async (scope) => { adopts.push(scope); return { adopted: scope }; },
      connectPort: () => {
        const port = makePort();
        ports.push(port);
        return port as any;
      },
      setIntervalFn: (() => 1) as any,
      clearIntervalFn: (() => {}) as any,
      setTimeoutFn: (() => 1) as any,
      clearTimeoutFn: (() => {}) as any,
    });
    return host;
  };

  return {
    starts,
    stops,
    adopts,
    ports,
    get ensureCount() { return ensureCount; },
    get closeCount() { return closeCount; },
    get host() { return host; },
    failNextStarts(count: number) { failStarts = count; },
    stallStart(scope: string, gate: Promise<void>) { startGates.set(scope, gate); },
    replaceHost() { void host?.close(); return createHost(); },
    crashHost() { host = null; },
    async ensureOffscreen() { ensureCount += 1; if (!host) createHost(); },
    hasOffscreen() { return host !== null; },
    async closeOffscreen() {
      closeCount += 1;
      await host?.close();
      host = null;
    },
    async sendHostMessage(message: any) {
      if (!host) throw new Error('offscreen-missing');
      return host.handleMessage(message);
    },
  };
};

const ids = (prefix: string) => {
  let value = 0;
  return () => `${prefix}-${String(++value).padStart(12, '0')}`;
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const makeRuntime = (
  env: ReturnType<typeof makeEnvironment>,
  store: ReturnType<typeof makeStore>,
  kernelEpoch: string,
  over: Record<string, any> = {},
) => createProductionFeatureLeaseRuntime({
  identity: {
    schema: 1,
    buildId: BUILD,
    bootId: `boot-${kernelEpoch}`,
    kernelEpoch,
  },
  store,
  ensureOffscreen: () => env.ensureOffscreen(),
  hasOffscreen: () => env.hasOffscreen(),
  closeOffscreen: () => env.closeOffscreen(),
  sendHostMessage: (message) => env.sendHostMessage(message),
  newId: ids(`lease-${kernelEpoch}`),
  vaultUnlocked: true,
  ...over,
});

describe('production feature-lease runtime', () => {
  test('locked construction is cold and an exact controller lease owns the host lifetime', async () => {
    const env = makeEnvironment();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', { vaultUnlocked: false });
    await runtime.ready;
    expect(env.ensureCount).toBe(0);
    expect(env.host).toBeNull();
    expect(await runtime.acquire('controller')).toMatchObject({
      ok: false, code: 'feature-lease-vault-locked', outcomeKnown: true,
    });
    expect(env.ensureCount).toBe(0);

    await runtime.runTransition('unlock');
    expect(await runtime.acquire('controller', { reason: 'vault-unlock' })).toMatchObject({
      ok: true, code: 'feature-lease-started',
    });
    expect(env.starts).toEqual(['controller']);
    expect(env.ports).toHaveLength(1);
    expect(await runtime.revoke('controller')).toMatchObject({ ok: true });
    expect(env.stops).toEqual(['controller']);
    expect(env.closeCount).toBe(1);
    expect(env.host).toBeNull();
  });

  test('bounded operations receive the exact active lease', async () => {
    const env = makeEnvironment();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a');
    await runtime.ready;
    let owned = false;
    const lease = await runtime.runWithLease('controller', async (value) => {
      owned = env.host?.ownsLease('controller', value) === true;
      return value;
    });
    expect(lease).toMatchObject({
      scope: 'controller', generation: 1, schema: 1,
      buildId: BUILD, bootId: 'boot-kernel-epoch-a',
      kernelEpoch: 'kernel-epoch-a',
    });
    expect(owned).toBe(true);
  });

  test('a stalled durable feature does not head-of-line block controller demand', async () => {
    const env = makeEnvironment();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a');
    await runtime.ready;
    const dweb = deferred<void>();
    env.stallStart('dweb', dweb.promise);
    const transition = runtime.runTransition('resume', { dwebEnabled: true });
    while (!env.starts.includes('dweb')) await Promise.resolve();

    const controller = await Promise.race([
      runtime.runWithLease('controller', async () => 'controller-ready'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ]);
    expect(controller).toBe('controller-ready');
    dweb.resolve();
    await transition;
  });

  test('first, coalesced, and durable acquisitions expose only canonical capabilities', async () => {
    const env = makeEnvironment();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a');
    await runtime.ready;
    const keys = [
      'bootId', 'buildId', 'generation', 'hostEpoch', 'kernelEpoch',
      'leaseId', 'schema', 'scope',
    ];
    const first = await runtime.acquire('controller');
    expect(Object.keys(first.lease).sort()).toEqual(keys);
    expect(env.host?.ownsLease('controller', first.lease)).toBe(true);
    const observed = await runtime.runWithLease('controller', async (lease) => {
      expect(Object.keys(lease).sort()).toEqual(keys);
      return env.host?.ownsLease('controller', lease) === true;
    });
    expect(observed).toBe(true);
    expect((await runtime.acquire('controller')).lease).toEqual(first.lease);
  });

  test('cleanup failure cannot replace a successful operation result', async () => {
    const env = makeEnvironment();
    let closeAttempts = 0;
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      hostEffectTimeoutMs: 5,
      wait: async () => {},
      closeOffscreen: () => {
        closeAttempts += 1;
        return new Promise(() => {});
      },
    });
    await runtime.ready;
    await expect(runtime.runWithLease('controller', async () => ({ ok: true, value: 7 })))
      .resolves.toEqual({ ok: true, value: 7 });
    expect(closeAttempts).toBe(3);
  });

  test('a long dweb lease survives closed UI and is adopted by the successor kernel', async () => {
    const env = makeEnvironment();
    const store = makeStore();
    const first = makeRuntime(env, store, 'kernel-epoch-a');
    await first.ready;
    expect(await first.acquire('dweb', { reason: 'vault-resume' })).toMatchObject({ ok: true });
    expect(env.starts).toEqual(['dweb']);

    // There is deliberately no UI lease. Kernel transport loss or service-worker
    // recycle must not tear down the dweb custody/network host.
    env.ports[0].onDisconnect.fire();
    expect(env.host?.snapshot().leases).toEqual([
      expect.objectContaining({ scope: 'dweb', orphaned: true }),
    ]);

    const successor = makeRuntime(env, store, 'kernel-epoch-b');
    await successor.ready;
    expect(await successor.reconcile()).toEqual([
      expect.objectContaining({ ok: true, scope: 'dweb' }),
    ]);
    expect(env.starts).toEqual(['dweb']);
    expect(env.adopts).toEqual(['dweb']);
    expect(env.host?.snapshot().leases).toEqual([
      expect.objectContaining({ scope: 'dweb', kernelEpoch: 'kernel-epoch-b', orphaned: false }),
    ]);
  });

  test('an authenticated renderer loss retires the exact host and reacquires dweb on a fresh realm', async () => {
    const env = makeEnvironment();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a');
    await runtime.ready;
    await runtime.acquire('dweb', { reason: 'vault-resume' });
    const oldHostEpoch = env.host?.hostEpoch ?? null;
    const oldLease = env.host?.snapshot().leases[0];
    expect(typeof oldHostEpoch).toBe('string');
    env.crashHost();

    const recovering = runtime.handleHostLoss(oldHostEpoch!);
    // Host loss dominates synchronously; a delayed old receipt cannot publish
    // active authority while fresh realm creation waits in the lifecycle queue.
    expect(runtime.snapshot().leases.dweb).toMatchObject({
      status: 'idle', hostEpoch: null, durable: false, poisonedHostEpoch: oldHostEpoch,
    });
    const recovered = await recovering;
    expect(recovered.affected).toEqual([
      { scope: 'dweb', durable: true, priorStatus: 'active' },
    ]);
    expect(recovered.results).toEqual([
      expect.objectContaining({ ok: true, scope: 'dweb' }),
    ]);
    expect(env.starts).toEqual(['dweb', 'dweb']);
    expect(env.host?.hostEpoch).not.toBe(oldHostEpoch);
    expect(env.host?.snapshot().leases).toEqual([
      expect.objectContaining({ scope: 'dweb', orphaned: false }),
    ]);

    // Duplicate/later disconnect notification from the retired realm is inert.
    expect(await runtime.handleHostLoss(oldHostEpoch!)).toMatchObject({
      hostEpoch: oldHostEpoch, affected: [], results: [],
    });
    expect(env.host?.snapshot().leases).toHaveLength(1);
    expect(oldLease?.hostEpoch).toBe(oldHostEpoch);
  });

  test('an unknown bounded operation retires the shared realm before durable dweb recovers', async () => {
    const env = makeEnvironment();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a');
    await runtime.ready;
    await runtime.acquire('dweb', { reason: 'vault-resume' });
    const oldHostEpoch = env.host?.hostEpoch ?? null;
    const operationStarted = deferred();
    const releaseOperation = deferred();
    const bounded = runtime.runWithLease('controller', async () => {
      operationStarted.resolve();
      await releaseOperation.promise;
      return 'settled';
    });
    await operationStarted.promise;

    const retired = await runtime.retireActiveHost('repository-mutation-outcome-unknown');
    expect(retired.hostEpoch).toBe(oldHostEpoch);
    expect(retired.affected).toEqual(expect.arrayContaining([
      { scope: 'dweb', durable: true, priorStatus: 'active' },
      { scope: 'controller', durable: false, priorStatus: 'active' },
    ]));
    expect(env.closeCount).toBe(1);
    expect(env.starts).toEqual(['dweb', 'controller', 'dweb']);
    expect(env.host?.hostEpoch).not.toBe(oldHostEpoch);
    expect(env.host?.snapshot().leases).toEqual([
      expect.objectContaining({ scope: 'dweb', orphaned: false }),
    ]);

    releaseOperation.resolve();
    expect(await bounded).toBe('settled');
    expect(env.host?.snapshot().leases).toHaveLength(1);
  });

  test('a timed-out stop retires the poisoned physical host before lock or keyed reuse', async () => {
    const env = makeEnvironment();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      hostEffectTimeoutMs: 5,
      sendHostMessage: (message: any) => message.type === 'feature-lease/host-stop'
        ? new Promise(() => {})
        : env.sendHostMessage(message),
    });
    await runtime.ready;
    expect(await runtime.acquire('controller')).toMatchObject({ ok: true });
    const oldHostEpoch = env.host?.hostEpoch;

    expect(await runtime.revoke('controller')).toMatchObject({
      ok: false, code: 'feature-lease-stop-unknown', outcomeKnown: false,
    });
    expect(env.closeCount).toBe(1);
    expect(env.host).toBeNull();
    expect(runtime.snapshot().leases.controller).toMatchObject({
      status: 'idle', hostEpoch: null, poisonedHostEpoch: null,
    });

    // Lock is still prompt and cannot leave the retired renderer resident.
    await expect(runtime.lock()).resolves.toEqual(expect.any(Array));
    expect(env.closeCount).toBe(1);
  });

  test('a later live realm outranks every retired poison marker', async () => {
    const env = makeEnvironment();
    let freezeStop = true;
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      hostEffectTimeoutMs: 5,
      wait: async () => {},
      sendHostMessage: (message: any) => freezeStop
        && message.type === 'feature-lease/host-stop'
        ? new Promise(() => {})
        : env.sendHostMessage(message),
    });
    await runtime.ready;
    await runtime.acquire('controller');
    const retiredEpoch = env.host?.hostEpoch;
    await runtime.revoke('controller');
    expect(env.host).toBeNull();
    expect(runtime.snapshot().leases.controller.poisonedHostEpoch).toBeNull();

    freezeStop = false;
    await runtime.acquire('controller');
    const liveEpoch = env.host?.hostEpoch;
    expect(liveEpoch).not.toBe(retiredEpoch);
    const retired = await runtime.retireActiveHost('operation-outcome-unknown');
    expect(retired).toMatchObject({ hostEpoch: liveEpoch });
    expect(retired.affected).toEqual([
      { scope: 'controller', durable: true, priorStatus: 'active' },
    ]);
    expect(env.closeCount).toBe(2);
    expect(env.host?.hostEpoch).not.toBe(liveEpoch);
    expect(env.host?.snapshot().leases).toEqual([
      expect.objectContaining({ scope: 'controller', orphaned: false }),
    ]);
  });

  test('lock retires one shared poisoned realm after every stop reply is lost', async () => {
    const env = makeEnvironment();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      hostEffectTimeoutMs: 5,
      wait: async () => {},
      sendHostMessage: (message: any) => message.type === 'feature-lease/host-stop'
        ? new Promise(() => {})
        : env.sendHostMessage(message),
    });
    await runtime.ready;
    await runtime.acquire('controller');
    await runtime.acquire('dweb');
    await runtime.lock();
    expect(env.closeCount).toBe(1);
    expect(env.host).toBeNull();
    expect(runtime.snapshot()).toMatchObject({
      locked: true,
      leases: {
        controller: { status: 'idle', poisonedHostEpoch: null },
        dweb: { status: 'idle', poisonedHostEpoch: null },
      },
    });
  });

  test('physical lock cleanup retries transient close failure and remains bounded when it never settles', async () => {
    const transientEnv = makeEnvironment();
    let transientAttempts = 0;
    const transient = makeRuntime(transientEnv, makeStore(), 'kernel-epoch-a', {
      hostEffectTimeoutMs: 5,
      wait: async () => {},
      closeOffscreen: async () => {
        transientAttempts += 1;
        if (transientAttempts < 3) throw new Error('renderer-close-transient');
        await transientEnv.closeOffscreen();
      },
    });
    await transient.ready;
    await transient.acquire('controller');
    await transient.lock();
    expect(transientAttempts).toBe(3);
    expect(transientEnv.host).toBeNull();

    const stuckEnv = makeEnvironment();
    let stuckAttempts = 0;
    const stuck = makeRuntime(stuckEnv, makeStore(), 'kernel-epoch-b', {
      hostEffectTimeoutMs: 5,
      wait: async () => {},
      closeOffscreen: () => {
        stuckAttempts += 1;
        return new Promise(() => {});
      },
    });
    await stuck.ready;
    await stuck.acquire('controller');
    const outcome = await Promise.race([
      stuck.lock().then(() => 'resolved', (cause) => cause),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('physical cleanup exceeded bounded deadline')), 250,
      )),
    ]);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('feature-lease-host-close-timeout');
    expect(stuckAttempts).toBe(3);
    expect(stuck.snapshot().locked).toBe(true);
    expect(stuckEnv.host).not.toBeNull();
  });

  test('lock closes the exact resident after its final stop ACK even if status then freezes', async () => {
    const env = makeEnvironment();
    let freezeStatus = false;
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      hostStatusTimeoutMs: 5,
      wait: async () => {},
      sendHostMessage: async (message: any) => {
        if (message.type === 'feature-lease/host-status' && freezeStatus) {
          return new Promise(() => {});
        }
        const result = await env.sendHostMessage(message);
        if (message.type === 'feature-lease/host-stop') freezeStatus = true;
        return result;
      },
    });
    await runtime.ready;
    await runtime.acquire('controller');
    await runtime.lock();
    expect(env.host).toBeNull();
    expect(env.closeCount).toBe(1);
    expect(runtime.snapshot()).toMatchObject({ locked: true });
  });

  test('a status timeout cannot close a realm with another live scope', async () => {
    const env = makeEnvironment();
    let freezeStatus = false;
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      hostStatusTimeoutMs: 5,
      sendHostMessage: async (message: any) => {
        if (message.type === 'feature-lease/host-status' && freezeStatus) {
          return new Promise(() => {});
        }
        const result = await env.sendHostMessage(message);
        if (message.type === 'feature-lease/host-stop'
            && message.lease?.scope === 'controller') freezeStatus = true;
        return result;
      },
    });
    await runtime.ready;
    await runtime.acquire('controller');
    await runtime.acquire('dweb');

    await runtime.revoke('controller');

    expect(env.closeCount).toBe(0);
    expect(env.host?.isActive('dweb')).toBe(true);
    expect(runtime.snapshot().leases.dweb).toMatchObject({ status: 'active' });
  });

  test('renderer recovery retries transient replacement failures under the same durable intent', async () => {
    const env = makeEnvironment();
    const waits: number[] = [];
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      recoveryAttempts: 4,
      wait: async (ms: number) => { waits.push(ms); },
    });
    await runtime.ready;
    await runtime.acquire('dweb', { reason: 'vault-resume' });
    const oldHostEpoch = env.host?.hostEpoch;
    env.crashHost();
    env.failNextStarts(2);
    const recovered = await runtime.handleHostLoss(oldHostEpoch!);
    expect(recovered.results).toEqual([
      expect.objectContaining({ ok: true, scope: 'dweb' }),
    ]);
    expect(waits).toEqual([100, 200]);
    expect(env.starts.filter((scope) => scope === 'dweb')).toHaveLength(4);
  });

  test('an unknown lazy-host start retires the poisoned realm before a user retry', async () => {
    const env = makeEnvironment();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a');
    await runtime.ready;
    env.failNextStarts(1);
    expect(await runtime.runWithLease('controller', async () => 'unreachable', {
      reason: 'feature-demand',
    })).toMatchObject({
      ok: false,
      code: 'feature-lease-receipt-invalid',
      outcomeKnown: false,
    });
    expect(env.closeCount).toBe(1);
    expect(env.host).toBeNull();
    expect(await runtime.runWithLease('controller', async () => 'settled', {
      reason: 'feature-demand',
    })).toBe('settled');
    expect(env.ensureCount).toBe(2);
  });

  test('vault lock cancels a queued durable renderer recovery before another retry', async () => {
    const env = makeEnvironment();
    const retryWait = deferred<void>();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      recoveryAttempts: 4,
      wait: async () => retryWait.promise,
    });
    await runtime.ready;
    await runtime.acquire('dweb', { reason: 'vault-resume' });
    const oldHostEpoch = env.host?.hostEpoch;
    env.crashHost();
    env.failNextStarts(4);
    const recovering = runtime.handleHostLoss(oldHostEpoch!);
    while (env.starts.filter((scope) => scope === 'dweb').length < 2) await Promise.resolve();
    const locking = runtime.lock();
    retryWait.resolve();
    const result = await recovering;
    await locking;
    expect(result.results).toEqual([
      expect.objectContaining({ code: 'feature-lease-recovery-cancelled' }),
    ]);
    expect(runtime.snapshot().locked).toBe(true);
  });

  test('renderer recovery waits for stale context enumeration before creating its successor', async () => {
    const env = makeEnvironment();
    let staleContextPolls = 0;
    let closing = false;
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      closeOffscreen: async () => { closing = true; },
      hasOffscreen: () => closing ? staleContextPolls < 2 : env.hasOffscreen(),
      wait: async () => {
        staleContextPolls += 1;
        if (staleContextPolls === 2) env.crashHost();
      },
    });
    await runtime.ready;
    await runtime.acquire('dweb', { reason: 'vault-resume' });
    const oldHostEpoch = env.host?.hostEpoch;

    const recovered = await runtime.handleHostLoss(oldHostEpoch!);
    expect(staleContextPolls).toBe(2);
    expect(recovered.results).toEqual([
      expect.objectContaining({ ok: true, scope: 'dweb' }),
    ]);
    expect(env.ensureCount).toBe(2);
    expect(env.host?.hostEpoch).not.toBe(oldHostEpoch);
  });

  test('persisted dweb OFF removes stale intent before resume can adopt its orphan host', async () => {
    const env = makeEnvironment();
    const store = makeStore();
    const first = makeRuntime(env, store, 'kernel-epoch-a');
    await first.ready;
    await first.acquire('dweb', { reason: 'vault-resume' });
    env.ports[0].onDisconnect.fire();
    expect(env.host?.snapshot().leases).toEqual([
      expect.objectContaining({ scope: 'dweb', orphaned: true }),
    ]);

    const successor = makeRuntime(env, store, 'kernel-epoch-b', { vaultUnlocked: false });
    await successor.ready;
    await successor.resume({ dwebEnabled: false });
    expect(env.starts).toEqual(['dweb']);
    expect(env.stops).toEqual(['dweb']);
    expect(env.host).toBeNull();
    expect(successor.snapshot().disabled).toContain('dweb');
    expect((await store.get(FEATURE_LEASE_INTENT_KEY)).intents)
      .not.toContainEqual(expect.objectContaining({ scope: 'dweb' }));
  });

  test('settings hydration failure locks and stops a stale dweb orphan without adopting it', async () => {
    const env = makeEnvironment();
    const store = makeStore();
    const first = makeRuntime(env, store, 'kernel-epoch-a');
    await first.ready;
    await first.acquire('dweb', { reason: 'vault-resume' });
    env.ports[0].onDisconnect.fire();

    const successor = makeRuntime(env, store, 'kernel-epoch-b', { vaultUnlocked: false });
    await successor.ready;
    try {
      await Promise.reject(new Error('settings storage unavailable'));
      await successor.resume({ dwebEnabled: true });
    } catch {
      await successor.lock();
    }
    expect(env.starts).toEqual(['dweb']);
    expect(env.adopts).toEqual([]);
    expect(env.stops).toEqual(['dweb']);
    expect(env.host).toBeNull();
    expect(successor.snapshot().locked).toBe(true);
  });

  test('successor lock removes an unadopted orphan and closes the offscreen document', async () => {
    const env = makeEnvironment();
    const store = makeStore();
    const first = makeRuntime(env, store, 'kernel-epoch-a');
    await first.ready;
    await first.acquire('dweb', { reason: 'vault-resume' });
    env.ports[0].onDisconnect.fire();

    const successor = makeRuntime(env, store, 'kernel-epoch-b');
    await successor.ready;
    await successor.lock();
    expect(env.stops).toEqual(['dweb']);
    expect(env.closeCount).toBe(1);
    expect(env.host).toBeNull();
  });

  test('lock invalidates a blocked host start synchronously and cleans its late activation', async () => {
    const env = makeEnvironment();
    const startDispatched = deferred();
    const releaseStart = deferred();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      sendHostMessage: async (message: any) => {
        if (message.type === 'feature-lease/host-start') {
          startDispatched.resolve();
          await releaseStart.promise;
        }
        return env.sendHostMessage(message);
      },
    });
    await runtime.ready;
    const starting = runtime.acquire('dweb', { reason: 'vault-resume' });
    await startDispatched.promise;

    const locking = runtime.lock();
    // lock() must dominate immediately; it cannot wait behind the host IO that
    // may already hold identity material or may never return.
    expect(runtime.snapshot()).toMatchObject({
      locked: true,
      leases: { dweb: { status: 'revoked', durable: false } },
    });

    releaseStart.resolve();
    expect(await starting).toMatchObject({
      ok: false,
      code: 'feature-lease-cancelled-after-dispatch',
      outcomeKnown: false,
      scope: 'dweb',
    });
    await locking;
    expect(env.starts).toEqual(['dweb']);
    expect(env.stops).toEqual(['dweb']);
    expect(env.closeCount).toBe(1);
    expect(env.host).toBeNull();
  });

  test('a never-settling host message cannot wedge acquisition or lock cleanup', async () => {
    const env = makeEnvironment();
    const startDispatched = deferred();
    const never = new Promise(() => {});
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      hostStatusTimeoutMs: 5,
      hostEffectTimeoutMs: 5,
      wait: async () => {},
      sendHostMessage: (message: any) => {
        if (message.type === 'feature-lease/host-start') {
          startDispatched.resolve();
          return never;
        }
        return env.sendHostMessage(message);
      },
    });
    await runtime.ready;
    const starting = runtime.acquire('controller', { reason: 'feature-demand' });
    await startDispatched.promise;
    const locking = runtime.lock();
    const result = await Promise.race([
      Promise.all([starting, locking]),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('feature lease deadline did not settle')), 250,
      )),
    ]) as any[];
    expect(result[0]).toMatchObject({
      ok: false,
      code: 'feature-lease-host-lost',
      outcomeKnown: false,
      scope: 'controller',
    });
    expect(runtime.snapshot()).toMatchObject({ locked: true });
    expect(env.closeCount).toBe(1);
    expect(env.host).toBeNull();
  });

  test('concurrent bounded DOM operations share one lease and stop only after the last user', async () => {
    const env = makeEnvironment();
    const store = makeStore();
    const runtime = makeRuntime(env, store, 'kernel-epoch-a');
    await runtime.ready;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const first = runtime.runWithLease('dom-host', async () => { await firstGate; return 'first'; });
    const second = runtime.runWithLease('dom-host', async () => { await secondGate; return 'second'; });
    while (env.starts.length === 0) await Promise.resolve();
    expect(env.starts).toEqual(['dom-host']);
    expect((await store.get(FEATURE_LEASE_INTENT_KEY)).intents).toEqual([]);

    releaseFirst();
    expect(await first).toBe('first');
    expect(env.stops).toEqual([]);
    releaseSecond();
    expect(await second).toBe('second');
    expect(env.stops).toEqual(['dom-host']);
    expect(env.closeCount).toBe(1);
  });

  test('model-host supports bounded use, durable promotion, lock, and non-adoptable loss', async () => {
    const env = makeEnvironment();
    const store = makeStore();
    const runtime = makeRuntime(env, store, 'kernel-model-aa');
    await runtime.ready;

    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bounded = runtime.runWithLease('model-host', async () => {
      entered = true;
      await gate;
      return 'generated';
    });
    while (!entered) await Promise.resolve();
    expect(env.starts).toEqual(['model-host']);
    expect((await store.get(FEATURE_LEASE_INTENT_KEY)).intents).toEqual([]);

    expect(await runtime.acquire('model-host', {
      reason: 'feature-demand',
    })).toMatchObject({ ok: true, scope: 'model-host' });
    release();
    expect(await bounded).toBe('generated');
    expect(env.stops).toEqual([]);
    expect((await store.get(FEATURE_LEASE_INTENT_KEY)).intents).toEqual([
      expect.objectContaining({ scope: 'model-host', desired: true }),
    ]);

    // Model residency is not durable across kernel transport loss: keeping a
    // multi-GB model alive without an owner would turn a crash into a leak.
    env.ports[0].onDisconnect.fire();
    await Promise.resolve();
    expect(env.stops).toEqual(['model-host']);
    expect(env.host?.snapshot().leases).toEqual([]);

    const successor = makeRuntime(env, store, 'kernel-model-bb');
    await successor.ready;
    expect(await successor.lock()).toEqual(expect.any(Array));
    expect(env.adopts).toEqual([]);
    expect(env.host).toBeNull();
    expect(successor.snapshot().locked).toBe(true);
  });

  test('kernel loss retires interrupted bounded controller custody before a successor can adopt it', async () => {
    const env = makeEnvironment();
    const store = makeStore();
    const first = makeRuntime(env, store, 'kernel-epoch-a');
    await first.ready;
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = first.runWithLease('controller', async () => {
      entered = true;
      await gate;
      return 'done';
    });
    while (!entered) await Promise.resolve();
    expect((await store.get(FEATURE_LEASE_INTENT_KEY)).intents).toEqual([]);
    env.ports[0].onDisconnect.fire();
    expect(env.host?.snapshot().leases).toEqual([]);
    expect(env.stops).toEqual(['controller']);

    const successor = makeRuntime(env, store, 'kernel-epoch-b');
    await successor.ready;
    expect(await successor.reconcile()).toEqual([]);
    expect(env.stops).toEqual(['controller']);
    expect(env.host).toBeNull();
    release();
    expect(await running).toBe('done');
  });

  test('a bounded caller cannot revoke a durable feature hold on the same scope', async () => {
    const env = makeEnvironment();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a');
    await runtime.ready;
    await runtime.acquire('dweb', { reason: 'vault-resume' });
    expect(await runtime.runWithLease('dweb', async () => 'observed')).toBe('observed');
    expect(env.starts).toEqual(['dweb']);
    expect(env.stops).toEqual([]);
    expect(env.host?.isActive('dweb')).toBe(true);
    await runtime.revoke('dweb');
    expect(env.stops).toEqual(['dweb']);
  });

  test('last-scope idle close settles before a concurrent dweb start creates the successor host', async () => {
    const env = makeEnvironment();
    const closeEntered = deferred();
    const releaseClose = deferred();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      closeOffscreen: async () => {
        closeEntered.resolve();
        await releaseClose.promise;
        await env.closeOffscreen();
      },
    });
    await runtime.ready;
    await runtime.acquire('dom-host');

    const revoking = runtime.revoke('dom-host');
    await closeEntered.promise;
    const startingDweb = runtime.acquire('dweb', { reason: 'feature-demand' });
    await Promise.resolve();
    await Promise.resolve();

    // Starting a new cross-scope feature between the empty status read and the
    // physical close used to let the stale closer destroy a live dweb host.
    expect(env.starts).toEqual(['dom-host']);
    expect(env.ensureCount).toBe(1);
    releaseClose.resolve();
    await revoking;
    expect(await startingDweb).toMatchObject({ ok: true, scope: 'dweb' });
    expect(env.starts).toEqual(['dom-host', 'dweb']);
    expect(env.closeCount).toBe(1);
    expect(env.ensureCount).toBe(2);
    expect(env.host?.snapshot().leases).toEqual([
      expect.objectContaining({ scope: 'dweb', orphaned: false }),
    ]);
  });

  test('old-generation cleanup settles before a same-scope reacquire can publish a new lease', async () => {
    const env = makeEnvironment();
    const cleanupStatusEntered = deferred();
    const releaseCleanupStatus = deferred();
    let statusReads = 0;
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      sendHostMessage: async (message: any) => {
        if (message.type === 'feature-lease/host-status') {
          statusReads += 1;
          // Read 1 resolves the original host epoch. Read 2 is the post-revoke
          // orphan sweep that previously stopped whichever generation happened
          // to occupy this scope by the time the read completed.
          if (statusReads === 2) {
            cleanupStatusEntered.resolve();
            await releaseCleanupStatus.promise;
          }
        }
        return env.sendHostMessage(message);
      },
    });
    await runtime.ready;
    await runtime.acquire('media-host');

    const revoking = runtime.revoke('media-host');
    await cleanupStatusEntered.promise;
    const reacquiring = runtime.acquire('media-host', { reason: 'feature-demand' });
    await Promise.resolve();
    await Promise.resolve();

    expect(env.starts).toEqual(['media-host']);
    releaseCleanupStatus.resolve();
    await revoking;
    expect(await reacquiring).toMatchObject({ ok: true, scope: 'media-host' });
    expect(env.starts).toEqual(['media-host', 'media-host']);
    expect(env.stops).toEqual(['media-host']);
    expect(env.host?.snapshot().leases).toEqual([
      expect.objectContaining({ scope: 'media-host', orphaned: false }),
    ]);
  });

  test('latest ON wins when dweb disable overlaps a blocked host lifecycle operation', async () => {
    const env = makeEnvironment();
    const controllerStartEntered = deferred();
    const releaseControllerStart = deferred();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      sendHostMessage: async (message: any) => {
        if (message.type === 'feature-lease/host-start'
            && message.lease?.scope === 'controller') {
          controllerStartEntered.resolve();
          await releaseControllerStart.promise;
        }
        return env.sendHostMessage(message);
      },
    });
    await runtime.ready;
    await runtime.acquire('dweb', { reason: 'vault-resume' });
    const blockingController = runtime.acquire('controller');
    await controllerStartEntered.promise;

    // OFF must invalidate immediately even though physical cleanup queues behind
    // the blocked controller start. A later ON is the newest user intent and
    // must not be overwritten when that queued disable eventually settles.
    const disabling = runtime.disable('dweb');
    expect(runtime.snapshot().disabled).toContain('dweb');
    expect(runtime.enable('dweb')).toBe(true);
    expect(runtime.snapshot().disabled).not.toContain('dweb');
    const restarting = runtime.acquire('dweb', { reason: 'feature-demand' });
    releaseControllerStart.resolve();

    expect(await blockingController).toMatchObject({ ok: true, scope: 'controller' });
    expect(await disabling).toMatchObject({ ok: true, scope: 'dweb' });
    expect(await restarting).toMatchObject({ ok: true, scope: 'dweb' });
    expect(env.starts).toEqual(['dweb', 'controller', 'dweb']);
    expect(env.stops).toEqual(['dweb']);
    expect(env.host?.snapshot().leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'controller', orphaned: false }),
      expect.objectContaining({ scope: 'dweb', orphaned: false }),
    ]));
  });

  test('a durable feature can promote an already-active bounded scope without overlap', async () => {
    const env = makeEnvironment();
    const store = makeStore();
    const runtime = makeRuntime(env, store, 'kernel-epoch-a');
    await runtime.ready;
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const bounded = runtime.runWithLease('controller', async () => {
      entered = true;
      await gate;
      return 'bounded';
    });
    while (!entered) await Promise.resolve();
    expect((await store.get(FEATURE_LEASE_INTENT_KEY)).intents).toEqual([]);

    expect(await runtime.acquire('controller')).toMatchObject({ ok: true });
    expect((await store.get(FEATURE_LEASE_INTENT_KEY)).intents).toEqual([
      expect.objectContaining({ scope: 'controller' }),
    ]);
    release();
    expect(await bounded).toBe('bounded');
    expect(env.starts).toEqual(['controller']);
    expect(env.stops).toEqual([]);
    await runtime.revoke('controller');
    expect(env.stops).toEqual(['controller']);
  });

  test('a queued durable promotion wins over the last bounded caller releasing the same scope', async () => {
    const env = makeEnvironment();
    const store = makeStore();
    const runtime = makeRuntime(env, store, 'kernel-epoch-a');
    await runtime.ready;
    const operationGate = deferred();
    let entered = false;
    const bounded = runtime.runWithLease('model-host', async () => {
      entered = true;
      await operationGate.promise;
      return 'bounded';
    });
    while (!entered) await Promise.resolve();

    // Do not await promotion before releasing the bounded user: this exact
    // ordering used to observe durableScopes=false outside the lifecycle queue
    // and enqueue a stale revoke immediately behind the successful promotion.
    const promotion = runtime.acquire('model-host', { reason: 'local-model-resident' });
    operationGate.resolve();
    expect(await bounded).toBe('bounded');
    expect(await promotion).toMatchObject({ ok: true, scope: 'model-host' });
    expect(env.starts).toEqual(['model-host']);
    expect(env.stops).toEqual([]);
    expect(env.host?.snapshot().leases).toEqual([
      expect.objectContaining({ scope: 'model-host', orphaned: false }),
    ]);
    expect((await store.get(FEATURE_LEASE_INTENT_KEY)).intents).toEqual([
      expect.objectContaining({ scope: 'model-host', desired: true }),
    ]);
  });

  test('host crash gives a new realm epoch and delayed old leases cannot affect it', async () => {
    const env = makeEnvironment();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a');
    await runtime.ready;
    await runtime.acquire('controller');
    const old = env.host?.snapshot().leases[0];
    const replacement = env.replaceHost();
    expect(await replacement.handleMessage({
      type: 'feature-lease/host-stop', protocol: FEATURE_LEASE_HOST_PROTOCOL, lease: old,
    })).toMatchObject({ ok: false, error: 'feature-lease-host-binding-invalid' });
    expect(replacement.snapshot().leases).toEqual([]);
  });

  test('an obsolete host status is replaced once before any lease dispatch', async () => {
    const env = makeEnvironment();
    let firstStatus = true;
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      sendHostMessage: async (message: any) => {
        if (firstStatus && message.type === 'feature-lease/host-status') {
          firstStatus = false;
          return { ok: true, protocol: FEATURE_LEASE_HOST_PROTOCOL, buildId: 'obsolete-build', hostEpoch: 'obsolete-host' };
        }
        return env.sendHostMessage(message);
      },
    });
    await runtime.ready;
    expect(await runtime.acquire('controller')).toMatchObject({ ok: true });
    expect(env.ensureCount).toBe(2);
    expect(env.closeCount).toBe(1);
    expect(env.starts).toEqual(['controller']);
  });

  test('ambiguous status loss never destroys a possibly-live host', async () => {
    const env = makeEnvironment();
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      sendHostMessage: async () => { throw new Error('transport-lost'); },
    });
    await runtime.ready;
    expect(await runtime.acquire('dweb')).toMatchObject({
      ok: false, code: 'feature-lease-host-unavailable', outcomeKnown: true,
    });
    expect(env.ensureCount).toBe(1);
    expect(env.closeCount).toBe(0);
    expect(env.host).not.toBeNull();
  });

  test('Store initialization orders logical recovery without opening an offscreen host', async () => {
    const env = makeEnvironment();
    const order: string[] = [];
    const owner = (scope: string) => ({
      start: () => { order.push(scope); return { active: true }; },
      stop: () => ({ active: false }),
    });
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      vaultUnlocked: false,
      logical: { goal: owner('goal'), recovery: owner('recovery'), schedule: owner('schedule') },
    });
    await runtime.ready;
    const results = await runtime.runTransition('initialize', { dwebEnabled: false });
    expect(results.map((item: any) => item.scope)).toEqual([
      'goal', 'recovery', 'schedule',
    ]);
    expect(order).toEqual(['goal', 'recovery', 'schedule']);
    expect(env.starts).toEqual([]);
    expect(env.ensureCount).toBe(0);
  });

  test('Preview initialization acquires the durable dweb lease before logical owners', async () => {
    const env = makeEnvironment();
    const order: string[] = [];
    const owner = (scope: string) => ({
      start: () => { order.push(scope); return { active: true }; },
      stop: () => ({ active: false }),
    });
    const runtime = makeRuntime(env, makeStore(), 'kernel-epoch-a', {
      vaultUnlocked: false,
      logical: { goal: owner('goal'), recovery: owner('recovery'), schedule: owner('schedule') },
    });
    await runtime.ready;
    const results = await runtime.runTransition('initialize', { dwebEnabled: true });
    expect(results.map((item: any) => item.scope)).toEqual([
      'dweb', 'goal', 'recovery', 'schedule',
    ]);
    expect(env.starts).toEqual(['dweb']);
    expect(order).toEqual(['goal', 'recovery', 'schedule']);
    expect(env.host?.snapshot().leases).toEqual([
      expect.objectContaining({ scope: 'dweb', orphaned: false }),
    ]);
  });
});
