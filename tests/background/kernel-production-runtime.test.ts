import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGED_LAZY_MODULE_ENTRIES } from '../../packaging/lazy-entry-manifest.ts';
import { createAppTabTracker } from '../../extension/background/app-tab-tracker.js';
import { createKernelProductionRuntime } from '../../extension/background/kernel-production-runtime.js';

const relayHandlers = (over: Record<string, (...args: any[]) => any> = {}) => ({
  archiveOrphanedActor: () => {},
  noteAgentTab: () => {},
  onEngineAdopt: () => {},
  onEngineDrop: () => {},
  onAppManifestMutation: () => {},
  resolveAppOwnerRoot: () => null,
  onAppDeleted: () => {},
  loadUserEndpoints: () => [],
  onSettingsChanged: () => {},
  syncDwebAgentRoom: () => {},
  beforeGoalStart: () => {},
  hasUnresolvedSideEffects: () => false,
  onGoalRunEnd: () => {},
  bindGoalRunner: () => {},
  ...over,
});

const base = (makeRichRuntime: (deps: any) => any) => ({
  seams: {},
  browser: {},
  featureHost: {
    ensureOffscreen: async () => {},
    runtime: {
      runWithLease: async (_scope: string, operation: () => any) => operation(),
      retireActiveHost: async () => {},
    },
  },
  denylist: {},
  appCatalog: {},
  providerProjection: { bumpRevision: () => {} },
  canWrite: () => {},
  dwebEnabled: false,
  confirmation: {},
  settingsStore: {},
  ensureBrowserNetworkGuard: async () => ({ ok: true }),
  acquireBrowserNetworkGuardLease: async () => ({ ok: true }),
  releaseBrowserNetworkGuardLease: async () => {},
  updateBrowserNetworkGuardOrigin: async () => ({ ok: true }),
  updateBrowserSourceProjection: async () => true,
  syncDenylistNetwork: async () => {},
  networkCustody: { sync: async () => {}, state: () => ({ supported: true }) },
  turnCustody: {},
  createTurnFactories: () => ({}),
  makeRichRuntime,
});

describe('kernel production runtime', () => {
  test('receives exact target factories without a runtime import fallback', () => {
    const background = join(import.meta.dir, '../../extension/background');
    const kernel = readFileSync(join(background, 'vault-kernel.js'), 'utf8');
    const demand = readFileSync(join(background, 'kernel-demand-plane.js'), 'utf8');
    const production = readFileSync(join(background, 'kernel-production-runtime.js'), 'utf8');
    expect(kernel).toContain('const createKernelDemandPlane = await runtimeModules.demandPlane();');
    expect(kernel).toContain('loadProductionRuntimeModule(), runtimeModules.turnFactories(),');
    expect(production).not.toContain('createKernelDemandPlane');
    expect(production).toContain('deps.createTurnFactories({ ...deps, engine: sharedEngine })');
    expect(demand).toContain('liveProduction?.executableLive?.invalidateDwebPublications?.()');
    expect(kernel.match(/demandPlane\?\.invalidateDwebPublications\?\.\(\)/g)).toHaveLength(2);
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('background/kernel-demand-plane.js');
  });

  test('passes one engine bag through the rich owner and returns it unchanged', async () => {
    let assembly: any;
    const expected = Object.freeze({
      turnRuntime: {}, executableLive: {}, transferLive: {}, relays: relayHandlers(),
      relayRoutes: {}, dwebRoutes: {}, close: () => {},
    });
    const result = await createKernelProductionRuntime(base((deps) => {
      assembly = deps;
      return expected;
    }));
    expect(result).toBe(expected);
    expect(assembly.engine).toBeDefined();
    expect(assembly.turn.custody).toBeDefined();
    expect(assembly.createTurnFactories).toBeFunction();
    expect(assembly.turn.goal.beforeStart).toBeFunction();
    expect(assembly.transfer.onProviderConfigChanged).toBeFunction();
    expect(assembly.createTurnFactories).toBeFunction();
  });

  test('replays real pre-bind tracker adoption and failure in exact order', async () => {
    const events: any[] = [];
    const goalRunner = {};
    const runtime = await createKernelProductionRuntime(base(async ({ engine, turn }) => {
      engine.onVmTabAdopt('vm-1', 17);
      const tracker = createAppTabTracker({
        tabs: {
          query: async () => [], sendMessage: async () => ({ ok: true }),
        } as any,
        onAdopt: engine.onAppTabAdopt,
        onDrop: engine.onAppTabDrop,
      });
      tracker.onTabPending('app-1', 23);
      expect(tracker.onTabFailed('app-1', new Error('network-floor-failed'))).toBe(23);
      turn.goal.bind(goalRunner);
      expect(events).toEqual([]);
      return {
        relays: relayHandlers({
          onEngineAdopt: (...args) => { events.push(['adopt', ...args]); },
          onEngineDrop: (...args) => { events.push(['drop', ...args]); },
          bindGoalRunner: (runner) => { events.push(['bind', runner]); },
        }),
        close: () => {},
      };
    }));
    expect(runtime).toBeDefined();
    expect(events).toEqual([
      ['adopt', 'vm', 'vm-1', 17],
      ['adopt', 'app', 'app-1', 23],
      ['drop', 'app', 'app-1'],
      ['bind', goalRunner],
    ]);
  });

  test('serializes transitions arriving during drain and goal binding before publication', async () => {
    const adoptGate = Promise.withResolvers<void>();
    const adoptEntered = Promise.withResolvers<void>();
    const bindGate = Promise.withResolvers<void>();
    const bindEntered = Promise.withResolvers<void>();
    const events: any[] = [];
    let assembly: any;
    const creating = createKernelProductionRuntime(base(async (deps) => {
      assembly = deps;
      deps.engine.onVmTabAdopt('vm-1', 17);
      deps.turn.goal.bind({});
      return {
        relays: relayHandlers({
          onEngineAdopt: async (...args) => {
            events.push(['adopt', ...args]);
            if (args[1] === 'vm-1') {
              adoptEntered.resolve();
              await adoptGate.promise;
            }
          },
          onEngineDrop: (...args) => {
            events.push(['drop', ...args]);
            if (args[1] === 'app-1') {
              queueMicrotask(() => queueMicrotask(
                () => assembly.engine.onAppTabAdopt('tail-app', 29),
              ));
            }
          },
          bindGoalRunner: async () => {
            events.push(['bind']);
            bindEntered.resolve();
            await bindGate.promise;
          },
          resolveAppOwnerRoot: (sessionId) => `root:${sessionId}`,
        }),
        close: () => {},
      };
    }));
    await adoptEntered.promise;
    expect(() => assembly.engine.resolveAppOwnerRoot('child')).toThrow();
    assembly.engine.onVmTabDrop('vm-1');
    assembly.engine.onAppTabAdopt('app-1', 23);
    adoptGate.resolve();
    await bindEntered.promise;
    expect(() => assembly.engine.resolveAppOwnerRoot('child')).toThrow();
    assembly.engine.onAppTabDrop('app-1');
    bindGate.resolve();
    await creating;
    expect(events).toEqual([
      ['adopt', 'vm', 'vm-1', 17],
      ['drop', 'vm', 'vm-1'],
      ['adopt', 'app', 'app-1', 23],
      ['bind'],
      ['drop', 'app', 'app-1'],
      ['adopt', 'app', 'tail-app', 29],
    ]);
    expect(assembly.engine.resolveAppOwnerRoot('child')).toBe('root:child');
  });

  test('returns post-bind request values through exact named closures', async () => {
    let assembly: any;
    await createKernelProductionRuntime(base(async (deps) => {
      assembly = deps;
      return {
        relays: relayHandlers({
          resolveAppOwnerRoot: (sessionId) => `root:${sessionId}`,
          loadUserEndpoints: () => ['https://api.test'],
          hasUnresolvedSideEffects: (sessionId) => sessionId === 'unknown',
        }),
        close: () => {},
      };
    }));
    expect(await assembly.engine.resolveAppOwnerRoot('child')).toBe('root:child');
    expect(await assembly.transfer.loadUserEndpoints()).toEqual(['https://api.test']);
    expect(await assembly.turn.goal.hasUnresolvedSideEffects('unknown')).toBe(true);
  });

  test('fails every non-deferred callback when invoked before relay binding', async () => {
    await createKernelProductionRuntime(base(async ({ engine, transfer, turn }) => {
      for (const call of [
        () => engine.archiveOrphanedActor('actor'),
        () => engine.noteVmTab(1, {}),
        () => engine.onAppManifestMutation('app'),
        () => engine.resolveAppOwnerRoot('actor'),
        () => engine.onAppDeleted('app'),
        () => transfer.loadUserEndpoints(),
        () => turn.goal.beforeStart({ sessionId: 'session' }),
        () => turn.goal.hasUnresolvedSideEffects('session'),
        () => turn.goal.onRunEnd('session', {}),
      ]) expect(call).toThrow();
      await expect(transfer.onSettingsChanged({ dwebEnabled: true })).rejects.toThrow();
      return { relays: relayHandlers(), close: () => {} };
    }));
  });

  test('surfaces missing, pre-bind, and post-bind relay failures', async () => {
    let closed = 0;
    const missing = relayHandlers();
    delete (missing as any).resolveAppOwnerRoot;
    await expect(createKernelProductionRuntime(base(async () => ({
      relays: missing, close: () => { closed += 1; },
    })))).rejects.toThrow('kernel-production-relay-resolveAppOwnerRoot-invalid');
    expect(closed).toBe(1);

    let failedAssembly: any;
    await expect(createKernelProductionRuntime(base(async ({ engine, ...deps }) => {
      failedAssembly = { engine, ...deps };
      engine.onVmTabAdopt('vm-1', 17);
      return {
        relays: relayHandlers({
          onEngineAdopt: async () => { throw new Error('adopt-failed'); },
        }),
        close: () => { closed += 1; },
      };
    }))).rejects.toThrow('adopt-failed');
    expect(closed).toBe(2);
    expect(() => failedAssembly.engine.resolveAppOwnerRoot('child')).toThrow();

    let assembly: any;
    await createKernelProductionRuntime(base(async (deps) => {
      assembly = deps;
      return {
        relays: relayHandlers({
          loadUserEndpoints: async () => { throw new Error('endpoint-load-failed'); },
        }),
        close: () => {},
      };
    }));
    await expect(assembly.transfer.loadUserEndpoints()).rejects.toThrow('endpoint-load-failed');
  });

  test('contains no open-ended deferred relay selector', () => {
    const source = readFileSync(join(
      import.meta.dir, '../../extension/background/kernel-production-runtime.js',
    ), 'utf8');
    expect(source).not.toContain('pendingRelays');
    expect(source).not.toMatch(/relay\(['"]/);
    expect(source.match(/candidateRelays\?\.\[name\]/g)).toHaveLength(1);
    expect(source).not.toMatch(/liveRelays\[(?!name\])/);
    expect(source).toContain('pendingLiveness');
    expect(source).toContain('pendingGoal');
  });

  test('refuses a rich graph without exact browser-network custody', async () => {
    const deps = base(async () => ({}));
    delete (deps as any).ensureBrowserNetworkGuard;
    await expect(createKernelProductionRuntime(deps)).rejects.toThrow(
      'kernel-production-runtime-config-invalid',
    );
  });

  test('requires the dweb lease gate in Preview', async () => {
    await expect(createKernelProductionRuntime({
      ...base(async () => ({})), dwebEnabled: true,
    })).rejects.toThrow('kernel-production-runtime-config-invalid');
  });
});
