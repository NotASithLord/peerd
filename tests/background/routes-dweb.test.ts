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
    appClient: {
      create: async (r: any) => ({ id: 'new', ...r }),
      replaceFiles: async () => ({ id: 'a1' }),
    },
    appTabTracker: { ensureTab: async () => {}, reloadTab: async () => {} },
    shareLocalApp: async (appId: string, slug?: string) => ({ ok: true, appId, slug }),
    settingsStore: { get: () => ({ dwebEnabled: true }) },
    DWEB_ENABLED: true,
    DWEB_IDENTITY_SECRET: 'distributed/identity/v1',
    APP_TAB_GROUP_TITLE: 'peerd apps',
    disableDweb: async () => ({ ok: true, running: false }),
    withDwebPublication: async (operation: (isCurrent: () => boolean) => Promise<any>) => operation(() => true),
    withDwebIdentityMutation: async (operation: () => Promise<any>) => operation(),
    withAppLifecycle: async (_appId: string, operation: () => Promise<any>) => operation(),
    ensureSettingsReady: async () => {},
    ...over,
  };
  return { deps, sent, audits };
};

describe('dweb gate (build flag + setting)', () => {
  test('disabled when the build flag is off', async () => {
    const { deps } = baseDeps({ DWEB_ENABLED: false });
    expect(await makeDwebRoutes(deps)['dweb/base/start']()).toEqual({ ok: false, error: 'dweb-disabled' });
  });
  test('disabled when the user setting is off', async () => {
    const { deps } = baseDeps({ settingsStore: { get: () => ({ dwebEnabled: false }) } });
    expect(await makeDwebRoutes(deps)['dweb/base/heard']()).toEqual({ ok: false, error: 'dweb-disabled' });
  });
  test('enabled when both on', async () => {
    const { deps, sent } = baseDeps();
    const routes = makeDwebRoutes(deps);
    expect(await routes['dweb/base/start']()).toEqual({ ok: true });
    expect(sent[0]).toEqual({ type: 'dweb/base-host/start' });
    expect(routes['dweb/identity-get']).toBeUndefined();
    expect(routes['dweb/identity-set']).toBeUndefined();
  });
  test('waits for persisted settings and fails closed before side effects', async () => {
    let release = () => {};
    const hydration = new Promise<void>((resolve) => { release = resolve; });
    let hydrated = false;
    const { deps, sent } = baseDeps({
      ensureSettingsReady: async () => { await hydration; hydrated = true; },
      settingsStore: { get: () => ({ dwebEnabled: !hydrated }) },
    });

    const result = makeDwebRoutes(deps)['dweb/base/start']();
    await Promise.resolve();
    expect(sent).toEqual([]);
    release();
    expect(await result).toEqual({ ok: false, error: 'dweb-disabled' });
    expect(sent).toEqual([]);
  });
  test('fails closed when settings hydration fails', async () => {
    const { deps, sent } = baseDeps({
      ensureSettingsReady: async () => { throw new Error('storage unavailable'); },
    });
    expect(await makeDwebRoutes(deps)['dweb/base/start']()).toEqual({ ok: false, error: 'dweb-disabled' });
    expect(sent).toEqual([]);
  });
});

describe('dweb audit', () => {
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
    let created: any = null;
    const { deps, audits } = baseDeps({
      appClient: { create: async (args: any) => { created = args; return { id: args.appId, ...args }; } },
    });
    const res = await makeDwebRoutes(deps)['dweb/app-install']({ appId: 'app-new12345', name: 'X', files: {}, entryFile: 'i.html', dweb: { uri: 'u', publisher: 'p' } });
    expect(res.ok).toBe(true);
    expect(created).toMatchObject({ appId: 'app-new12345', source: 'dweb' });
    expect(audits.at(-1)).toMatchObject({ type: 'dweb_app_installed', details: { uri: 'u', publisher: 'p' } });
  });
  test('a post-commit install audit failure does not report the installed App as absent', async () => {
    const { deps } = baseDeps({
      auditLog: { append: async () => { throw new Error('audit unavailable'); } },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-install']({
      appId: 'app-new12345', name: 'X', files: {}, entryFile: 'i.html', dweb: { uri: 'u', publisher: 'p' },
    });
    expect(result).toMatchObject({ ok: true, app: { id: 'new' }, warning: 'audit-write-failed' });
  });
  test('share-app persists the version slot on success', async () => {
    const shared: any[] = [];
    const { deps } = baseDeps({
      shareLocalApp: async (appId: string, slug?: string) => { shared.push({ appId, slug }); return { ok: true }; },
    });
    await makeDwebRoutes(deps)['dweb/base/share-app']({ appId: 'a1', slug: 's' });
    expect(shared).toEqual([{ appId: 'a1', slug: 's' }]);
  });
  test('app-update commits bytes and version metadata in one client transaction', async () => {
    let replacement: any = null;
    let directMetadataWrites = 0;
    const { deps } = baseDeps({
      appClient: { replaceFiles: async (args: any) => { replacement = args; return { id: 'a1' }; } },
      appRegistry: {
        get: async () => ({ id: 'a1' }),
        update: async () => { directMetadataWrites += 1; return { id: 'a1' }; },
      },
    });
    const res = await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', entryFile: 'index.html',
      files: { 'index.html': { base64: 'PGgxPng8L2gxPg==' } },
      dweb: { version_id: 'v2' },
    });
    expect(res.ok).toBe(true);
    expect(replacement).toMatchObject({
      appId: 'a1',
      entryFile: 'index.html',
      metadata: { dweb: { version_id: 'v2' } },
    });
    expect(directMetadataWrites).toBe(0);
  });

  test('app-update failure is not audited as success', async () => {
    const { deps, audits } = baseDeps({
      appClient: { replaceFiles: async () => { throw new Error('metadata store failed'); } },
      appRegistry: { get: async () => ({ id: 'a1' }) },
    });
    const res = await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', entryFile: 'index.html', files: {}, dweb: { version_id: 'v2' },
    });
    expect(res).toEqual({ ok: false, error: 'metadata store failed' });
    expect(audits.some((entry) => entry.type === 'dweb_app_updated')).toBe(false);
  });
  test('a post-commit update audit failure still reports the committed version', async () => {
    let replaced = false;
    const { deps } = baseDeps({
      auditLog: { append: async () => { throw new Error('audit unavailable'); } },
      appClient: { replaceFiles: async () => { replaced = true; return { id: 'a1', dweb: { hash: 'v2' } }; } },
      appRegistry: { get: async () => ({ id: 'a1' }) },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', entryFile: 'index.html', files: {}, dweb: { version_id: 'v2' },
    });
    expect(replaced).toBe(true);
    expect(result).toMatchObject({ ok: true, app: { id: 'a1' }, warning: 'audit-write-failed' });
  });
  test('records and replaces the latest room-published App hash', async () => {
    let patch: any = null;
    const { deps } = baseDeps({
      appRegistry: {
        get: async () => ({ id: 'a1', dweb: { seed: 'commons', room_hash: 'old' } }),
        list: async () => [],
        update: async (_id: string, value: any) => { patch = value; return { id: 'a1', ...value }; },
      },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-record-served']({
      appId: 'a1', uri: 'peerd://new', hash: 'new',
    });
    expect(result).toEqual({ ok: true, previousHash: 'old' });
    expect(patch).toEqual({
      shared: true,
      dweb: { seed: 'commons', room_hash: 'new', room_uri: 'peerd://new' },
    });
  });
  test('update-app tells the host which served version it replaces', async () => {
    const { deps, sent } = baseDeps({
      appRegistry: {
        get: async () => ({
          id: 'a1',
          dweb: {
            hash: 'v1', dwapp_id: 'durable-d', publisher: 'did:key:zDurable',
            pending_seed_unserve_hashes: ['v0'],
          },
        }),
        list: async () => [],
        update: async (_id: string, patch: any) => ({ id: 'a1', dweb: patch.dwebExact }),
      },
      _reply: { ok: true, app: { id: 'a1' }, pendingUnserveHashes: [] },
    });
    const result = await makeDwebRoutes(deps)['dweb/base/update-app']({
      appId: 'a1', uri: 'peerd://v2', name: 'A', dwappId: 'd', slug: 'a', seq: 2,
    });
    expect(sent.at(-1)).toMatchObject({
      type: 'dweb/base-host/update-app', appId: 'a1',
      expectedDwappId: 'durable-d', expectedPublisher: 'did:key:zDurable',
      previousHash: 'v1', pendingHashes: ['v0'],
    });
    expect(sent.at(-1).dwappId).toBeUndefined();
    expect(result.app.dweb.pending_seed_unserve_hashes).toBeUndefined();
  });
  test('update cleanup persistence failure remains committed with a retry warning', async () => {
    const { deps } = baseDeps({
      appRegistry: {
        get: async () => ({
          id: 'a1',
          dweb: { hash: 'v2', dwapp_id: 'd', publisher: 'did:key:zPeer', pending_seed_unserve_hashes: ['v1'] },
        }),
        list: async () => [],
        update: async () => { throw new Error('disk'); },
      },
      _reply: { ok: true, app: { id: 'a1' }, pendingUnserveHashes: [] },
    });
    expect(await makeDwebRoutes(deps)['dweb/base/update-app']({
      appId: 'a1', uri: 'peerd://v2', name: 'A', dwappId: 'd', slug: 'a', seq: 2,
    })).toMatchObject({
      ok: true,
      warning: 'previous-version-cleanup-pending',
      cleanupPending: true,
    });
  });
  test('update refuses an App without a durable discovery stream', async () => {
    const { deps, sent } = baseDeps({
      appRegistry: {
        get: async () => ({ id: 'a1', dweb: { hash: 'v1' } }),
        list: async () => [],
      },
    });
    expect(await makeDwebRoutes(deps)['dweb/base/update-app']({
      appId: 'a1', uri: 'peerd://v2', name: 'A', dwappId: 'copied-stream',
    })).toEqual({ ok: false, error: 'app-update-identity-missing' });
    expect(sent).toEqual([]);
  });
  test('update refuses an App whose durable stream lacks a publisher', async () => {
    const { deps, sent } = baseDeps({
      appRegistry: {
        get: async () => ({ id: 'a1', dweb: { hash: 'v1', dwapp_id: 'durable-d' } }),
        list: async () => [],
      },
    });
    expect(await makeDwebRoutes(deps)['dweb/base/update-app']({
      appId: 'a1', uri: 'peerd://v2', name: 'A',
    })).toEqual({ ok: false, error: 'app-update-identity-missing' });
    expect(sent).toEqual([]);
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
