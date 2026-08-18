import { describe, test, expect } from 'bun:test';
import { makeDwebRoutes } from '../../extension/background/routes/dweb.js';
import { createDwebRollbackGuard } from '../../extension/background/dweb-rollback-guard.js';
import { createAppQuiescence } from '../../extension/background/app-quiescence.js';

const offscreenSender = { url: 'moz-extension://peerd/offscreen/offscreen.html' };

const baseDeps = (over: any = {}) => {
  const sent: any[] = [];
  const audits: any[] = [];
  const deps = {
    vault: { isLocked: () => false, getSecret: async () => 'id-secret', setSecret: async () => {} },
    auditLog: { append: async (e: any) => { audits.push(e); } },
    kv: { get: async () => ({}), set: async () => {} },
    ensureOffscreen: async () => {},
    browser: { runtime: { sendMessage: async (m: any) => { sent.push(m); return over._reply ?? { ok: true }; } } },
    appRegistry: { get: async () => ({ id: 'a1', name: 'A', entryFile: 'i.html', dweb: { git_oid: 'base' } }), list: async () => [], update: async (id: any, p: any) => ({ id, ...p }) },
    appClient: {
      create: async (r: any) => ({ id: 'new', ...r }),
      delete: async () => true,
      snapshotFilesBase64: async () => ({ record: {}, files: {} }),
      withWriteLock: async (_appId: string, operation: () => Promise<any>) => operation(),
      replaceVersionedFilesUnlocked: async (args: any) => ({
        record: { id: args.appId, ...args.metadataForOid('new-base', { dweb: { git_oid: 'base' } }) },
        oid: 'new-base',
        created: true,
      }),
    },
    appTabTracker: {
      getTabId: () => null,
      quiesceTab: async () => true,
      resumeTab: async () => true,
      closeTab: async () => true,
      ensureTab: async () => 41,
      reloadTab: async () => true,
    },
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
    isOffscreenSender: (sender: any) => sender?.url === offscreenSender.url,
    createDwebRollbackGuard,
    repositories: {
      statusApp: async () => ({ oid: 'base', branch: 'main', dirty: false }),
      matches: async () => true,
      fork: async () => ({ oid: 'base', branch: 'main', dirty: false }),
    },
  };
  const appTabTracker = { ...deps.appTabTracker, ...(over.appTabTracker ?? {}) };
  const merged = {
    ...deps,
    ...over,
    appClient: { ...deps.appClient, ...(over.appClient ?? {}) },
    repositories: { ...deps.repositories, ...(over.repositories ?? {}) },
    appTabTracker,
  };
  return {
    deps: {
      ...merged,
      appQuiescence: over.appQuiescence ?? createAppQuiescence({
        tracker: appTabTracker,
        withLifecycle: merged.withAppLifecycle,
        afterClose: async () => {},
      }),
    },
    sent,
    audits,
  };
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
  test('commons launch pins the required App actor owner without exposing it outside the hash', async () => {
    let createArgs: any = null;
    let tabArgs: any = null;
    const { deps } = baseDeps({
      getCurrentSessionId: async () => 'chat-owner',
      appClient: {
        create: async (args: any) => { createArgs = args; return { id: 'app-commons', ...args }; },
      },
      appTabTracker: {
        ensureTab: async (id: string, options: any) => { tabArgs = { id, options }; return 41; },
      },
    });
    expect(await makeDwebRoutes(deps)['dweb/open-commons']({
      seed: { name: 'Commons', files: { 'index.html': 'x' }, dweb: { seed: 'commons' } },
      room: 'room-1',
    })).toEqual({ ok: true, appId: 'app-commons' });
    expect(createArgs.sessionId).toBe('chat-owner');
    expect(tabArgs.options.hashSuffix).toContain('room=room-1');
    expect(tabArgs.options.hashSuffix).toContain('owner=chat-owner');
  });

  test('privileged App storage arms accept only the exact offscreen host', async () => {
    let touched = false;
    const { deps } = baseDeps({
      appClient: {
        snapshotFilesBase64: async () => { touched = true; return {}; },
        create: async () => { touched = true; return { id: 'unexpected' }; },
        withWriteLock: async () => { touched = true; return {}; },
      },
      appRegistry: {
        get: async () => { touched = true; return null; },
      },
    });
    const routes = makeDwebRoutes(deps);
    const wrongSender = { url: 'moz-extension://peerd/home/home.html' };
    const results = await Promise.all([
      routes['dweb/app-snapshot']({ appId: 'a1' }, wrongSender),
      routes['dweb/app-install']({ appId: 'app-new12345' }, wrongSender),
      routes['dweb/app-update']({ appId: 'a1' }, wrongSender),
      routes['dweb/app-record-served']({ appId: 'a1', uri: 'peerd://x', hash: 'hash' }, wrongSender),
    ]);
    expect(results).toEqual([
      { ok: false, error: 'offscreen-sender-required' },
      { ok: false, error: 'offscreen-sender-required' },
      { ok: false, error: 'offscreen-sender-required' },
      { ok: false, error: 'offscreen-sender-required' },
    ]);
    expect(touched).toBe(false);
  });

  test('app-install creates + audits', async () => {
    let created: any = null;
    const { deps, audits } = baseDeps({
      appClient: { create: async (args: any) => { created = args; return { id: args.appId, ...args }; } },
    });
    const res = await makeDwebRoutes(deps)['dweb/app-install']({ appId: 'app-new12345', name: 'X', files: {}, entryFile: 'i.html', dweb: { uri: 'u', publisher: 'p' } }, offscreenSender);
    expect(res.ok).toBe(true);
    expect(created).toMatchObject({ appId: 'app-new12345', source: 'dweb' });
    expect(audits.at(-1)).toMatchObject({ type: 'dweb_app_installed', details: { uri: 'u', publisher: 'p' } });
  });
  test('durable discovery history rejects a lower-sequence fresh install after restart', async () => {
    const values = new Map<string, any>();
    const kv = {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: any) => { values.set(key, structuredClone(value)); },
    };
    const dwappId = 'a'.repeat(64);
    const publisher = 'did:key:zPublisher';
    const currentVersion = 'b'.repeat(64);
    const first = baseDeps({ kv });
    expect(await makeDwebRoutes(first.deps)['dweb/meta-admit']({
      dwappId, publisher, seq: 9, versionId: currentVersion,
    }, offscreenSender)).toMatchObject({ ok: true, accepted: true });

    let created = false;
    const restarted = baseDeps({
      kv,
      appClient: { create: async () => { created = true; return { id: 'unexpected' }; } },
    });
    const routes = makeDwebRoutes(restarted.deps); // new SW route closure
    expect(await routes['dweb/app-install']({
      appId: 'app-old12345', name: 'old', files: {}, entryFile: 'i.html',
      dweb: {
        dwapp_id: dwappId, publisher, seq: 8, version_id: 'c'.repeat(64),
      },
    }, offscreenSender)).toEqual({ ok: false, error: 'dweb-version-rollback' });
    expect(created).toBe(false);

    // Replaying the exact current card is how an empty offscreen Library
    // rehydrates; storage may install that current release on a fresh profile.
    const currentInstall = baseDeps({ kv });
    expect((await makeDwebRoutes(currentInstall.deps)['dweb/app-install']({
      appId: 'app-current12345', name: 'current', files: {}, entryFile: 'i.html',
      dweb: {
        dwapp_id: dwappId, publisher, seq: 9, version_id: currentVersion,
      },
    }, offscreenSender)).ok).toBe(true);
  });
  test('a post-commit install audit failure does not report the installed App as absent', async () => {
    const { deps } = baseDeps({
      auditLog: { append: async () => { throw new Error('audit unavailable'); } },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-install']({
      appId: 'app-new12345', name: 'X', files: {}, entryFile: 'i.html', dweb: { uri: 'u', publisher: 'p' },
    }, offscreenSender);
    expect(result).toMatchObject({ ok: true, app: { id: 'new' }, warning: 'audit-write-failed' });
  });
  test('install removes the created App when its local Git lineage cannot be recorded', async () => {
    const deleted: string[] = [];
    const { deps } = baseDeps({
      appRegistry: {
        get: async () => null,
        list: async () => [],
        update: async () => null,
      },
      appClient: {
        create: async (args: any) => ({ id: args.appId, ...args }),
        delete: async (id: string) => { deleted.push(id); return true; },
      },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-install']({
      appId: 'app-new12345', name: 'X', files: {}, entryFile: 'i.html', dweb: { uri: 'u' },
    }, offscreenSender);
    expect(result).toEqual({ ok: false, error: 'app disappeared while recording install lineage' });
    expect(deleted).toEqual(['app-new12345']);
  });
  test('share-app persists the version slot on success', async () => {
    const shared: any[] = [];
    const { deps } = baseDeps({
      shareLocalApp: async (appId: string, slug?: string) => { shared.push({ appId, slug }); return { ok: true }; },
    });
    await makeDwebRoutes(deps)['dweb/base/share-app']({ appId: 'a1', slug: 's' });
    expect(shared).toEqual([{ appId: 'a1', slug: 's' }]);
  });

  test('room publication snapshots only after the live editor save is flushed', async () => {
    const order: string[] = [];
    const { deps } = baseDeps({
      appTabTracker: {
        getTabId: () => 41,
        quiesceTab: async () => { order.push('flush'); return true; },
        resumeTab: async () => { order.push('resume'); return true; },
      },
      appClient: {
        snapshotFilesBase64: async () => {
          order.push('snapshot');
          return { record: { entryFile: 'i.html' }, files: { 'i.html': { base64: 'eA==' } } };
        },
      },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-snapshot']({ appId: 'a1' }, offscreenSender);
    expect(result.ok).toBe(true);
    expect(order).toEqual(['flush', 'snapshot', 'resume']);
  });
  test('app-update commits bytes and version metadata in one client transaction', async () => {
    let replacement: any = null;
    let directMetadataWrites = 0;
    const { deps } = baseDeps({
      appClient: {
        replaceVersionedFilesUnlocked: async (args: any) => {
          replacement = args;
          return { record: { id: 'a1', ...args.metadataForOid('new-base', { dweb: { git_oid: 'base' } }) }, oid: 'new-base' };
        },
      },
      appRegistry: {
        get: async () => ({ id: 'a1', dweb: { git_oid: 'base' } }),
        update: async () => { directMetadataWrites += 1; return { id: 'a1' }; },
      },
    });
    const res = await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', entryFile: 'index.html',
      files: { 'index.html': { base64: 'PGgxPng8L2gxPg==' } },
      dweb: { version_id: 'v2' },
    }, offscreenSender);
    expect(res.ok).toBe(true);
    expect(replacement).toMatchObject({
      appId: 'a1',
      entryFile: 'index.html',
      files: { 'index.html': { base64: 'PGgxPng8L2gxPg==' } },
    });
    expect(replacement.metadataForOid('new-base', { dweb: { git_oid: 'base' } })).toEqual({
      dweb: { version_id: 'v2', git_oid: 'new-base', published_hashes: [] },
    });
    expect(directMetadataWrites).toBe(0);
  });
  test('the storage arm refuses a lower-sequence tracked update before replacing files', async () => {
    let replaced = false;
    const dwappId = 'd'.repeat(64);
    const publisher = 'did:key:zPublisher';
    const { deps } = baseDeps({
      appRegistry: {
        get: async () => ({
          id: 'a1',
          dweb: {
            git_oid: 'base', dwapp_id: dwappId, publisher,
            seq: 9, version_id: 'e'.repeat(64),
          },
        }),
      },
      appClient: {
        replaceVersionedFilesUnlocked: async () => {
          replaced = true;
          return { record: { id: 'a1' }, oid: 'new-base' };
        },
      },
    });
    expect(await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', files: { 'i.html': 'old' }, entryFile: 'i.html',
      dweb: {
        dwapp_id: dwappId, publisher, seq: 8, version_id: 'f'.repeat(64),
      },
    }, offscreenSender)).toEqual({ ok: false, error: 'dweb-version-not-newer' });
    expect(replaced).toBe(false);
  });

  test('a live App update flushes before close and takes the write lock last', async () => {
    const order: string[] = [];
    const { deps } = baseDeps({
      appTabTracker: {
        getTabId: () => 41,
        quiesceTab: async () => { order.push('flush'); return true; },
        resumeTab: async () => { order.push('resume'); return true; },
        closeTab: async () => { order.push('close'); return true; },
        ensureTab: async () => { order.push('reopen'); return 41; },
      },
      appClient: {
        withWriteLock: async (_appId: string, operation: () => Promise<any>) => {
          order.push('lock');
          try { return await operation(); }
          finally { order.push('unlock'); }
        },
        replaceVersionedFilesUnlocked: async () => {
          order.push('replace');
          return { record: { id: 'a1' }, oid: 'new-base' };
        },
      },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', entryFile: 'i.html', files: { 'i.html': 'new' }, dweb: { version_id: 'v2' },
    }, offscreenSender);
    expect(result.ok).toBe(true);
    expect(order).toEqual(['flush', 'close', 'lock', 'replace', 'unlock', 'reopen']);
  });

  test('app-update failure is not audited as success', async () => {
    const { deps, audits } = baseDeps({
      appClient: { replaceVersionedFilesUnlocked: async () => { throw new Error('metadata store failed'); } },
      appRegistry: { get: async () => ({ id: 'a1', dweb: { git_oid: 'base' } }) },
    });
    const res = await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', entryFile: 'index.html', files: {}, dweb: { version_id: 'v2' },
    }, offscreenSender);
    expect(res).toEqual({ ok: false, error: 'metadata store failed' });
    expect(audits.some((entry) => entry.type === 'dweb_app_updated')).toBe(false);
  });
  test('a post-commit update audit failure still reports the committed version', async () => {
    let replaced = false;
    const { deps } = baseDeps({
      auditLog: { append: async () => { throw new Error('audit unavailable'); } },
      appClient: { replaceVersionedFilesUnlocked: async () => { replaced = true; return { record: { id: 'a1', dweb: { hash: 'v2' } }, oid: 'new-base' }; } },
      appRegistry: { get: async () => ({ id: 'a1', dweb: { git_oid: 'base' } }) },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', entryFile: 'index.html', files: {}, dweb: { version_id: 'v2' },
    }, offscreenSender);
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
    }, offscreenSender);
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
      appId: 'a1', uri: 'peerd://v2', name: 'A', dwappId: 'd', slug: 'a', seq: 2, strategy: 'fork',
    });
    expect(sent.at(-1)).toMatchObject({
      type: 'dweb/base-host/update-app', appId: 'a1',
      expectedDwappId: 'durable-d', expectedPublisher: 'did:key:zDurable',
      previousHash: 'v1', pendingHashes: ['v0'],
      strategy: 'fork',
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
  test('a peer update refuses to overwrite a diverged local repository', async () => {
    let replaced = false;
    const { deps } = baseDeps({
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', entryFile: 'i.html', dweb: { git_oid: 'base' } }) },
      repositories: {
        statusApp: async () => ({ oid: 'local', branch: 'main', dirty: true }),
        matches: async () => false,
      },
      appClient: { replaceVersionedFilesUnlocked: async () => { replaced = true; return { record: { id: 'a1' }, oid: 'new' }; } },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-update']({ appId: 'a1', files: { 'i.html': 'new' }, entryFile: 'i.html', dweb: { version_id: 'v2' } }, offscreenSender);
    expect(result).toMatchObject({ ok: false, error: 'local-changes', requiresAction: true });
    expect(replaced).toBe(false);
  });
  test('fork strategy preserves local files before applying the verified update', async () => {
    let forked: any = null;
    let replacement: any = null;
    const order: string[] = [];
    const { deps } = baseDeps({
      appRegistry: {
        get: async () => ({ id: 'a1', name: 'A', entryFile: 'i.html', tags: [], dweb: { git_oid: 'base' } }),
        update: async (_id: string, patch: any) => ({ id: 'a1', ...patch }),
      },
      appClient: {
        withWriteLock: async (_appId: string, operation: () => Promise<any>) => {
          order.push('lock-enter');
          try { return await operation(); }
          finally { order.push('lock-exit'); }
        },
        opfsForApp: () => ({ list: async () => [{ path: '/i.html' }], readBytes: async () => new TextEncoder().encode('local') }),
        create: async (input: any) => { forked = input; return { id: 'fork-1', name: input.name }; },
        replaceFiles: async () => { throw new Error('nested replaceFiles must not run'); },
        replaceVersionedFilesUnlocked: async (input: any) => {
          order.push('replace-unlocked');
          replacement = input;
          return { record: { id: 'a1', ...input.metadataForOid('new-base', { dweb: { git_oid: 'base' } }) }, oid: 'new-base' };
        },
      },
      repositories: {
        statusApp: async () => ({ oid: 'local', branch: 'main', dirty: true }),
        fork: async () => { order.push('fork-copy'); return { oid: 'local' }; },
      },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-update']({ appId: 'a1', strategy: 'fork', files: { 'i.html': 'upstream' }, entryFile: 'i.html', dweb: { version_id: 'v2' } }, offscreenSender);
    expect(result).toMatchObject({ ok: true, fork: { id: 'fork-1' } });
    expect(new TextDecoder().decode(forked.files['i.html'])).toBe('local');
    expect(replacement.files).toEqual({ 'i.html': 'upstream' });
    expect(order).toEqual(['lock-enter', 'fork-copy', 'replace-unlocked', 'lock-exit']);
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
