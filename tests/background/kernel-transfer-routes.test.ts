import { describe, expect, test } from 'bun:test';
import { createKernelPrivateTransferOwner } from '../../extension/background/kernel-private-transfer-owner.js';
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

describe('kernel private transfer owner', () => {
  test('only the exact options sender can attach the hidden capability port', async () => {
    const optionsSender = { url: 'moz-extension://peerd/options.html' };
    const authorizationSeen: symbol[] = [];
    const owner = createKernelPrivateTransferOwner({
      isOptionsSender: (sender: any) => sender === optionsSender,
      makeHandlers: (authorization: symbol) => ({
        'transfer/export': async (message: any) => {
          authorizationSeen.push(message.privateTransferAuthorization);
          return { ok: true };
        },
      }),
      listWindowClients: async () => [],
      optionsUrl: optionsSender.url,
    });
    let disconnected = 0;
    const refusedPort: any = {
      sender: { url: 'moz-extension://peerd/sidepanel.html' },
      disconnect: () => { disconnected += 1; },
    };
    expect(owner.attach(refusedPort)).toBe(false);
    expect(disconnected).toBe(1);

    const listeners: Array<(message: any) => void> = [];
    const replies: any[] = [];
    const port: any = {
      sender: optionsSender,
      onMessage: { addListener: (listener: (message: any) => void) => { listeners.push(listener); } },
      onDisconnect: { addListener: () => {} },
      postMessage: (message: any) => { replies.push(message); },
    };
    expect(owner.attach(port)).toBe(true);
    listeners[0]({
      type: 'private-transfer/request', requestId: 'request-1',
      message: { type: 'transfer/export' },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(replies[0]).toMatchObject({
      type: 'private-transfer/response', requestId: 'request-1', ok: true,
      reply: { ok: true },
    });
    expect(typeof authorizationSeen[0]).toBe('symbol');
  });

  test('Firefox exposes the exact options Port without a WindowClient route', () => {
    const owner = createKernelPrivateTransferOwner({
      isOptionsSender: () => true,
      makeHandlers: () => ({}),
    });
    expect(owner.routes).toEqual({});
  });

  test('channel creation refuses forged senders before client lookup', async () => {
    const optionsSender = { url: 'chrome-extension://peerd/options.html' };
    let lookups = 0;
    const channel = new MessageChannel();
    const offers: any[] = [];
    const owner = createKernelPrivateTransferOwner({
      isOptionsSender: (sender: any) => sender === optionsSender,
      makeHandlers: () => ({}),
      listWindowClients: async () => {
        lookups += 1;
        return [{
          url: optionsSender.url,
          postMessage: (message: any, transfer: any[]) => { offers.push({ message, transfer }); },
        }];
      },
      optionsUrl: optionsSender.url,
      createChannel: () => channel,
    });
    const open = owner.routes['private-transfer/open'];
    if (!open) throw new Error('private transfer route missing');
    expect(await open(
      { requestId: 'request-1' }, { url: optionsSender.url },
    )).toEqual({ ok: false, error: 'private-transfer-channel-refused' });
    expect(lookups).toBe(0);
    expect(await open(
      { requestId: 'request-1' }, optionsSender,
    )).toEqual({ ok: true });
    expect(offers[0]).toMatchObject({
      message: { type: 'private-transfer/channel', requestId: 'request-1' },
    });
    expect(offers[0].transfer[0]).toBe(channel.port2);
    channel.port1.close();
    channel.port2.close();
  });
});
