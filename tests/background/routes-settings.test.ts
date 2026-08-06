import { describe, test, expect } from 'bun:test';
import { makeSettingsRoutes } from '../../extension/background/routes/settings.js';

const PRIVATE_TRANSFER_AUTHORIZATION = Symbol('test-transfer');
const authorized = (message: Record<string, unknown> = {}) => ({
  ...message, privateTransferAuthorization: PRIVATE_TRANSFER_AUTHORIZATION,
});

// settings/update + settings/reset + transfer/export, now over settingsStore.
// Pin: patch normalization is delegated, the vault auto-lock side effect fires,
// reset filters to known keys, and export gates on a passphrase when secrets exist.

const baseDeps = (over: any = {}) => {
  const calls: any = { autoLock: [], updated: [], reset: [], getSecret: [], identityExport: [], changing: [], changed: [] };
  const deps = {
    vault: {
      setAutoLockMs: (v: number) => { calls.autoLock.push(v); },
      isLocked: () => false,
      listSecretNames: async () => ['anthropic.key'],
      getSecret: async (name: string) => { calls.getSecret.push(name); return 'sk-secret'; },
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
    dwebTransfer: {
      exportRecord: async (passphrase: string) => { calls.identityExport.push(passphrase); return null; },
    },
    EXPORT_PASSPHRASE_MIN_LENGTH: 16,
    isCustodySecretName: (name: string) => name.startsWith('distributed/identity/')
      || name.startsWith('distributed/device-key/'),
    CHANNEL: 'preview',
    exportHooks: () => [],
    skillRegistry: { list: async () => [] },
    onSettingsChanging: (patch: any) => { calls.changing.push(patch); },
    onSettingsChanged: async (patch: any) => { calls.changed.push(patch); },
    privateTransferAuthorization: PRIVATE_TRANSFER_AUTHORIZATION,
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
  test('waits for dweb disable side effects before acknowledging the setting', async () => {
    let finishStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { finishStop = resolve; });
    let settled = false;
    const { deps, calls } = baseDeps({
      normalizeSettingsPatch: () => ({ dwebEnabled: false }),
      onSettingsChanged: async () => { await stopGate; calls.changed.push('stopped'); },
    });
    const updating = makeSettingsRoutes(deps)['settings/update']({ patch: { dwebEnabled: false } })
      .then((result: any) => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(calls.changing).toEqual([{ dwebEnabled: false }]);
    finishStop();
    expect(await updating).toEqual({ ok: true, settings: { a: 1 } });
    expect(calls.changed).toEqual(['stopped']);
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
  test('resetting a preview dweb default does not invalidate admitted work', async () => {
    const { deps, calls } = baseDeps({
      DEFAULT_SETTINGS: { dwebEnabled: true },
      settingsStore: {
        get: () => ({ dwebEnabled: true }),
        stored: () => ({}),
        update: async () => {},
        reset: async (keys: string[]) => { calls.reset.push(keys); },
      },
    });
    expect(await makeSettingsRoutes(deps)['settings/reset']({ keys: ['dwebEnabled'] }))
      .toEqual({ ok: true, settings: { dwebEnabled: true } });
    expect(calls.changing).toEqual([]);
    expect(calls.changed).toEqual([{ dwebEnabled: true }]);
  });
  test('resetting a store dweb default invalidates before persistence', async () => {
    const events: string[] = [];
    const { deps } = baseDeps({
      DEFAULT_SETTINGS: { dwebEnabled: false },
      settingsStore: {
        get: () => ({ dwebEnabled: false }),
        stored: () => ({}),
        update: async () => {},
        reset: async () => { events.push('reset'); },
      },
      onSettingsChanging: () => { events.push('invalidate'); },
      onSettingsChanged: async () => { events.push('changed'); },
    });
    await makeSettingsRoutes(deps)['settings/reset']({ keys: ['dwebEnabled'] });
    expect(events).toEqual(['invalidate', 'reset', 'changed']);
  });
});

describe('transfer/export', () => {
  test('requires the private transfer capability', async () => {
    const { deps } = baseDeps();
    expect(await makeSettingsRoutes(deps)['transfer/export']({ passphrase: 'long-enough-for-backup' }))
      .toEqual({ ok: false, error: 'private-transfer-required' });
  });
  test('refused when vault locked', async () => {
    const { deps } = baseDeps({ vault: { isLocked: () => true } });
    expect(await makeSettingsRoutes(deps)['transfer/export'](authorized())).toEqual({ ok: false, error: 'vault-locked' });
  });
  test('requires a passphrase when secrets exist', async () => {
    const { deps } = baseDeps();
    expect(await makeSettingsRoutes(deps)['transfer/export'](authorized({ passphrase: 'short' }))).toEqual({ ok: false, error: 'passphrase-required' });
  });
  test('builds an export from settingsStore.stored() when authorized', async () => {
    const { deps } = baseDeps();
    const res = await makeSettingsRoutes(deps)['transfer/export'](authorized({ passphrase: 'long-enough-for-backup' }));
    expect(res.ok).toBe(true);
    expect(res.payload.stored).toEqual({ providerModel: 'm' });
  });
  test('no secrets → no passphrase required', async () => {
    const { deps } = baseDeps({ vault: { isLocked: () => false, listSecretNames: async () => [], getSecret: async () => null } });
    const res = await makeSettingsRoutes(deps)['transfer/export'](authorized());
    expect(res.ok).toBe(true);
  });

  test('custody secrets are never decrypted and the portable identity is reported', async () => {
    const identityRecord = { did: 'did:key:zPortable' };
    const decrypted: string[] = [];
    const identityExports: string[] = [];
    const { deps } = baseDeps({
      vault: {
        isLocked: () => false,
        listSecretNames: async () => ['anthropic.key', 'distributed/identity/v1'],
        getSecret: async (name: string) => { decrypted.push(name); return 'secret'; },
      },
      dwebTransfer: {
        exportRecord: async (passphrase: string) => {
          identityExports.push(passphrase);
          return { identityRecord };
        },
      },
    });
    const res = await makeSettingsRoutes(deps)['transfer/export'](authorized({ passphrase: 'long-enough-for-backup' }));
    expect(res.ok).toBe(true);
    expect(decrypted).toEqual(['anthropic.key']);
    expect(identityExports).toEqual(['long-enough-for-backup']);
    expect(res.identityIncluded).toBe(true);
    expect(res.identityDid).toBe(identityRecord.did);
  });

  test('fails loudly when a local identity cannot be included', async () => {
    const { deps } = baseDeps({
      dwebTransfer: { exportRecord: async () => { throw new Error('offscreen failed'); } },
    });
    expect(await makeSettingsRoutes(deps)['transfer/export'](authorized({ passphrase: 'long-enough-for-backup' })))
      .toEqual({ ok: false, error: 'identity-export-failed' });
  });
});
