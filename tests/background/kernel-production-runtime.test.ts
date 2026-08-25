import { describe, expect, test } from 'bun:test';
import { createKernelProductionRuntime } from '../../extension/background/kernel-production-runtime.js';

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
  makeRichRuntime,
});

describe('kernel production runtime', () => {
  test('passes one engine bag through the rich owner and returns it unchanged', async () => {
    let assembly: any;
    const expected = Object.freeze({
      turnRuntime: {}, executableLive: {}, transferLive: {}, relays: {},
      relayRoutes: {}, dwebRoutes: {}, close: () => {},
    });
    const result = await createKernelProductionRuntime(base((deps) => {
      assembly = deps;
      return expected;
    }));
    expect(result).toBe(expected);
    expect(assembly.engine).toBeDefined();
    expect(assembly.createTurnFactories).toBeFunction();
    expect(assembly.turn.goal.beforeStart).toBeFunction();
    expect(assembly.transfer.onProviderConfigChanged).toBeFunction();
    expect(assembly.createTurnFactories).toBeFunction();
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
