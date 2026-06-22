import { describe, test, expect } from 'bun:test';
import { makeSettingsRoutes } from '../../extension/background/routes/settings.js';

// settings/update + settings/reset + transfer/export, now over settingsStore.
// Pin: patch normalization is delegated, the vault auto-lock side effect fires,
// reset filters to known keys, and export gates on a passphrase when secrets exist.

const baseDeps = (over: any = {}) => {
  const calls: any = { autoLock: [], updated: [], reset: [] };
  const deps = {
    vault: {
      setAutoLockMs: (v: number) => { calls.autoLock.push(v); },
      isLocked: () => false,
      listSecretNames: async () => ['anthropic.key'],
      getSecret: async () => 'sk-secret',
    },
    auditLog: { append: async () => {} },
    pushState: () => {},
    kv: { get: async () => null },
    memory: { exportAll: async () => ({ docs: [] }) },
    settingsStore: {
      get: () => ({ a: 1 }),
      stored: () => ({ providerModel: 'm' }),
      update: async (p: any) => { calls.updated.push(p); },
      reset: async (k: any) => { calls.reset.push(k); },
    },
    // pass-through normalizer so we test the route's wiring, not the patch math
    normalizeSettingsPatch: (patch: any) => ({ ...patch }),
    normalizeVariant: (v: string) => v,
    normalizeEngine: (v: string) => v,
    listProviders: () => [{ name: 'anthropic' }],
    REASONING_EFFORT_LEVELS: ['low', 'medium', 'high'],
    DWEB_ENABLED: false,
    DEFAULT_SETTINGS: { providerModel: '', spendLimitUsd: 0 },
    buildExport: async (a: any) => ({ payload: 'X', channel: a.channel, stored: a.storedSettings }),
    CHANNEL: 'preview',
    exportHooks: () => [],
    skillRegistry: { list: async () => [] },
    ...over,
  };
  return { deps, calls };
};

describe('settings/update', () => {
  test('rejects a non-object patch', async () => {
    const { deps } = baseDeps();
    expect(await makeSettingsRoutes(deps)['settings/update']({ patch: null })).toEqual({ ok: false, error: 'invalid-patch' });
  });
  test('empty normalized patch → no-known-keys', async () => {
    const { deps } = baseDeps({ normalizeSettingsPatch: () => ({}) });
    expect(await makeSettingsRoutes(deps)['settings/update']({ patch: { junk: 1 } })).toEqual({ ok: false, error: 'no-known-keys-in-patch' });
  });
  test('applies vault auto-lock when vaultAutoLockMs present (incl. 0)', async () => {
    const { deps, calls } = baseDeps({ normalizeSettingsPatch: () => ({ vaultAutoLockMs: 0 }) });
    await makeSettingsRoutes(deps)['settings/update']({ patch: { vaultAutoLockMs: 0 } });
    expect(calls.autoLock).toEqual([0]);
    expect(calls.updated).toEqual([{ vaultAutoLockMs: 0 }]);
  });
  test('persists via the store and returns the merged view', async () => {
    const { deps, calls } = baseDeps({ normalizeSettingsPatch: () => ({ providerModel: 'x' }) });
    expect(await makeSettingsRoutes(deps)['settings/update']({ patch: {} })).toEqual({ ok: true, settings: { a: 1 } });
    expect(calls.updated).toEqual([{ providerModel: 'x' }]);
  });
});

describe('settings/reset', () => {
  test('requires a non-empty keys array', async () => {
    const { deps } = baseDeps();
    expect(await makeSettingsRoutes(deps)['settings/reset']({ keys: [] })).toEqual({ ok: false, error: 'keys-required' });
  });
  test('filters to known keys; unknown-only → no-known-keys', async () => {
    const { deps } = baseDeps();
    expect(await makeSettingsRoutes(deps)['settings/reset']({ keys: ['nope'] })).toEqual({ ok: false, error: 'no-known-keys' });
  });
  test('resets known keys via the store', async () => {
    const { deps, calls } = baseDeps();
    expect(await makeSettingsRoutes(deps)['settings/reset']({ keys: ['providerModel', 'nope'] })).toEqual({ ok: true, settings: { a: 1 } });
    expect(calls.reset).toEqual([['providerModel']]);
  });
});

describe('transfer/export', () => {
  test('refused when vault locked', async () => {
    const { deps } = baseDeps({ vault: { isLocked: () => true } });
    expect(await makeSettingsRoutes(deps)['transfer/export']({})).toEqual({ ok: false, error: 'vault-locked' });
  });
  test('requires a passphrase when secrets exist', async () => {
    const { deps } = baseDeps();
    expect(await makeSettingsRoutes(deps)['transfer/export']({ passphrase: 'short' })).toEqual({ ok: false, error: 'passphrase-required' });
  });
  test('builds an export from settingsStore.stored() when authorized', async () => {
    const { deps } = baseDeps();
    const res = await makeSettingsRoutes(deps)['transfer/export']({ passphrase: 'longenough' });
    expect(res.ok).toBe(true);
    expect(res.payload.stored).toEqual({ providerModel: 'm' });
  });
  test('no secrets → no passphrase required', async () => {
    const { deps } = baseDeps({ vault: { isLocked: () => false, listSecretNames: async () => [], getSecret: async () => null } });
    const res = await makeSettingsRoutes(deps)['transfer/export']({});
    expect(res.ok).toBe(true);
  });
});
