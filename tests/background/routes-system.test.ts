import { describe, test, expect } from 'bun:test';
import { makeSystemRoutes } from '../../extension/background/routes/system.js';

class ExportPassphraseError extends Error {}

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
  CHANNEL: 'preview',
  DEFAULT_SETTINGS: { a: 1, b: 2 },
  ExportPassphraseError,
  ...over,
});

describe('state/get + audit/list', () => {
  test('state/get wraps the snapshot', async () => {
    const r = makeSystemRoutes(baseDeps());
    expect(await r['state/get']()).toEqual({ ok: true, state: { vault: { locked: false }, session: {} } });
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
  test('inspectImport passes channel + known keys', async () => {
    const r = makeSystemRoutes(baseDeps());
    expect(await r['transfer/inspectImport']({ payload: {} })).toEqual({ ok: true, channel: 'preview', keys: ['a', 'b'] });
  });
  test('import with secrets refused when vault locked', async () => {
    const r = makeSystemRoutes(baseDeps({ vault: { isLocked: () => true } }));
    expect(await r['transfer/import']({ payload: { secrets: {} } })).toEqual({ ok: false, error: 'vault-locked' });
  });
  test('import audits + pushes on success', async () => {
    let pushed = false; let audited = false;
    const r = makeSystemRoutes(baseDeps({
      pushState: () => { pushed = true; },
      auditLog: { append: async () => { audited = true; }, list: async () => [] },
    }));
    expect(await r['transfer/import']({ payload: {} })).toEqual({ ok: true, imported: { secrets: 1 } });
    expect(pushed).toBe(true);
    expect(audited).toBe(true);
  });
  test('wrong export passphrase mapped', async () => {
    const r = makeSystemRoutes(baseDeps({ applyImport: async () => { throw new ExportPassphraseError(); } }));
    expect(await r['transfer/import']({ payload: {} })).toEqual({ ok: false, error: 'wrong-passphrase' });
  });
  test('unexpected import error rethrown', async () => {
    const r = makeSystemRoutes(baseDeps({ applyImport: async () => { throw new Error('disk'); } }));
    await expect(r['transfer/import']({ payload: {} })).rejects.toThrow('disk');
  });
});
