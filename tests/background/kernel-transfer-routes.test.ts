import { describe, expect, test } from 'bun:test';
import { makeKernelTransferRoutes } from '../../extension/background/kernel-transfer-routes.js';

class ExportPassphraseError extends Error {}

const transferDeps = (authorization: symbol, over: any = {}) => {
  const effects: string[] = [];
  return {
    privateTransferAuthorization: authorization,
    ensureSettingsReady: async () => {},
    vault: {
      isLocked: () => false,
      listSecretNames: async () => [],
      getSecret: async () => null,
      setSecret: async () => { effects.push('secret'); },
    },
    auditLog: { append: async () => {} },
    pushState: () => {},
    kv: {
      get: async () => null,
      set: async () => { effects.push('endpoints'); },
    },
    memory: {
      exportAll: async () => ({}),
      importAll: async () => { effects.push('memory'); },
    },
    settingsStore: {
      stored: () => ({ theme: 'dark' }),
      update: async () => { effects.push('settings'); },
    },
    buildExport: async ({ storedSettings }: any) => ({ storedSettings }),
    CHANNEL: 'preview',
    exportHooks: () => [],
    skillRegistry: { list: async () => [] },
    dwebTransfer: {
      exportRecord: async () => null,
      prepareRecord: async () => { effects.push('prepare'); return { ok: true }; },
      adoptRecord: async () => { effects.push('identity'); return { ok: true }; },
    },
    EXPORT_PASSPHRASE_MIN_LENGTH: 8,
    isCustodySecretName: () => false,
    inspectImport: ({ payload }: any) => ({ ok: true, summary: payload?.summary }),
    applyImport: async ({ io }: any) => {
      try {
        await io.applySettings({ theme: 'light' });
        await io.setProviderEndpoints([]);
        await io.setSecret('provider', 'secret');
        await io.importMemory({});
        await io.saveHook({ id: 'hook-1' });
        await io.adoptDwebIdentity({}, 'passphrase', { prepareOnly: true });
        await io.adoptDwebIdentity({}, 'passphrase', {});
        return { ok: true, imported: { settings: 1, secrets: 1 } };
      } catch {
        return { ok: false, error: 'import-partial', partial: { settings: 0 } };
      }
    },
    DEFAULT_SETTINGS: { theme: 'system' },
    ExportPassphraseError,
    normalizeImportedSettings: (patch: any) => patch,
    onSettingsChanging: () => {},
    onSettingsChanged: async () => {},
    loadUserEndpoints: async () => {},
    saveUserHook: async () => { effects.push('hook'); },
    onProviderConfigChanged: () => {},
    effects,
    ...over,
  };
};

describe('kernel transfer routes', () => {
  test('the private capability refuses before loading transfer dependencies', async () => {
    const authorization = Symbol('private');
    let loads = 0;
    const routes = makeKernelTransferRoutes({
      privateTransferAuthorization: authorization,
      load: async () => { loads += 1; return transferDeps(authorization); },
    });
    expect(await routes['transfer/export']({})).toEqual({
      ok: false, error: 'private-transfer-required',
    });
    expect(await routes['transfer/inspectImport']({
      privateTransferAuthorization: Symbol('forged'),
    })).toEqual({ ok: false, error: 'private-transfer-required' });
    expect(await routes['transfer/import']({})).toEqual({
      ok: false, error: 'private-transfer-required',
    });
    expect(loads).toBe(0);
  });

  test('authorized reads preserve their existing contracts', async () => {
    const authorization = Symbol('private');
    const routes = makeKernelTransferRoutes({
      privateTransferAuthorization: authorization,
      load: async () => transferDeps(Symbol('untrusted-rich-token')),
    });
    expect(await routes['transfer/export']({
      privateTransferAuthorization: authorization,
    })).toMatchObject({
      ok: true, payload: { storedSettings: { theme: 'dark' } },
    });
    expect(await routes['transfer/inspectImport']({
      privateTransferAuthorization: authorization, payload: { summary: 'safe' },
    })).toEqual({ ok: true, summary: 'safe' });
  });

  test('authorized import fences every mutating collaborator', async () => {
    const authorization = Symbol('private');
    const deps = transferDeps(authorization);
    const routes = makeKernelTransferRoutes(deps);
    expect(await routes['transfer/import']({
      privateTransferAuthorization: authorization,
      payload: { dweb: { identityRecord: {} } },
    })).toEqual({ ok: true, imported: { settings: 1, secrets: 1 } });
    expect(deps.effects).toEqual([
      'settings', 'endpoints', 'secret', 'memory', 'hook', 'prepare', 'identity',
    ]);
  });

  test('lost import receipts are unknown and pre-effect write refusal stays known', async () => {
    const authorization = Symbol('private');
    const lost = makeKernelTransferRoutes(transferDeps(authorization, {
      settingsStore: {
        stored: () => ({}),
        update: async () => { throw new Error('reply lost'); },
      },
    }));
    expect(await lost['transfer/import']({
      privateTransferAuthorization: authorization, payload: {},
    })).toMatchObject({
      ok: false, code: 'transfer-import-outcome-unknown', outcomeKnown: false,
    });

    const lifecycleLost = makeKernelTransferRoutes(transferDeps(authorization, {
      onSettingsChanged: async () => { throw new Error('feature stop receipt lost'); },
    }));
    expect(await lifecycleLost['transfer/import']({
      privateTransferAuthorization: authorization, payload: {},
    })).toMatchObject({
      ok: false, code: 'transfer-import-outcome-unknown', outcomeKnown: false,
    });

    const refused = makeKernelTransferRoutes(transferDeps(authorization, {
      canWrite: () => { throw new Error('profile is read-only'); },
    }));
    expect(await refused['transfer/import']({
      privateTransferAuthorization: authorization, payload: {},
    })).toMatchObject({
      ok: false, error: 'profile is read-only',
      code: 'transfer-import-refused', outcomeKnown: true,
    });

    const limited = makeKernelTransferRoutes(transferDeps(authorization, {
      applyImport: async () => {
        const cause: any = new Error('hook limit exceeded before import');
        cause.code = 'hook-records-limit';
        throw cause;
      },
    }));
    expect(await limited['transfer/import']({
      privateTransferAuthorization: authorization, payload: {},
    })).toEqual({
      ok: false, error: 'hook limit exceeded before import',
      code: 'hook-records-limit', outcomeKnown: true,
    });

    let guards = 0;
    const partial = makeKernelTransferRoutes(transferDeps(authorization, {
      canWrite: () => {
        guards += 1;
        if (guards === 2) throw new Error('profile became read-only');
      },
    }));
    expect(await partial['transfer/import']({
      privateTransferAuthorization: authorization, payload: {},
    })).toMatchObject({
      ok: false, code: 'transfer-import-outcome-unknown', outcomeKnown: false,
    });

    const exactPartial = makeKernelTransferRoutes(transferDeps(authorization, {
      applyImport: async ({ io }: any) => {
        await io.applySettings({ theme: 'light' });
        return { ok: false, error: 'import-partial', partial: { settings: 1 } };
      },
    }));
    expect(await exactPartial['transfer/import']({
      privateTransferAuthorization: authorization, payload: {},
    })).toEqual({ ok: false, error: 'import-partial', partial: { settings: 1 } });
  });
});
