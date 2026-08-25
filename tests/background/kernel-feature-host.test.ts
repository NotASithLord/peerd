import { describe, expect, test } from 'bun:test';
import { createKernelFeatureHost } from '../../extension/background/kernel-feature-host.js';

const identity = Object.freeze({
  schema: 1,
  buildId: '1.2.3:controller-digest',
  bootId: 'boot-12345678',
  kernelEpoch: 'kernel-12345678',
});

const makeBrowser = () => {
  const values = new Map<string, unknown>();
  let created = 0;
  let closed = 0;
  const sessionChangeListeners: Array<(changes: Record<string, any>) => void> = [];
  const browser = {
    runtime: {
      sendMessage: async () => ({ ok: true }),
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    storage: { session: {
      get: async (key: string) => ({ [key]: values.get(key) }),
      set: async (patch: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(patch)) values.set(key, value);
      },
      remove: async (key: string) => { values.delete(key); },
      onChanged: {
        addListener: (listener: (changes: Record<string, any>) => void) => {
          sessionChangeListeners.push(listener);
        },
      },
    } },
    offscreen: {
      createDocument: async () => { created += 1; },
      closeDocument: async () => { closed += 1; },
    },
  };
  return {
    browser,
    counts: () => ({ created, closed }),
    sessionChangeListeners,
  };
};

describe('thin-kernel demand-only feature host', () => {
  test('construction and vault lifecycle remain offscreen-cold', async () => {
    const { browser, counts } = makeBrowser();
    let runtimeDeps: any;
    const calls: string[] = [];
    const runtime = {
      ready: Promise.resolve(),
      disable: async (scope: string) => { calls.push(`disable:${scope}`); },
      unlock: () => { calls.push('unlock'); },
      reconcile: async () => { calls.push('reconcile'); return []; },
      lock: async () => { calls.push('lock'); return []; },
      resume: async () => {
        calls.push('disable:dweb', 'unlock', 'reconcile');
        return { reconciled: [], transitioned: [] };
      },
    };
    const host = createKernelFeatureHost({
      browser,
      identity,
      createRuntime: ((deps: any) => { runtimeDeps = deps; return runtime; }) as any,
      listContexts: async () => [],
      wait: async () => {},
    });

    expect(counts()).toEqual({ created: 0, closed: 0 });
    await host.settleVaultBoot({ resumed: false });
    await host.vaultInitialized();
    await host.vaultUnlocked();
    await host.vaultLocked();
    expect(calls).toEqual([
      'lock',
      'disable:dweb', 'unlock', 'reconcile',
      'disable:dweb', 'unlock', 'reconcile',
      'lock',
    ]);
    expect(counts()).toEqual({ created: 0, closed: 0 });

    await runtimeDeps.ensureOffscreen('controller');
    expect(counts()).toEqual({ created: 1, closed: 0 });
  });

  test('Firefox without the offscreen API refuses creation and makes teardown a no-op', async () => {
    const { browser } = makeBrowser();
    delete (browser as any).offscreen;
    let runtimeDeps: any;
    const runtime = {
      ready: Promise.resolve(), disable: async () => {}, unlock: () => {},
      reconcile: async () => [], lock: async () => [], resume: async () => ({
        reconciled: [], transitioned: [],
      }),
    };
    createKernelFeatureHost({
      browser,
      identity,
      createRuntime: ((deps: any) => { runtimeDeps = deps; return runtime; }) as any,
      loadFirefoxLifetime: async () => ({}) as any,
    });

    await expect(runtimeDeps.ensureOffscreen('controller'))
      .rejects.toThrow('feature-lease-offscreen-unavailable');
    await expect(runtimeDeps.closeOffscreen()).resolves.toBeUndefined();
  });

  test('resume applies the hydrated dweb setting before reconciliation', async () => {
    const { browser } = makeBrowser();
    const calls: string[] = [];
    const runtime = {
      ready: Promise.resolve(),
      disable: async (scope: string) => { calls.push(`disable:${scope}`); },
      unlock: () => { calls.push('unlock'); },
      reconcile: async () => { calls.push('reconcile'); return ['joined']; },
      lock: async () => [],
      resume: async ({ dwebEnabled }: { dwebEnabled: boolean }) => {
        calls.push(`resume:${dwebEnabled}`);
        return { reconciled: ['joined'], transitioned: [] };
      },
    };
    const host = createKernelFeatureHost({
      browser,
      identity,
      dwebEnabled: () => true,
      createRuntime: (() => runtime) as any,
    });
    expect(await host.settleVaultBoot({ resumed: true }))
      .toEqual({ reconciled: ['joined'], transitioned: [] });
    expect(calls).toEqual(['resume:true']);
  });

  test('dweb demand refuses disabled posture before acquiring a host lease', async () => {
    const { browser } = makeBrowser();
    let acquires = 0;
    const host = createKernelFeatureHost({
      browser,
      identity,
      dwebEnabled: () => false,
      createRuntime: (() => ({
        ready: Promise.resolve(),
        acquire: async () => { acquires += 1; return { ok: true }; },
      })) as any,
    });
    await expect(host.ensureDwebFeature()).rejects.toThrow('dweb-disabled');
    expect(acquires).toBe(0);
  });

  test('the exact keepalive owner receives the canonical identity and runtime', () => {
    const { browser } = makeBrowser();
    const runtime = {
      ready: Promise.resolve(), disable: async () => {}, unlock: () => {},
      reconcile: async () => [], lock: async () => [],
    };
    let attached: any;
    const host = createKernelFeatureHost({
      browser,
      identity,
      createRuntime: (() => runtime) as any,
      attachKeepalive: ((deps: any) => { attached = deps; }) as any,
    });
    const port = { name: 'feature-lease-keepalive' };
    expect(host.handleKeepalive(port as any)).toBeUndefined();
    expect(attached.port).toBe(port);
    expect(attached.featureLeases).toBe(runtime);
    expect(attached.identity).toEqual(identity);
  });

  test('captures one Firefox event synchronously but loads heartbeat code only on demand', async () => {
    const { browser, counts, sessionChangeListeners } = makeBrowser();
    const runtime = {
      ready: Promise.resolve(), disable: async () => {}, unlock: () => {},
      reconcile: async () => [], lock: async () => [],
    };
    const claims: Array<[string, string]> = [];
    let loads = 0;
    const registry = {
      event: (key: string, raw: any, owner: string) => {
        claims.push([key, owner]);
        return raw;
      },
    };
    const host = createKernelFeatureHost({
      browser,
      identity,
      createRuntime: (() => runtime) as any,
      loadFirefoxLifetime: async () => {
        loads += 1;
        const module = await import('../../extension/background/firefox-storage-keepalive.js');
        return {
          ...module,
          makeStorageSessionKeepAlive: () => ({
            start: async () => {}, stop: async () => {}, onChanged: () => false,
          }),
        } as any;
      },
    });

    expect(sessionChangeListeners).toHaveLength(0);
    const lifetime = host.attachFirefoxActorLifetime(registry as any);
    expect(host.attachFirefoxActorLifetime(registry as any)).toBe(lifetime);
    expect(claims).toEqual([[
      'storage.session.onChanged', 'kernel-firefox-actor-lifetime',
    ]]);
    expect(sessionChangeListeners).toHaveLength(1);
    expect(counts()).toEqual({ created: 0, closed: 0 });
    expect(loads).toBe(0);
    const result = await lifetime.run(async () => 'ready');
    expect(result).toBe('ready');
    expect(loads).toBe(1);
    expect(() => host.attachFirefoxActorLifetime({ event: () => null } as any))
      .toThrow('kernel-firefox-lifetime-registry-changed');
  });

  test('carries heartbeat loss through a lazy Firefox handle', async () => {
    const { browser } = makeBrowser();
    const runtime = {
      ready: Promise.resolve(), disable: async () => {}, unlock: () => {},
      reconcile: async () => [], lock: async () => [],
    };
    let lose = (_error: Error) => {};
    const host = createKernelFeatureHost({
      browser,
      identity,
      createRuntime: (() => runtime) as any,
      loadFirefoxLifetime: async () => {
        const module = await import('../../extension/background/firefox-storage-keepalive.js');
        return {
          ...module,
          makeStorageSessionKeepAlive: (options: any) => {
            lose = options.onLost;
            return { start: async () => {}, stop: async () => {}, onChanged: () => false };
          },
        } as any;
      },
    });
    const lifetime = host.attachFirefoxActorLifetime({
      event: (_key: string, raw: any) => raw,
    } as any);
    const losses: string[] = [];
    const handle = lifetime.createHandle({
      onLost: (error: Error) => { losses.push(error.message); },
    });
    await handle.start();

    lose(new Error('heartbeat acknowledgment stopped'));

    expect(losses).toEqual(['heartbeat acknowledgment stopped']);
    await handle.stop();
  });
});
