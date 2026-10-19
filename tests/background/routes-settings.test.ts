import { describe, test, expect } from 'bun:test';
import { makeKernelSettingsRoutes } from '../../extension/background/settings-patch.js';
import { makeSettingsRoutes } from '../../extension/background/routes/settings.js';

const PRIVATE_TRANSFER_AUTHORIZATION = Symbol('test-transfer');
const authorized = (message: Record<string, unknown> = {}) => ({
  ...message, privateTransferAuthorization: PRIVATE_TRANSFER_AUTHORIZATION,
});

// Exercise mutations through the production native owner, and private export
// through the separate transfer-only factory.

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
    ensureSettingsReady: async () => {},
    ...over,
  };
  return { deps, calls };
};

const mutationRoutes = (deps: any) => makeKernelSettingsRoutes({
  ready: deps.ensureSettingsReady(), settingsStore: deps.settingsStore,
  defaults: deps.DEFAULT_SETTINGS, knownProviderNames: deps.listProviders().map((p: any) => p.name),
  dwebEnabled: true, normalizeVariant: deps.normalizeVariant, normalizeEngine: deps.normalizeEngine,
  onChanging: deps.onSettingsChanging, onChanged: deps.onSettingsChanged, pushState: deps.pushState,
});

test('private export factory exposes no second settings mutation authority', () => {
  expect(Object.keys(makeSettingsRoutes(baseDeps().deps))).toEqual(['transfer/export']);
});

describe('settings/update', () => {
  test('rejects a non-object patch', async () => {
    const { deps } = baseDeps();
    expect(await mutationRoutes(deps)['settings/update']({ patch: null })).toEqual({ ok: false, error: 'invalid-patch' });
  });
  test('empty normalized patch → no-known-keys', async () => {
    const { deps } = baseDeps();
    expect(await mutationRoutes(deps)['settings/update']({ patch: { junk: 1 } })).toEqual({ ok: false, error: 'no-known-keys-in-patch' });
  });
  test('persists auto-lock and forwards it to the centralized side-effect hook', async () => {
    const { deps, calls } = baseDeps();
    await mutationRoutes(deps)['settings/update']({ patch: { vaultAutoLockMs: 0 } });
    expect(calls.autoLock).toEqual([]);
    expect(calls.updated).toEqual([{ vaultAutoLockMs: 0 }]);
    expect(calls.changed).toEqual([{ vaultAutoLockMs: 0 }]);
  });
  test('persists via the store and returns the merged view', async () => {
    const { deps, calls } = baseDeps();
    expect(await mutationRoutes(deps)['settings/update']({ patch: { providerModel: 'x' } })).toEqual({ ok: true, settings: { a: 1 } });
    expect(calls.updated).toEqual([{ providerModel: 'x' }]);
  });
  test('waits for dweb disable side effects before acknowledging the setting', async () => {
    let finishStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { finishStop = resolve; });
    let settled = false;
    const { deps, calls } = baseDeps({
      onSettingsChanged: async () => { await stopGate; calls.changed.push('stopped'); },
    });
    const updating = mutationRoutes(deps)['settings/update']({ patch: { dwebEnabled: false } })
      .then((result: any) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(calls.changing).toEqual([{ dwebEnabled: false }]);
    finishStop();
    expect(await updating).toEqual({ ok: true, settings: { a: 1 } });
    expect(calls.changed).toEqual(['stopped']);
  });
  test('a storage or lifecycle loss after dispatch is unknown and hides internals', async () => {
    for (const over of [
      { settingsStore: {
        get: () => ({ a: 1 }), stored: () => ({}), reset: async () => {},
        update: async () => { throw new Error('private-storage-detail'); },
      } },
      { onSettingsChanged: async () => { throw new Error('private-host-epoch'); } },
    ]) {
      const { deps } = baseDeps(over);
      const reply = await mutationRoutes(deps)['settings/update']({ patch: { providerModel: 'x' } });
      expect(reply).toMatchObject({
        ok: false, code: 'settings-update-outcome-unknown',
        outcomeKnown: false, outcomeKind: 'unknown', retryable: false,
        settings: { a: 1 },
      });
      expect(reply.error).not.toMatch(/private-storage|private-host/);
    }
  });
});

describe('settings hydration gate', () => {
  test('does not export the stored-settings snapshot before hydration finishes', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    let hydrated = false;
    const { deps } = baseDeps({
      ensureSettingsReady: async () => { await ready; hydrated = true; },
      settingsStore: {
        get: () => ({}),
        stored: () => hydrated ? { providerName: 'ollama' } : {},
        update: async () => {},
        reset: async () => {},
      },
      vault: {
        isLocked: () => false,
        listSecretNames: async () => [],
        getSecret: async () => null,
      },
    });
    const exporting = makeSettingsRoutes(deps)['transfer/export'](authorized({ passphrase: '' }));
    await Promise.resolve();
    release();
    const result = await exporting;
    expect(result.payload.stored).toEqual({ providerName: 'ollama' });
  });
});

describe('settings/reset', () => {
  test('requires a non-empty keys array', async () => {
    const { deps } = baseDeps();
    expect(await mutationRoutes(deps)['settings/reset']({ keys: [] })).toEqual({ ok: false, error: 'keys-required' });
  });
  test('filters to known keys; unknown-only → no-known-keys', async () => {
    const { deps } = baseDeps();
    expect(await mutationRoutes(deps)['settings/reset']({ keys: ['nope'] })).toEqual({ ok: false, error: 'no-known-keys' });
  });
  test('resets known keys via the store', async () => {
    const { deps, calls } = baseDeps();
    expect(await mutationRoutes(deps)['settings/reset']({ keys: ['providerModel', 'nope'] })).toEqual({ ok: true, settings: { a: 1 } });
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
    expect(await mutationRoutes(deps)['settings/reset']({ keys: ['dwebEnabled'] }))
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
    await mutationRoutes(deps)['settings/reset']({ keys: ['dwebEnabled'] });
    expect(events).toEqual(['invalidate', 'reset', 'changed']);
  });
  test('a lost reset result is unknown and never exposes storage details', async () => {
    const { deps } = baseDeps({
      settingsStore: {
        get: () => ({ providerModel: 'default' }), stored: () => ({}), update: async () => {},
        reset: async () => { throw new Error('private-reset-transaction'); },
      },
    });
    const reply = await mutationRoutes(deps)['settings/reset']({ keys: ['providerModel'] });
    expect(reply).toMatchObject({
      ok: false, code: 'settings-reset-outcome-unknown',
      outcomeKnown: false, retryable: false,
      settings: { providerModel: 'default' },
    });
    expect(reply.error).not.toContain('private-reset');
  });
  test('resetting voice to its OFF default forwards the concrete disable transition', async () => {
    const { deps, calls } = baseDeps({
      DEFAULT_SETTINGS: { voiceEnabled: false },
      settingsStore: {
        get: () => ({ voiceEnabled: false }),
        stored: () => ({}),
        update: async () => {},
        reset: async (keys: string[]) => { calls.reset.push(keys); },
      },
    });
    await mutationRoutes(deps)['settings/reset']({ keys: ['voiceEnabled'] });
    expect(calls.reset).toEqual([['voiceEnabled']]);
    expect(calls.changed).toEqual([{ voiceEnabled: false }]);
  });
  test('resetting the preview update check re-syncs its live listener', async () => {
    const { deps, calls } = baseDeps({
      DEFAULT_SETTINGS: { autoUpdateEnabled: true },
      settingsStore: {
        get: () => ({ autoUpdateEnabled: true }),
        stored: () => ({}),
        update: async () => {},
        reset: async (keys: string[]) => { calls.reset.push(keys); },
      },
    });
    await mutationRoutes(deps)['settings/reset']({ keys: ['autoUpdateEnabled'] });
    expect(calls.reset).toEqual([['autoUpdateEnabled']]);
    expect(calls.changed).toEqual([{ autoUpdateEnabled: true }]);
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

  test('Store exports remain available when no dweb identity owner exists', async () => {
    const { deps } = baseDeps({ dwebTransfer: null, CHANNEL: 'store' });
    const res = await makeSettingsRoutes(deps)['transfer/export'](authorized({
      passphrase: 'long-enough-for-backup',
    }));
    expect(res).toMatchObject({ ok: true, identityIncluded: false, identityDid: null });
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
    deps.settingsStore.get = () => ({ dwebEnabled: true });
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
    deps.settingsStore.get = () => ({ dwebEnabled: true });
    deps.vault.listSecretNames = async () => ['distributed/identity/v1'];
    expect(await makeSettingsRoutes(deps)['transfer/export'](authorized({ passphrase: 'long-enough-for-backup' })))
      .toEqual({ ok: false, error: 'identity-export-failed' });
  });
});

describe('offline backup identity policy', () => {
  for (const names of [[], ['anthropic.key'], ['distributed/device-key/v1', 'distributed/self-records/v1']]) {
    test(`network off exports without waking custody when no identity exists: ${names.join(',') || 'empty vault'}`, async () => {
      const { deps, calls } = baseDeps();
      deps.vault.listSecretNames = async () => names;
      let input: any;
      const build = deps.buildExport;
      deps.buildExport = async (value: any) => { input = value; return build(value); };
      const reply = await makeSettingsRoutes(deps)['transfer/export'](authorized({ passphrase: 'long-enough-for-backup' }));
      expect(reply).toMatchObject({ ok: true, identityIncluded: false, identityDid: null });
      expect(calls.identityExport).toEqual([]);
      expect(calls.getSecret).toEqual(names.filter((name) => !deps.isCustodySecretName(name)));
      expect(input).toMatchObject({
        storedSettings: { providerModel: 'm' }, memory: { docs: [] }, hooks: [], skills: [], providerEndpoints: null, dweb: null,
      });
      expect(Object.keys(input.secrets)).toEqual(calls.getSecret);
    });
  }

  for (const name of ['distributed/identity/v1', 'distributed/identity/v2']) {
    test(`network off refuses before decryption or backup creation when ${name} exists`, async () => {
      const { deps, calls } = baseDeps();
      deps.vault.listSecretNames = async () => ['anthropic.key', name];
      let builds = 0;
      deps.buildExport = async () => { builds += 1; return {}; };
      expect(await makeSettingsRoutes(deps)['transfer/export'](authorized({ passphrase: 'long-enough-for-backup' })))
        .toEqual({ ok: false, error: 'identity-export-network-off' });
      expect(calls.identityExport).toEqual([]);
      expect(calls.getSecret).toEqual([]);
      expect(builds).toBe(0);
    });
  }

  for (const initiallyEnabled of [false, true]) {
    test(`one network snapshot controls the export when it starts ${initiallyEnabled ? 'on' : 'off'}`, async () => {
      const { deps, calls } = baseDeps();
      let enabled = initiallyEnabled;
      let reads = 0;
      deps.settingsStore.get = () => { reads += 1; return { dwebEnabled: enabled }; };
      deps.vault.getSecret = async (name: string) => {
        calls.getSecret.push(name); enabled = !initiallyEnabled; return 'sk-secret';
      };
      deps.dwebTransfer.exportRecord = async () => {
        calls.identityExport.push('host'); throw new Error('host unavailable after choice changed');
      };
      const reply = await makeSettingsRoutes(deps)['transfer/export'](authorized({ passphrase: 'long-enough-for-backup' }));
      expect(reads).toBe(1);
      expect(enabled).toBe(!initiallyEnabled);
      expect(calls.identityExport).toEqual(initiallyEnabled ? ['host'] : []);
      expect(reply).toMatchObject(initiallyEnabled
        ? { ok: false, error: 'identity-export-failed' }
        : { ok: true, identityIncluded: false, identityDid: null });
    });
  }

  test('network on still reaches custody with no identity and keeps its host fault distinct', async () => {
    const { deps, calls } = baseDeps();
    deps.settingsStore.get = () => ({ dwebEnabled: true });
    deps.vault.listSecretNames = async () => [];
    deps.dwebTransfer.exportRecord = async () => {
      calls.identityExport.push('host'); throw new Error('custody host failed');
    };
    let builds = 0;
    deps.buildExport = async () => { builds += 1; return {}; };
    expect(await makeSettingsRoutes(deps)['transfer/export'](authorized({ passphrase: 'long-enough-for-backup' })))
      .toEqual({ ok: false, error: 'identity-export-failed' });
    expect(calls.identityExport).toEqual(['host']);
    expect(builds).toBe(0);
  });

  test('a Store backup needs neither a custody owner nor a network-setting read', async () => {
    const { deps } = baseDeps({ dwebTransfer: null, CHANNEL: 'store' });
    deps.settingsStore.get = () => { throw new Error('unexpected network read'); };
    expect(await makeSettingsRoutes(deps)['transfer/export'](authorized({ passphrase: 'long-enough-for-backup' })))
      .toMatchObject({ ok: true, identityIncluded: false, identityDid: null });
  });
});
