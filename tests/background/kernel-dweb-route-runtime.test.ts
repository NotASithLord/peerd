import { describe, expect, test } from 'bun:test';
import { createKernelDwebRouteOwner } from '../../extension/background/kernel-dweb-route-runtime.js';
import { KERNEL_DWEB_ROUTE_NAMES } from '../../extension/shared/kernel-feature-route-inventory.js';

const registry = {
  list: async () => [], get: async () => null, update: async () => null,
};

const deps = (over: Record<string, any> = {}) => ({
  enabled: true,
  engine: {
    appRegistry: registry,
    appClient: {
      create: async () => ({}), snapshotFilesBase64: async () => ({}),
      withWriteLock: async (_id: string, operation: () => Promise<any>) => operation(),
    },
    appTabTracker: { ensureTab: async () => 1 },
    appQuiescence: {
      runUnlocked: async (_id: string, operation: () => Promise<any>) => operation(),
    },
    repositories: {},
    withDwebPublication: async (operation: (current: () => boolean) => Promise<any>) =>
      operation(() => true),
    withDwebReseedPublication: async (operation: (current: () => boolean) => Promise<any>) =>
      operation(() => true),
    withAppLifecycle: async (_id: string, operation: () => Promise<any>) => operation(),
    invalidateDwebPublications: () => {},
    dwebPublicationGeneration: () => 0,
  },
  relays: { sessions: { list: async () => [], importPortable: async () => {} } },
  transfer: {
    memory: { exportAll: async () => ({}), importAll: async () => ({}) },
    normalizeImportedSettings: (patch: any) => patch,
    onSettingsChanging: () => {}, onSettingsChanged: async () => {},
  },
  ensureDwebFeature: async () => {},
  currentDwebHostEpoch: () => 'host-epoch-0001',
  withIdentityMutation: async (operation: () => Promise<any>) => operation(),
  settingsStore: { get: () => ({ dwebEnabled: false }), stored: () => ({}), update: async () => {} },
  vault: { isLocked: () => false },
  browser: { runtime: { sendMessage: async () => ({ ok: true }) } },
  ensureSettingsReady: async () => {},
  disableDweb: async () => ({ ok: true }),
  isOffscreenSender: () => false,
  getCurrentSessionId: async () => null,
  ensureAppTrackerReady: async () => {},
  auditLog: { append: async () => {} },
  kv: { get: async () => null, set: async () => {} },
  pushState: async () => {},
  ...over,
});

describe('kernel dweb route runtime', () => {
  test('assembles the complete Preview route owner over one shared graph', async () => {
    const { routes, reseed } = createKernelDwebRouteOwner(deps());
    expect(Object.keys(routes).sort()).toEqual([...KERNEL_DWEB_ROUTE_NAMES].sort());
    expect(await routes['dweb/base/status']()).toEqual({ ok: false, error: 'dweb-disabled' });
    expect(await routes['dweb/self-status']()).toEqual({ ok: false, error: 'dweb-disabled' });
    expect(typeof reseed.onHostGeneration).toBe('function');
  });

  test('refuses construction without shared identity custody', () => {
    expect(() => createKernelDwebRouteOwner(deps({ withIdentityMutation: null })))
      .toThrow('kernel-dweb-route-runtime-config-invalid');
  });

  test('wires exact active host and mesh generation into production reseed messages', async () => {
    const messages: any[] = [];
    const shared = {
      id: 'app-1', name: 'App', entryFile: 'index.html', shared: true,
      dweb: { local: true, slug: 'app', manifest_created: 1, hash: 'hash', seq: 2 },
    };
    const engine = {
      ...deps().engine,
      appRegistry: { ...registry, list: async () => [shared], get: async () => shared },
    };
    const runtime = createKernelDwebRouteOwner(deps({
      engine,
      settingsStore: {
        get: () => ({ dwebEnabled: true }), stored: () => ({}), update: async () => {},
      },
      browser: { runtime: { sendMessage: async (message: any) => {
        messages.push(message);
        return { ok: true };
      } } },
    }));
    expect(await runtime.reseed.onHostGeneration({
      hostEpoch: 'host-epoch-0001', meshGeneration: 3,
    })).toEqual({ ok: true, seeded: 1 });
    expect(messages).toEqual([expect.objectContaining({
      type: 'dweb/base-host/share-app', reseed: true,
      expectedHostEpoch: 'host-epoch-0001', expectedMeshGeneration: 3,
    })]);
  });
});
