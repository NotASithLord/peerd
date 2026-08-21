import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  createFeatureLeaseCoordinator,
  FEATURE_LEASE_INTENT_KEY,
  FEATURE_LEASE_SCOPES,
} from '../../extension/background/feature-lease-coordinator.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

const generation = (buildId = 'build-aaaa', kernelEpoch = 'kernel-aaaa') => ({
  schema: 1 as const,
  buildId,
  bootId: `boot-${kernelEpoch}`,
  kernelEpoch,
});

const makeStore = () => {
  const values = new Map<string, any>();
  return {
    values,
    async get(key: string) { return structuredClone(values.get(key)); },
    async set(key: string, value: any) { values.set(key, structuredClone(value)); },
  };
};

const receipt = (lease: any, over: Record<string, any> = {}) => ({
  ok: true,
  schema: lease.schema,
  bootId: lease.bootId,
  scope: lease.scope,
  leaseId: lease.leaseId,
  buildId: lease.buildId,
  kernelEpoch: lease.kernelEpoch,
  hostEpoch: lease.hostEpoch,
  generation: lease.generation,
  ...over,
});

const makeDispatchers = () => {
  const prepared: any[] = [];
  const dispatched: any[] = [];
  const stopped: any[] = [];
  const dispatchers: Record<string, any> = Object.fromEntries(FEATURE_LEASE_SCOPES.map((scope) => [scope, {
    prepare(lease: any) {
      prepared.push(lease);
      return {
        dispatch() {
          dispatched.push(lease);
          return receipt(lease);
        },
      };
    },
    stop(lease: any) {
      stopped.push(lease);
      return receipt(lease);
    },
  }]));
  return { dispatchers, prepared, dispatched, stopped };
};

const ids = () => {
  let next = 0;
  return () => `lease-${++next}`;
};

const setup = (over: Record<string, any> = {}) => {
  const hosts = makeDispatchers();
  const store = over.store ?? makeStore();
  const coordinator = createFeatureLeaseCoordinator({
    identity: over.identity ?? generation(),
    store,
    dispatchers: over.dispatchers ?? hosts.dispatchers,
    resolveHostEpoch: over.resolveHostEpoch ?? ((scope: string) => `${scope}-host-a`),
    newId: over.newId ?? ids(),
    now: () => 10,
    vaultUnlocked: over.vaultUnlocked ?? true,
  });
  return { coordinator, store, ...hosts };
};

describe('post-vault feature lease coordinator', () => {
  test('exact scopes start once and duplicate starts coalesce on one dispatch', async () => {
    const gate = deferred<any>();
    let starts = 0;
    let lease: any;
    const dispatchers = makeDispatchers().dispatchers;
    dispatchers.controller = {
      prepare(next: any) {
        lease = next;
        return { dispatch: () => { starts += 1; return gate.promise; } };
      },
      stop: (value: any) => receipt(value),
    };
    const { coordinator } = setup({ dispatchers });
    const first = coordinator.acquire('controller', { reason: 'vault-unlock', hostEpoch: 'host-a' });
    const second = coordinator.acquire('controller', { reason: 'vault-unlock', hostEpoch: 'host-a' });
    while (starts === 0) await Promise.resolve();
    expect(starts).toBe(1);
    gate.resolve(receipt(lease));
    expect(await first).toEqual(await second);
    expect(await first).toMatchObject({ ok: true, code: 'feature-lease-started' });
    expect(coordinator.snapshot().leases.controller.status).toBe('active');
  });

  test('pre-dispatch cancellation is known-safe and removes reconciliation intent', async () => {
    const prepareGate = deferred<any>();
    let dispatched = 0;
    const dispatchers = makeDispatchers().dispatchers;
    dispatchers.dweb = {
      prepare: () => prepareGate.promise,
      stop: (lease: any) => receipt(lease),
    };
    const { coordinator, store } = setup({ dispatchers });
    const abort = new AbortController();
    const result = coordinator.acquire('dweb', {
      reason: 'vault-unlock', hostEpoch: 'dweb-host', signal: abort.signal,
    });
    await Promise.resolve();
    abort.abort();
    prepareGate.resolve({ dispatch: () => { dispatched += 1; return {}; } });
    expect(await result).toMatchObject({
      ok: false, code: 'feature-lease-cancelled', outcomeKnown: true,
    });
    expect(dispatched).toBe(0);
    expect(store.values.get(FEATURE_LEASE_INTENT_KEY).intents).toEqual([]);
  });

  test('post-dispatch cancellation is unknown, poisons that host and allows a fresh epoch', async () => {
    const gate = deferred<any>();
    let firstLease: any;
    let crossedDispatch = false;
    const hosts = makeDispatchers();
    hosts.dispatchers.recovery = {
      prepare(lease: any) {
        firstLease = lease;
        return { dispatch: (signal: AbortSignal) => new Promise((_resolve, reject) => {
          crossedDispatch = true;
          signal.addEventListener('abort', () => reject(new Error('channel-lost')), { once: true });
        }) };
      },
      stop: (lease: any) => receipt(lease),
    };
    const { coordinator } = setup({ dispatchers: hosts.dispatchers });
    const abort = new AbortController();
    const running = coordinator.acquire('recovery', {
      reason: 'vault-resume', hostEpoch: 'recovery-host-a', signal: abort.signal,
    });
    while (!crossedDispatch) await Promise.resolve();
    abort.abort();
    expect(await running).toMatchObject({ ok: false, outcomeKnown: false });
    expect(await coordinator.acquire('recovery', {
      reason: 'vault-resume', hostEpoch: 'recovery-host-a',
    })).toMatchObject({ code: 'feature-lease-host-poisoned', outcomeKnown: false });

    hosts.dispatchers.recovery = {
      prepare: (lease: any) => ({ dispatch: () => receipt(lease) }),
      stop: (lease: any) => receipt(lease),
    };
    expect(await coordinator.acquire('recovery', {
      reason: 'vault-resume', hostEpoch: 'recovery-host-b',
    })).toMatchObject({ ok: true, hostEpoch: 'recovery-host-b' });
    gate.resolve(receipt(firstLease));
  });

  test('invalid build/kernel/host receipt is unknown and never activates the lease', async () => {
    const dispatchers = makeDispatchers().dispatchers;
    dispatchers.goal = {
      prepare: (lease: any) => ({
        dispatch: () => receipt(lease, { kernelEpoch: 'retired-kernel' }),
      }),
      stop: (lease: any) => receipt(lease),
    };
    const { coordinator } = setup({ dispatchers });
    expect(await coordinator.acquire('goal', {
      reason: 'vault-unlock', hostEpoch: 'goal-host-a',
    })).toMatchObject({ code: 'feature-lease-receipt-invalid', outcomeKnown: false });
    expect(coordinator.snapshot().leases.goal).toMatchObject({
      status: 'unknown', poisonedHostEpoch: 'goal-host-a',
    });
  });

  test('strict kernel identity rejects a receipt from an independently minted epoch', async () => {
    const identity = {
      schema: 1 as const,
      buildId: 'build-strict-a',
      bootId: 'boot-strict-aa',
      kernelEpoch: 'kernel-strict-a',
    };
    const dispatchers = makeDispatchers().dispatchers;
    dispatchers['model-host'] = {
      prepare: (lease: any) => ({
        dispatch: () => receipt(lease, {
          bootId: identity.bootId,
          kernelEpoch: 'kernel-forged-aa',
        }),
      }),
      stop: (lease: any) => receipt(lease),
    };
    const { coordinator } = setup({ identity, dispatchers });
    expect(await coordinator.acquire('model-host', {
      durable: false, hostEpoch: 'model-host-strict',
    })).toMatchObject({
      ok: false, code: 'feature-lease-receipt-invalid', outcomeKnown: false,
    });
    expect(coordinator.snapshot()).toMatchObject(identity);
  });

  test('different host epochs cannot overlap one starting scope', async () => {
    const gate = deferred<any>();
    let firstLease: any;
    const dispatchers = makeDispatchers().dispatchers;
    dispatchers.controller = {
      prepare(lease: any) {
        firstLease = lease;
        return { dispatch: () => gate.promise };
      },
      stop: (lease: any) => receipt(lease),
    };
    const { coordinator } = setup({ dispatchers });
    const first = coordinator.acquire('controller', { hostEpoch: 'host-a' });
    while (!firstLease) await Promise.resolve();
    expect(await coordinator.acquire('controller', { hostEpoch: 'host-b' }))
      .toMatchObject({ code: 'feature-lease-host-conflict', outcomeKnown: true });
    gate.resolve(receipt(firstLease));
    expect(await first).toMatchObject({ ok: true, hostEpoch: 'host-a' });
  });

  test('transition plan keeps Store initialize offscreen-cold and orders post-vault owners', async () => {
    const order: string[] = [];
    const hosts = makeDispatchers();
    for (const scope of FEATURE_LEASE_SCOPES) {
      hosts.dispatchers[scope] = {
        prepare: (lease: any) => ({
          dispatch: () => { order.push(scope); return receipt(lease); },
        }),
        stop: (lease: any) => receipt(lease),
      };
    }
    const initialized = setup({ dispatchers: hosts.dispatchers, vaultUnlocked: false });
    expect((await initialized.coordinator.runTransition('initialize')).map((item: any) => item.scope))
      .toEqual(['goal', 'recovery', 'schedule']);
    expect(order).toEqual(['goal', 'recovery', 'schedule']);

    const resumed = setup({ dispatchers: hosts.dispatchers, vaultUnlocked: false });
    order.length = 0;
    expect((await resumed.coordinator.runTransition('resume', { dwebEnabled: true }))
      .map((item: any) => item.scope)).toEqual([
      'dweb', 'goal', 'recovery', 'schedule',
    ]);
    expect(order).toEqual(['dweb', 'goal', 'recovery', 'schedule']);
  });

  test('lock and feature disable revoke synchronously; late starts cannot reactivate', async () => {
    const dwebGate = deferred<any>();
    let dwebLease: any;
    let dwebDispatched = false;
    const hosts = makeDispatchers();
    hosts.dispatchers.dweb = {
      prepare(lease: any) {
        dwebLease = lease;
        return { dispatch: () => { dwebDispatched = true; return dwebGate.promise; } };
      },
      stop: (lease: any) => receipt(lease),
    };
    const { coordinator } = setup({ dispatchers: hosts.dispatchers });
    await coordinator.acquire('controller', { hostEpoch: 'controller-host' });
    const starting = coordinator.acquire('dweb', { hostEpoch: 'dweb-host' });
    while (!dwebDispatched) await Promise.resolve();
    const locking = coordinator.lock();
    expect(coordinator.snapshot().locked).toBe(true);
    expect(coordinator.snapshot().leases.controller.status).toBe('revoked');
    expect(coordinator.snapshot().leases.dweb.status).toBe('revoked');
    dwebGate.resolve(receipt(dwebLease));
    expect(await starting).toMatchObject({ outcomeKnown: false });
    await locking;
    expect(coordinator.snapshot().leases.dweb.status).toBe('revoked');

    coordinator.unlock();
    await coordinator.disable('media-host');
    expect(await coordinator.acquire('media-host', { hostEpoch: 'media-host' }))
      .toMatchObject({ code: 'feature-lease-disabled', outcomeKnown: true });
  });

  test('crash/restart replays only nonsecret intent under a fresh kernel and host epoch', async () => {
    const store = makeStore();
    const first = setup({ store, identity: generation('build-aaaa', 'kernel-old') });
    await first.coordinator.acquire('schedule', {
      reason: 'vault-resume', hostEpoch: 'schedule-host-old',
    });
    expect(await first.coordinator.acquire('schedule', {
      hostEpoch: 'schedule-host-old',
      payload: { passphrase: 'must-not-be-accepted-or-persisted' },
    })).toMatchObject({ code: 'feature-lease-options-invalid', outcomeKnown: true });
    const persisted = JSON.stringify(store.values.get(FEATURE_LEASE_INTENT_KEY));
    expect(persisted).not.toContain('passphrase');
    expect(persisted).not.toContain('must-not-be-accepted');
    expect(persisted).not.toContain('schedule-host-old');

    const secondHosts = makeDispatchers();
    const second = setup({
      store,
      identity: generation('build-aaaa', 'kernel-new'),
      dispatchers: secondHosts.dispatchers,
      resolveHostEpoch: () => 'schedule-host-new',
    });
    await second.coordinator.ready;
    expect(await second.coordinator.reconcile()).toEqual([
      expect.objectContaining({ ok: true, hostEpoch: 'schedule-host-new' }),
    ]);
    expect(secondHosts.dispatched).toHaveLength(1);
    await expect(first.coordinator.revoke('schedule', 'vault-lock'))
      .resolves.toMatchObject({ outcomeKnown: false, code: 'feature-lease-revoke-intent-uncertain' });
  });

  test('replacement kernel retires a prepared old start before its dispatch boundary', async () => {
    const store = makeStore();
    const prepareGate = deferred<any>();
    let oldDispatches = 0;
    const oldHosts = makeDispatchers();
    oldHosts.dispatchers.dweb = {
      prepare: () => prepareGate.promise,
      stop: (lease: any) => receipt(lease),
    };
    const old = setup({
      store,
      identity: generation('build-aaaa', 'kernel-old'),
      dispatchers: oldHosts.dispatchers,
    });
    const oldStart = old.coordinator.acquire('dweb', {
      reason: 'vault-resume', hostEpoch: 'dweb-host-old',
    });
    while (!(store.values.get(FEATURE_LEASE_INTENT_KEY)?.intents?.length)) {
      await Promise.resolve();
    }

    const freshHosts = makeDispatchers();
    const fresh = setup({
      store,
      identity: generation('build-aaaa', 'kernel-new'),
      dispatchers: freshHosts.dispatchers,
      resolveHostEpoch: () => 'dweb-host-new',
    });
    await fresh.coordinator.ready;
    prepareGate.resolve({
      dispatch: () => { oldDispatches += 1; return {}; },
    });
    expect(await oldStart).toMatchObject({
      ok: false, code: 'feature-lease-intent-uncertain', outcomeKnown: false,
    });
    expect(oldDispatches).toBe(0);
    expect(await fresh.coordinator.reconcile()).toEqual([
      expect.objectContaining({ ok: true, hostEpoch: 'dweb-host-new' }),
    ]);
    expect(freshHosts.dispatched).toHaveLength(1);
  });

  test('lost stop is unknown and prevents same-host reacquisition', async () => {
    const hosts = makeDispatchers();
    hosts.dispatchers['dom-host'] = {
      prepare: (lease: any) => ({ dispatch: () => receipt(lease) }),
      stop: () => { throw new Error('host-disappeared'); },
    };
    const { coordinator } = setup({ dispatchers: hosts.dispatchers });
    await coordinator.acquire('dom-host', { hostEpoch: 'dom-host-a' });
    expect(await coordinator.revoke('dom-host', 'host-replaced')).toMatchObject({
      code: 'feature-lease-stop-unknown', outcomeKnown: false,
    });
    expect(await coordinator.acquire('dom-host', { hostEpoch: 'dom-host-a' }))
      .toMatchObject({ code: 'feature-lease-host-poisoned', outcomeKnown: false });
    expect(coordinator.confirmHostRetired('dom-host-other')).toBe(false);
    expect(coordinator.snapshot().leases['dom-host'].poisonedHostEpoch).toBe('dom-host-a');
    expect(coordinator.confirmHostRetired('dom-host-a')).toBe(true);
    expect(coordinator.snapshot().leases['dom-host'].poisonedHostEpoch).toBeNull();
    expect(await coordinator.acquire('dom-host', { hostEpoch: 'dom-host-a' }))
      .toMatchObject({ ok: true, code: 'feature-lease-started' });
  });

  test('different build rejects stale intent and every scope has an independent dispatcher', async () => {
    const store = makeStore();
    const first = setup({ store });
    await first.coordinator.acquire('dom-host', { reason: 'feature-demand' });
    const next = setup({
      store,
      identity: generation('build-bbbb', 'kernel-bbbb'),
    });
    await next.coordinator.ready;
    expect(await next.coordinator.reconcile()).toEqual([]);
    expect(FEATURE_LEASE_SCOPES).toEqual([
      'controller', 'dweb', 'recovery', 'goal', 'schedule', 'dom-host', 'media-host',
      'model-host', 'vault-authority',
    ]);
  });

  test('locked state permits only the sealed vault authority needed to unlock', async () => {
    const hosts = makeDispatchers();
    const { coordinator } = setup({
      dispatchers: hosts.dispatchers,
      vaultUnlocked: false,
    });
    expect(await coordinator.acquire('controller')).toMatchObject({
      ok: false, code: 'feature-lease-vault-locked', outcomeKnown: true,
    });
    expect(await coordinator.acquire('vault-authority')).toMatchObject({
      ok: true, scope: 'vault-authority', outcomeKnown: true,
    });
    expect(hosts.prepared.map((lease) => lease.scope)).toEqual(['vault-authority']);
  });

  test('host epoch resolution failure is known-safe before prepare or dispatch', async () => {
    const hosts = makeDispatchers();
    const { coordinator } = setup({
      dispatchers: hosts.dispatchers,
      resolveHostEpoch: () => { throw new Error('host registry unavailable'); },
    });
    expect(await coordinator.acquire('media-host')).toMatchObject({
      code: 'feature-lease-host-unavailable', outcomeKnown: true,
    });
    expect(hosts.prepared).toEqual([]);
    expect(hosts.dispatched).toEqual([]);
  });

  test('rejects the retired partial-identity compatibility shape', () => {
    expect(() => setup({ identity: { buildId: 'build-aaaa', kernelEpoch: 'kernel-aaaa' } }))
      .toThrow('feature-lease-identity-invalid');
  });

  test('source contains no heartbeat, timer or browser manifest shortcut', () => {
    const source = readFileSync(
      new URL('../../extension/background/feature-lease-coordinator.js', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('setInterval(');
    expect(source).not.toContain('runtime.getManifest');
    expect(source).not.toContain('storage.session.remove');
    expect(source).not.toContain('service-worker');
  });
});
