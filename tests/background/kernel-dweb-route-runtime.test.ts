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
});
