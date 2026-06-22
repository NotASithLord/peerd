import { describe, test, expect } from 'bun:test';
import { makeDwebRoutes } from '../../extension/background/routes/dweb.js';

const baseDeps = (over: any = {}) => {
  const sent: any[] = [];
  const audits: any[] = [];
  const deps = {
    vault: { isLocked: () => false, getSecret: async () => 'id-secret', setSecret: async () => {} },
    auditLog: { append: async (e: any) => { audits.push(e); } },
    kv: { get: async () => ({}), set: async () => {} },
    ensureOffscreen: async () => {},
    browser: { runtime: { sendMessage: async (m: any) => { sent.push(m); return over._reply ?? { ok: true }; } } },
    appRegistry: { get: async () => ({ id: 'a1', name: 'A', entryFile: 'i.html' }), list: async () => [], update: async (_i: any, p: any) => ({ id: 'a1', ...p }) },
    appClient: { create: async (r: any) => ({ id: 'new', ...r }), opfsForApp: () => ({ list: async () => [], read: async () => '', write: async () => {}, delete: async () => {} }) },
    appTabTracker: { ensureTab: async () => {}, reloadTab: async () => {} },
    opfsHelpers: () => ({ list: async () => [], read: async () => '' }),
    settingsStore: { get: () => ({ dwebEnabled: true }) },
    DWEB_ENABLED: true,
    DWEB_IDENTITY_SECRET: 'distributed/identity/v1',
    APP_TAB_GROUP_TITLE: 'peerd apps',
    ...over,
  };
  return { deps, sent, audits };
};

describe('dweb gate (build flag + setting)', () => {
  test('disabled when the build flag is off', async () => {
    const { deps } = baseDeps({ DWEB_ENABLED: false });
    expect(await makeDwebRoutes(deps)['dweb/base/start']()).toEqual({ ok: false, error: 'dweb-disabled' });
    expect(await makeDwebRoutes(deps)['dweb/identity-get']()).toEqual({ ok: false, error: 'dweb-disabled' });
  });
  test('disabled when the user setting is off', async () => {
    const { deps } = baseDeps({ settingsStore: { get: () => ({ dwebEnabled: false }) } });
    expect(await makeDwebRoutes(deps)['dweb/base/heard']()).toEqual({ ok: false, error: 'dweb-disabled' });
  });
  test('enabled when both on', async () => {
    const { deps, sent } = baseDeps();
    expect(await makeDwebRoutes(deps)['dweb/base/start']()).toEqual({ ok: true });
    expect(sent[0]).toEqual({ type: 'dweb/base-host/start' });
  });
});

describe('dweb identity + audit', () => {
  test('identity-get returns the vaulted secret', async () => {
    const { deps } = baseDeps();
    expect(await makeDwebRoutes(deps)['dweb/identity-get']()).toEqual({ ok: true, value: 'id-secret' });
  });
  test('identity-get refused when vault locked', async () => {
    const { deps } = baseDeps({ vault: { isLocked: () => true } });
    expect(await makeDwebRoutes(deps)['dweb/identity-get']()).toEqual({ ok: false, error: 'vault-locked' });
  });
  test('identity-set requires a string + audits issuance', async () => {
    const { deps, audits } = baseDeps();
    expect(await makeDwebRoutes(deps)['dweb/identity-set']({ value: 5 })).toEqual({ ok: false, error: 'value-required' });
    expect(await makeDwebRoutes(deps)['dweb/identity-set']({ value: 'k' })).toEqual({ ok: true });
    expect(audits.at(-1)).toEqual({ type: 'dweb_identity_issued', details: {} });
  });
  test('dweb/audit gates only on the build flag (not the setting) + dweb_ prefix', async () => {
    // setting off but build on → still accepted (matches the original inline gate)
    const { deps, audits } = baseDeps({ settingsStore: { get: () => ({ dwebEnabled: false }) } });
    expect(await makeDwebRoutes(deps)['dweb/audit']({ type: 'evil_event', details: {} })).toEqual({ ok: false, error: 'bad-type' });
    expect(await makeDwebRoutes(deps)['dweb/audit']({ type: 'dweb_room_join', details: { r: 1 } })).toEqual({ ok: true });
    expect(audits.at(-1)).toEqual({ type: 'dweb_room_join', details: { r: 1 } });
  });
});

describe('dweb app store', () => {
  test('app-install creates + audits', async () => {
    const { deps, audits } = baseDeps();
    const res = await makeDwebRoutes(deps)['dweb/app-install']({ name: 'X', files: {}, entryFile: 'i.html', dweb: { uri: 'u', publisher: 'p' } });
    expect(res.ok).toBe(true);
    expect(audits.at(-1)).toMatchObject({ type: 'dweb_app_installed', details: { uri: 'u', publisher: 'p' } });
  });
  test('share-app persists the version slot on success', async () => {
    let updated: any = null;
    const { deps } = baseDeps({
      _reply: { ok: true, uri: 'u2', publisher: 'pub', hash: 'h', slug: 's', dwapp_id: 'd', seq: 2 },
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', entryFile: 'i.html', dweb: {} }), update: async (_i: any, p: any) => { updated = p; return p; } },
    });
    await makeDwebRoutes(deps)['dweb/base/share-app']({ appId: 'a1', slug: 's' });
    expect(updated).toMatchObject({ shared: true, dweb: { uri: 'u2', version_id: 'h', slug: 's', dwapp_id: 'd', seq: 2 } });
  });
  test('updates flags an installed app when a higher-seq different version is heard', async () => {
    const { deps } = baseDeps({
      vault: { isLocked: () => false },
      appRegistry: { list: async () => [{ id: 'a1', dweb: { dwapp_id: 'd', version_id: 'v1', seq: 1 } }] },
      _reply: { apps: [{ dwapp_id: 'd', version_id: 'v2', seq: 2, uri: 'u', name: 'A', slug: 's' }] },
    });
    const res = await makeDwebRoutes(deps)['dweb/base/updates']();
    expect(res.updates.a1).toMatchObject({ version_id: 'v2', seq: 2 });
  });
  test('updates does NOT flag same version_id (already current), even at a higher seq', async () => {
    const { deps } = baseDeps({
      appRegistry: { list: async () => [{ id: 'a1', dweb: { dwapp_id: 'd', version_id: 'v2', seq: 2 } }] },
      _reply: { apps: [{ dwapp_id: 'd', version_id: 'v2', seq: 9, uri: 'u', name: 'A' }] },
    });
    expect((await makeDwebRoutes(deps)['dweb/base/updates']()).updates).toEqual({});
  });
  test('updates does NOT flag a different version at a lower-or-equal seq (rollback/stale guard)', async () => {
    const { deps } = baseDeps({
      appRegistry: { list: async () => [{ id: 'a1', dweb: { dwapp_id: 'd', version_id: 'v2', seq: 2 } }] },
      _reply: { apps: [{ dwapp_id: 'd', version_id: 'v1', seq: 2, uri: 'u', name: 'A' }] }, // older bundle, same seq
    });
    expect((await makeDwebRoutes(deps)['dweb/base/updates']()).updates).toEqual({});
  });
  test('room relay strips the type and forwards args', async () => {
    const { deps, sent } = baseDeps();
    await makeDwebRoutes(deps)['dweb/base/room']({ type: 'dweb/base/room', op: 'join', roomId: 'r1' });
    expect(sent[0]).toEqual({ type: 'dweb/base-host/room', op: 'join', roomId: 'r1' });
  });
});
