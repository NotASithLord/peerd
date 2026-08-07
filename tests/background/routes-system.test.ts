import { describe, test, expect } from 'bun:test';
import { makeSystemRoutes } from '../../extension/background/routes/system.js';

class ExportPassphraseError extends Error {}

const PRIVATE_TRANSFER_AUTHORIZATION = Symbol('test-transfer');
const authorized = (message: Record<string, unknown> = {}) => ({
  ...message, privateTransferAuthorization: PRIVATE_TRANSFER_AUTHORIZATION,
});

const baseDeps = (over: any = {}) => ({
  vault: { isLocked: () => false, setSecret: async () => {} },
  auditLog: { append: async () => {}, list: async () => [{ id: 1 }, { id: 2 }, { id: 3 }] },
  sessions: { list: async () => [
    { cost: { inputTokens: 100, outputTokens: 50, cost: 0.01 } },
    { cost: { inputTokens: 0, outputTokens: 0, cost: 0 } },        // skipped (no usage, no cost)
    { cost: { cacheReadTokens: 10, cost: 0.002 } },
    {},                                                            // no cost field
  ] },
  pushState: () => {},
  kv: { set: async () => {} },
  memory: { importAll: async () => {} },
  buildStateSnapshot: async () => ({ vault: { locked: false }, session: {} }),
  closeSidePanel: async () => ({ ok: true }),
  uiPorts: { hasNamed: (n: string) => n === 'sidepanel' },
  loadUserEndpoints: async () => {},
  inspectImport: async (a: any) => ({ ok: true, channel: a.channel, keys: a.knownSettingKeys }),
  applyImport: async (_a: any) => ({ ok: true, imported: { secrets: 1 } }),
  settingsStore: { update: async () => {} },
  saveUserHook: async () => {},
  dwebTransfer: { adoptRecord: async () => ({ adopted: true, reason: 'recovered' }) },
  CHANNEL: 'preview',
  DEFAULT_SETTINGS: { a: 1, b: 2 },
  ExportPassphraseError,
  onSettingsChanging: () => {},
  onSettingsChanged: async () => {},
  privateTransferAuthorization: PRIVATE_TRANSFER_AUTHORIZATION,
  retryActorIsolation: async () => ({ ok: true, capability: { status: 'available' } }),
  ...over,
});

describe('state/get + audit/list', () => {
  test('state/get wraps the snapshot', async () => {
    const r = makeSystemRoutes(baseDeps());
    expect(await r['state/get']()).toEqual({ ok: true, state: { vault: { locked: false }, session: {} } });
  });
  test('actor isolation retry delegates to the capability controller', async () => {
    const r = makeSystemRoutes(baseDeps());
    expect(await r['actor-isolation/retry']()).toEqual({ ok: true, capability: { status: 'available' } });
  });
  test('audit/list newest-first, capped, with total', async () => {
    const r = makeSystemRoutes(baseDeps());
    const res = await r['audit/list']({ limit: 2 });
    expect(res).toEqual({ ok: true, entries: [{ id: 3 }, { id: 2 }], total: 3 });
  });
  test('audit/list surfaces an error as ok:false', async () => {
    const r = makeSystemRoutes(baseDeps({ auditLog: { list: async () => { throw new Error('idb'); } } }));
    expect(await r['audit/list']({})).toEqual({ ok: false, error: 'idb' });
  });
  test('audit/voice-fetch truncates url + type-locks', async () => {
    let appended: any;
    const r = makeSystemRoutes(baseDeps({ auditLog: { append: async (e: any) => { appended = e; } } }));
    await r['audit/voice-fetch']({ url: 'x'.repeat(400), type: 'forged' });
    expect(appended.type).toBe('voice_model_fetch');
    expect(appended.details.url.length).toBe(300);
  });
});

describe('cost/total', () => {
  test('sums only sessions with usage or spend', async () => {
    const r = makeSystemRoutes(baseDeps());
    const res = await r['cost/total']();
    expect(res.ok).toBe(true);
    expect(res.chats).toBe(2);
    expect(res.tokens).toBe(160);
    expect(res.usd).toBeCloseTo(0.012, 6);
  });
  test('locked → locked', async () => {
    const r = makeSystemRoutes(baseDeps({ vault: { isLocked: () => true } }));
    expect(await r['cost/total']()).toEqual({ ok: false, error: 'locked' });
  });
});

describe('surfaces + sidepanel', () => {
  test('surfaces/get reports side panel open state', async () => {
    const r = makeSystemRoutes(baseDeps());
    expect(await r['surfaces/get']()).toEqual({ ok: true, sidePanelOpen: true });
  });
  test('sidepanel/close delegates', async () => {
    const r = makeSystemRoutes(baseDeps());
    expect(await r['sidepanel/close']()).toEqual({ ok: true });
  });
});

describe('transfer import', () => {
  test('requires the private transfer capability', async () => {
    const r = makeSystemRoutes(baseDeps());
    expect(await r['transfer/inspectImport']({ payload: {} }))
      .toEqual({ ok: false, error: 'private-transfer-required' });
    expect(await r['transfer/import']({ payload: {} }))
      .toEqual({ ok: false, error: 'private-transfer-required' });
  });
  test('inspectImport passes channel + known keys', async () => {
    const r = makeSystemRoutes(baseDeps());
    expect(await r['transfer/inspectImport'](authorized({ payload: {} }))).toEqual({ ok: true, channel: 'preview', keys: ['a', 'b'] });
  });
  test('import with secrets refused when vault locked', async () => {
    const r = makeSystemRoutes(baseDeps({ vault: { isLocked: () => true } }));
    expect(await r['transfer/import'](authorized({ payload: { secrets: {} } }))).toEqual({ ok: false, error: 'vault-locked' });
  });
  test('identity-only import is also refused when vault locked', async () => {
    const r = makeSystemRoutes(baseDeps({ vault: { isLocked: () => true } }));
    expect(await r['transfer/import'](authorized({ payload: { dweb: { identityRecord: {} } } })))
      .toEqual({ ok: false, error: 'vault-locked' });
  });
  test('import audits + pushes on success', async () => {
    let pushed = false; let audited = false;
    const r = makeSystemRoutes(baseDeps({
      pushState: () => { pushed = true; },
      auditLog: { append: async () => { audited = true; }, list: async () => [] },
    }));
    expect(await r['transfer/import'](authorized({ payload: {} }))).toEqual({ ok: true, imported: { secrets: 1 } });
    expect(pushed).toBe(true);
    expect(audited).toBe(true);
  });
  test('settings import runs dweb lifecycle hooks around the durable write', async () => {
    const events: string[] = [];
    const r = makeSystemRoutes(baseDeps({
      applyImport: async ({ io }: any) => {
        await io.applySettings({ dwebEnabled: false });
        return { ok: true, imported: { settings: 1 } };
      },
      settingsStore: { update: async () => { events.push('persist'); } },
      onSettingsChanging: () => { events.push('close'); },
      onSettingsChanged: async () => { events.push('stop'); },
    }));
    expect((await r['transfer/import'](authorized({ payload: {} }))).ok).toBe(true);
    expect(events).toEqual(['close', 'persist', 'stop']);
  });
  test('partial import audits committed counts and refreshes visible state', async () => {
    let pushed = false; let event: any;
    const partial = { settings: 2, secrets: 1, memoryWritten: 0, hooks: 0, dwebIdentity: 0 };
    const r = makeSystemRoutes(baseDeps({
      applyImport: async () => ({ ok: false, error: 'import-partial', failure: 'dweb-identity-stop-failed', partial }),
      pushState: () => { pushed = true; },
      auditLog: { append: async (value: any) => { event = value; }, list: async () => [] },
    }));
    expect(await r['transfer/import'](authorized({ payload: {} }))).toMatchObject({ ok: false, partial });
    expect(event).toEqual({
      type: 'settings_import_partial', counts: partial,
      details: { failure: 'dweb-identity-stop-failed' },
    });
    expect(pushed).toBe(true);
  });
  test('wrong export passphrase mapped', async () => {
    const r = makeSystemRoutes(baseDeps({ applyImport: async () => { throw new ExportPassphraseError(); } }));
    expect(await r['transfer/import'](authorized({ payload: {} }))).toEqual({ ok: false, error: 'wrong-passphrase' });
  });
  test('passes explicit identity conflict choices to the import core', async () => {
    let received: any;
    const r = makeSystemRoutes(baseDeps({
      applyImport: async (args: any) => { received = args; return { ok: false, error: 'dweb-identity-conflict' }; },
    }));
    await r['transfer/import'](authorized({
      payload: { dweb: { identityRecord: {} } },
      replaceDwebIdentity: true,
      skipDwebIdentity: false,
      approvedExistingDwebDid: 'did:key:zOld',
      approvedIncomingDwebDid: 'did:key:zNew',
    }));
    expect(received.replaceDwebIdentity).toBe(true);
    expect(received.skipDwebIdentity).toBe(false);
    expect(received.approvedExistingDwebDid).toBe('did:key:zOld');
    expect(received.approvedIncomingDwebDid).toBe('did:key:zNew');
    expect(received.io.adoptDwebIdentity).toBeFunction();
  });
  test('identity transfer infrastructure errors are mapped', async () => {
    const error = Object.assign(new Error('offscreen unavailable'), {
      name: 'IdentityTransferError', code: 'host-unavailable',
    });
    const r = makeSystemRoutes(baseDeps({ applyImport: async () => { throw error; } }));
    expect(await r['transfer/import'](authorized({ payload: {} })))
      .toEqual({ ok: false, error: 'dweb-identity-host-unavailable' });
  });
  test('unexpected import error rethrown', async () => {
    const r = makeSystemRoutes(baseDeps({ applyImport: async () => { throw new Error('disk'); } }));
    await expect(r['transfer/import'](authorized({ payload: {} }))).rejects.toThrow('disk');
  });
});
