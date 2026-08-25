import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGED_LAZY_MODULE_ENTRIES } from '../../packaging/lazy-entry-manifest.ts';
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
  test('does not barrel the demand plane through production', () => {
    const background = join(import.meta.dir, '../../extension/background');
    const kernel = readFileSync(join(background, 'vault-kernel.js'), 'utf8');
    const production = readFileSync(join(background, 'kernel-production-runtime.js'), 'utf8');
    expect(kernel).toContain(
      "const { createKernelDemandPlane } = await import('./kernel-demand-plane.js');",
    );
    expect(kernel).toContain(
      'const { createKernelProductionRuntime } = await loadProductionRuntimeModule();',
    );
    expect(production).not.toContain('createKernelDemandPlane');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('background/kernel-demand-plane.js');
  });

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
