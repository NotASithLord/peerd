import { describe, test, expect } from 'bun:test';
import { makeDwebRoutes } from '../../extension/background/routes/dweb.js';
import { createDwebRollbackGuard } from '../../extension/background/dweb-rollback-guard.js';
import { createAppQuiescence } from '../../extension/background/app-quiescence.js';
import { appReleaseDescriptorMatches } from '../../extension/background/app-client.js';
import { createDwebBridge } from '../../extension/peerd-distributed/apps/bridge.js';

const offscreenSender = { url: 'moz-extension://peerd/offscreen/offscreen.html' };

const makeLane = () => {
  let tail = Promise.resolve();
  return async <T>(operation: () => Promise<T>) => {
    const prior = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    await Promise.resolve();
    try { return await operation(); } finally { release(); }
  };
};

const within = async <T>(promise: Promise<T>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('lock order timed out')), 250); }),
    ]);
  } finally { clearTimeout(timer); }
};

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
      getDwebGeneration: () => 0,
      dwebGenerationSnapshot: async () => ({}),
      dwebGenerationsReady: async () => {},
      withDwebAuthority: async (_appId: string, operation: () => Promise<any>) => operation(),
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
    appReleaseDescriptorMatches,
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
  test('only the offscreen host can read App authority generations', async () => {
    const { deps } = baseDeps({
      appTabTracker: {
        dwebGenerationSnapshot: async () => ({ 'app.dweb-generation.a1': 3 }),
      },
    });
    const route = makeDwebRoutes(deps)['dweb/app-authority-generations'];
    expect(await route({}, { url: 'https://example.test/' })).toEqual({
      ok: false,
      error: 'offscreen-sender-required',
    });
    expect(await route({}, offscreenSender)).toEqual({
      ok: true,
      generations: { 'app.dweb-generation.a1': 3 },
    });
  });

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
    expect(res.app.dweb).toMatchObject({ release_entry_file: 'i.html', release_file_kinds: {} });
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
    expect(replacement.metadataForOid('new-base', { dweb: { git_oid: 'base' } }, { 'index.html': 'text' })).toEqual({
      dweb: {
        version_id: 'v2', git_oid: 'new-base', release_entry_file: 'index.html',
        release_file_kinds: { 'index.html': 'text' }, published_hashes: [],
      },
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
  test('update-app sends durable identity without a stale cleanup snapshot', async () => {
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
      _reply: { ok: true, app: { id: 'a1' }, cleanupHashes: ['v0', 'v1'], pendingUnserveHashes: [] },
    });
    const result = await makeDwebRoutes(deps)['dweb/base/update-app']({
      appId: 'a1', uri: 'peerd://v2', name: 'A', dwappId: 'd', slug: 'a', seq: 2,
      strategy: 'fork', conflictToken: 0,
    });
    expect(sent.at(-1)).toMatchObject({
      type: 'dweb/base-host/update-app', appId: 'a1',
      expectedDwappId: 'durable-d', expectedPublisher: 'did:key:zDurable',
      strategy: 'fork', conflictToken: 0,
    });
    expect(sent.at(-1).dwappId).toBeUndefined();
    expect(sent.at(-1).previousHash).toBeUndefined();
    expect(sent.at(-1).pendingHashes).toBeUndefined();
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
      _reply: { ok: true, app: { id: 'a1' }, cleanupHashes: ['v1'], pendingUnserveHashes: [] },
    });
    expect(await makeDwebRoutes(deps)['dweb/base/update-app']({
      appId: 'a1', uri: 'peerd://v2', name: 'A', dwappId: 'd', slug: 'a', seq: 2,
    })).toMatchObject({
      ok: true,
      warning: 'previous-version-cleanup-pending',
      cleanupPending: true,
    });
  });
  test('update cleanup removes only confirmed hashes from later pending work', async () => {
    let reads = 0;
    let saved: any = null;
    const { deps } = baseDeps({
      appRegistry: {
        get: async () => ++reads === 1
          ? { id: 'a1', dweb: { hash: 'v1', dwapp_id: 'd', publisher: 'did:key:zPeer' } }
          : { id: 'a1', dweb: { hash: 'v3', pending_seed_unserve_hashes: ['v0', 'v1', 'v2'] } },
        list: async () => [],
        update: async (_id: string, patch: any) => {
          saved = patch.dwebExact;
          return { id: 'a1', dweb: saved };
        },
      },
      _reply: {
        ok: true, app: { id: 'a1' }, cleanupHashes: ['v0', 'v1'], pendingUnserveHashes: ['v1'],
      },
    });
    const result = await makeDwebRoutes(deps)['dweb/base/update-app']({ appId: 'a1', uri: 'peerd://v2' });
    expect(result.ok).toBe(true);
    expect(saved.pending_seed_unserve_hashes).toEqual(['v1', 'v2']);
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
  test('replace approval expires when local bytes change before apply', async () => {
    let generation = 3;
    let replaced = false;
    const { deps } = baseDeps({
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', entryFile: 'i.html', dweb: { git_oid: 'base' } }) },
      appTabTracker: {
        getDwebGeneration: () => generation,
        withDwebAuthority: async (_appId: string, operation: () => Promise<any>, options: any = {}) => {
          if (options.expectedGeneration != null && options.expectedGeneration !== generation) {
            const error = new Error('changed');
            error.name = 'AppDwebAuthorityChangedError';
            throw error;
          }
          if (options.invalidate) generation += 1;
          return operation();
        },
      },
      repositories: {
        statusApp: async () => ({ oid: 'local', branch: 'main', dirty: true }),
        matches: async () => false,
      },
      appClient: {
        replaceVersionedFilesUnlocked: async () => {
          replaced = true;
          return { record: { id: 'a1' }, oid: 'new' };
        },
      },
    });
    const route = makeDwebRoutes(deps)['dweb/app-update'];
    const args = { appId: 'a1', files: { 'i.html': 'new' }, entryFile: 'i.html', dweb: { version_id: 'v2' } };
    const conflict = await route(args, offscreenSender);
    expect(conflict).toMatchObject({ error: 'local-changes', conflictToken: 4 });

    generation += 1; // A local edit lands while the approved peer update is fetched.
    const result = await route({ ...args, strategy: 'replace', conflictToken: conflict.conflictToken }, offscreenSender);
    expect(result).toMatchObject({ error: 'local-changes', conflictToken: 5 });
    expect(replaced).toBe(false);
  });
  test('runtime data create and delete do not block a verified App update', async () => {
    const compared: any[] = [];
    let replaced = 0;
    let record: any = {
      id: 'a1', name: 'A', entryFile: 'i.html', fileKinds: { 'data/state.json': 'text' },
      dweb: { hash: 'v1', git_oid: 'base', release_entry_file: 'i.html', release_file_kinds: {} },
    };
    const { deps } = baseDeps({
      appRegistry: { get: async () => record },
      repositories: {
        statusApp: async () => ({ oid: 'data-only', branch: 'main', dirty: false }),
        matches: async (ref: any, options: any) => { compared.push({ ref, options }); return true; },
      },
      appClient: {
        replaceVersionedFilesUnlocked: async (args: any) => {
          replaced += 1;
          return { record: { id: 'a1', ...args.metadataForOid('new', { dweb: { git_oid: 'base' } }) }, oid: 'new' };
        },
      },
    });
    const route = makeDwebRoutes(deps)['dweb/app-update'];
    expect((await route({
      appId: 'a1', files: { 'i.html': 'new' }, entryFile: 'i.html', dweb: { version_id: 'v2' },
    }, offscreenSender)).ok).toBe(true);
    record = {
      ...record, fileKinds: {},
      dweb: { ...record.dweb, release_file_kinds: { 'data/state.json': 'text' } },
    };
    expect((await route({
      appId: 'a1', files: { 'i.html': 'new' }, entryFile: 'i.html', dweb: { version_id: 'v2' },
    }, offscreenSender)).ok).toBe(true);
    expect(replaced).toBe(2);
    expect(compared).toEqual(Array(2).fill({
      ref: { kind: 'app', id: 'a1' }, options: { at: 'base', excludeAppData: true },
    }));
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
        matches: async () => false,
        fork: async () => { order.push('fork-copy'); return { oid: 'local' }; },
      },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-update']({ appId: 'a1', strategy: 'fork', conflictToken: 0, files: { 'i.html': 'upstream' }, entryFile: 'i.html', dweb: { version_id: 'v2' } }, offscreenSender);
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
  test('room relay admits a pinned local App without a bundle hash', async () => {
    let liveTabId = 41;
    const { deps, sent } = baseDeps({
      appRegistry: { get: async () => ({ id: 'a1', dweb: { hash: null } }) },
      appTabTracker: { getTabId: () => liveTabId, parseIdFromUrl: () => 'a1' },
    });
    const route = makeDwebRoutes(deps)['dweb/base/room'];
    const firstSender = { tab: { id: 41, url: 'moz-extension://peerd/engine-tabs/app-tab/index.html#a1' } } as any;
    await route({
      type: 'dweb/base/room', op: 'join', roomId: 'r1', bridgeAppId: 'a1', bridgeAppForked: false, bridgeAppGeneration: 0,
    }, firstSender);
    expect(sent[0]).toEqual({
      type: 'dweb/base-host/room', op: 'join', roomId: 'r1', roomOwnerId: 'app:a1:41:0',
      roomOwnerAppId: 'a1', roomOwnerGeneration: 0,
    });
    await route({ op: 'join', roomId: 'r1', bridgeAppId: 'a1', bridgeAppForked: false, bridgeAppGeneration: 0 }, firstSender);
    liveTabId = 42;
    await route({
      op: 'join', roomId: 'r1', bridgeAppId: 'a1', bridgeAppForked: false, bridgeAppGeneration: 0,
    }, { tab: { id: 42, url: firstSender.tab.url } } as any);
    await route({ op: 'leave', roomId: 'r1', bridgeAppId: 'a1', bridgeAppGeneration: 0 }, firstSender);
    expect(sent.map((message) => message.roomOwnerId)).toEqual([
      'app:a1:41:0', 'app:a1:41:0', 'app:a1:42:0', 'app:a1:41:0',
    ]);
  });
  test('room join holds a matching App identity through the host relay', async () => {
    let relayed: any[] = [];
    let record: any = {
      id: 'a1', entryFile: 'index.html', fileKinds: { 'payload.custom': 'binary' },
      dweb: {
        hash: 'bundle-v1', git_oid: 'base-v1', release_entry_file: 'index.html',
        release_file_kinds: { 'payload.custom': 'binary' },
      },
    };
    const { deps, sent } = baseDeps({
      appRegistry: { get: async () => record },
      appTabTracker: {
        getTabId: () => 41,
        parseIdFromUrl: (url: string) => url.endsWith('#a1') ? 'a1' : null,
      },
      appClient: {
        withWriteLock: async (_appId: string, operation: () => Promise<any>) => {
          const before = relayed.length;
          const result = await operation();
          expect(relayed).toHaveLength(before + (result?.ok === true ? 1 : 0));
          return result;
        },
      },
      repositories: { matches: async () => true },
    });
    relayed = sent;
    const result = await makeDwebRoutes(deps)['dweb/base/room']({
      type: 'dweb/base/room', op: 'join', roomId: 'r1',
      bridgeAppId: 'a1', bridgeAppHash: 'bundle-v1', bridgeAppForked: false, bridgeAppGeneration: 0,
    }, { tab: { id: 41, url: 'moz-extension://peerd/engine-tabs/app-tab/index.html#a1' } } as any);
    expect(result).toEqual({ ok: true });
    expect(sent[0]).toEqual({
      type: 'dweb/base-host/room', op: 'join', roomId: 'r1', roomOwnerId: 'app:a1:41:0',
      roomOwnerAppId: 'a1', roomOwnerGeneration: 0,
    });
    record = { ...record, entryFile: 'other.html' };
    expect(await makeDwebRoutes(deps)['dweb/base/room']({
      op: 'join', roomId: 'r1', bridgeAppId: 'a1', bridgeAppHash: 'bundle-v1', bridgeAppForked: false, bridgeAppGeneration: 0,
    }, { tab: { id: 41, url: 'moz-extension://peerd/engine-tabs/app-tab/index.html#a1' } } as any))
      .toEqual({ ok: false, error: 'app-identity-changed' });
    record = { ...record, entryFile: 'index.html', fileKinds: { 'payload.custom': 'text' } };
    expect(await makeDwebRoutes(deps)['dweb/base/room']({
      op: 'join', roomId: 'r1', bridgeAppId: 'a1', bridgeAppHash: 'bundle-v1', bridgeAppForked: false, bridgeAppGeneration: 0,
    }, { tab: { id: 41, url: 'moz-extension://peerd/engine-tabs/app-tab/index.html#a1' } } as any))
      .toEqual({ ok: false, error: 'app-identity-changed' });
  });
  test('room join refuses bytes that changed after consent', async () => {
    const { deps, sent } = baseDeps({
      appRegistry: { get: async () => ({ id: 'a1', entryFile: 'index.html', fileKinds: {}, dweb: { hash: 'bundle-v1', git_oid: 'base-v1', release_entry_file: 'index.html', release_file_kinds: {} } }) },
      appTabTracker: {
        getTabId: () => 41,
        parseIdFromUrl: () => 'a1',
      },
      repositories: { matches: async () => false },
    });
    const result = await makeDwebRoutes(deps)['dweb/base/room']({
      op: 'join', roomId: 'r1', bridgeAppId: 'a1', bridgeAppHash: 'bundle-v1', bridgeAppForked: false, bridgeAppGeneration: 0,
    }, { tab: { id: 41, url: 'moz-extension://peerd/engine-tabs/app-tab/index.html#a1' } } as any);
    expect(result).toEqual({ ok: false, error: 'app-identity-changed' });
    expect(sent).toEqual([]);
  });
  test('room relay rejects missing identity and a displaced App tab', async () => {
    let tabId = 41;
    const { deps, sent } = baseDeps({
      appRegistry: { get: async () => ({ id: 'a1', entryFile: 'index.html', fileKinds: {}, dweb: { hash: 'bundle-v1', git_oid: 'base-v1', release_entry_file: 'index.html', release_file_kinds: {} } }) },
      appTabTracker: { getTabId: () => tabId, parseIdFromUrl: () => 'a1' },
      repositories: { matches: async () => { tabId = 42; return true; } },
    });
    const route = makeDwebRoutes(deps)['dweb/base/room'];
    const sender = { tab: { id: 41, url: 'moz-extension://peerd/engine-tabs/app-tab/index.html#a1' } } as any;
    expect(await route({ op: 'join', roomId: 'r1' }, sender))
      .toEqual({ ok: false, error: 'app-identity-changed' });
    expect(await route({
      op: 'join', roomId: 'r1', bridgeAppId: 'a1', bridgeAppHash: 'bundle-v1', bridgeAppForked: false, bridgeAppGeneration: 0,
    }, sender)).toEqual({ ok: false, error: 'app-identity-changed' });
    expect(await route({ op: 'publish', roomId: 'r1', bridgeAppId: 'a1', bridgeAppGeneration: 0 }, sender))
      .toEqual({ ok: false, error: 'app-identity-changed' });
    expect(sent).toEqual([]);
  });
  test('room relay rejects authority that changes while its host starts', async () => {
    let generation = 0;
    let release!: () => void;
    const hostReady = new Promise<void>((resolve) => { release = resolve; });
    const { deps, sent } = baseDeps({
      ensureOffscreen: async () => hostReady,
      appTabTracker: {
        getTabId: () => 41, getDwebGeneration: () => generation,
        parseIdFromUrl: () => 'a1',
      },
    });
    const pending = makeDwebRoutes(deps)['dweb/base/room']({
      op: 'publish', roomId: 'r1', bridgeAppId: 'a1', bridgeAppGeneration: 0,
    }, { tab: { id: 41, url: 'moz-extension://peerd/engine-tabs/app-tab/index.html#a1' } } as any);
    await Promise.resolve();
    generation = 1;
    release();
    expect(await pending).toEqual({ ok: false, error: 'app-identity-changed' });
    expect(sent).toEqual([]);
  });
  test('room relay holds ordinary effects in the App write lane and lets stale leave clean up', async () => {
    let locked = false;
    let fenceCalls = 0;
    let authorityCalls = 0;
    let release!: () => void;
    let hostStarted!: () => void;
    const hostDone = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { hostStarted = resolve; });
    const { deps, sent } = baseDeps({
      browser: { runtime: { sendMessage: async (message: any) => {
        sent.push(message); hostStarted(); await hostDone; return { ok: true };
      } } },
      appTabTracker: {
        getTabId: () => 41, getDwebGeneration: () => 2, parseIdFromUrl: () => 'a1',
        withDwebAuthority: async (_appId: string, operation: () => Promise<any>) => {
          authorityCalls += 1;
          return operation();
        },
      },
      appClient: {
        withWriteLock: async (_appId: string, operation: () => Promise<any>) => {
          locked = true;
          try { return await operation(); } finally { locked = false; }
        },
      },
      withDwebPublication: async (operation: (isCurrent: () => boolean) => Promise<any>) => {
        fenceCalls += 1;
        return operation(() => true);
      },
    });
    const route = makeDwebRoutes(deps)['dweb/base/room'];
    const sender = { tab: { id: 41, url: 'moz-extension://peerd/engine-tabs/app-tab/index.html#a1' } } as any;
    for (const bridgeAppGeneration of [undefined, 1, 2.5]) {
      expect(await route({ op: 'publish', roomId: 'r1', bridgeAppId: 'a1', bridgeAppGeneration }, sender))
        .toEqual({ ok: false, error: 'app-identity-changed' });
    }
    const publishing = route({ op: 'publish', roomId: 'r1', bridgeAppId: 'a1', bridgeAppGeneration: 2 }, sender);
    await started;
    expect(locked).toBe(true);
    release();
    expect(await publishing).toEqual({ ok: true });
    expect(locked).toBe(false);
    expect(await route({ op: 'leave', roomId: 'r1', bridgeAppId: 'a1', bridgeAppGeneration: 1 }, sender)).toEqual({ ok: true });
    expect(sent.at(-1)).toEqual({
      type: 'dweb/base-host/room', op: 'leave', roomId: 'r1', roomOwnerId: 'app:a1:41:1',
      roomOwnerAppId: 'a1', roomOwnerGeneration: 1,
    });
    expect(fenceCalls).toBe(2);
    expect(authorityCalls).toBe(0);
  });
  test('room publication flushes a re-entrant App mutation before it takes authority', async () => {
    const authority = makeLane();
    const order: string[] = [];
    let flushing = false;
    const withDwebAuthority = (_appId: string, operation: () => Promise<any>) => authority(async () => {
      order.push(flushing ? 'flush-authority' : 'publish-authority');
      return operation();
    });
    const { deps } = baseDeps({
      appTabTracker: {
        getTabId: () => 41, getDwebGeneration: () => 0, parseIdFromUrl: () => 'a1',
        withDwebAuthority,
        quiesceTab: async () => {
          flushing = true;
          try { await withDwebAuthority('a1', async () => {}); }
          finally { flushing = false; }
          return true;
        },
      },
      appClient: {
        snapshotFilesBase64: async () => ({ record: { id: 'a1' }, files: {}, totalBytes: 0 }),
      },
    });
    const result = await within(makeDwebRoutes(deps)['dweb/base/room']({
      op: 'publish-app', roomId: 'r1', appId: 'a1', bridgeAppId: 'a1', bridgeAppGeneration: 0,
    }, { tab: { id: 41, url: 'moz-extension://peerd/engine-tabs/app-tab/index.html#a1' } } as any));
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['flush-authority']);
  });
  test('join settles while invalidation owns App authority and waits for bridge disposal', async () => {
    const authority = makeLane();
    let joining!: Promise<any>;
    let releaseMutation!: () => void;
    const mutationReady = new Promise<void>((resolve) => { releaseMutation = resolve; });
    let continueMutation!: () => void;
    const mutationGate = new Promise<void>((resolve) => { continueMutation = resolve; });
    const { deps } = baseDeps({
      appRegistry: { get: async () => ({ id: 'a1', dweb: { hash: null } }) },
      appTabTracker: {
        getTabId: () => 41, getDwebGeneration: () => 0, parseIdFromUrl: () => 'a1',
        withDwebAuthority: (_appId: string, operation: () => Promise<any>) => authority(operation),
      },
    });
    const mutation = authority(async () => {
      releaseMutation();
      await mutationGate;
      await joining;
    });
    await mutationReady;
    joining = makeDwebRoutes(deps)['dweb/base/room']({
      op: 'join', roomId: 'r1', bridgeAppId: 'a1', bridgeAppForked: false, bridgeAppGeneration: 0,
    }, { tab: { id: 41, url: 'moz-extension://peerd/engine-tabs/app-tab/index.html#a1' } } as any);
    continueMutation();
    const [joined] = await within(Promise.all([joining, mutation]));
    expect(joined).toEqual({ ok: true });
  });
  test('room effects and updates settle in both publication queue orders', async () => {
    for (const roomFirst of [false, true]) {
      const publication = makeLane();
      const lifecycle = makeLane();
      const authority = makeLane();
      const repository = makeLane();
      const { deps } = baseDeps({
        withDwebPublication: (operation: (current: () => boolean) => Promise<any>) => publication(() => operation(() => true)),
        withAppLifecycle: (_appId: string, operation: () => Promise<any>) => lifecycle(operation),
        appTabTracker: {
          getTabId: () => 41, getDwebGeneration: () => 0, parseIdFromUrl: () => 'a1',
          withDwebAuthority: (_appId: string, operation: () => Promise<any>) => authority(operation),
        },
        appClient: {
          withWriteLock: (_appId: string, operation: () => Promise<any>) => repository(operation),
        },
      });
      const routes = makeDwebRoutes(deps);
      const room = () => routes['dweb/base/room']({
        op: 'publish', roomId: 'r1', bridgeAppId: 'a1', bridgeAppGeneration: 0,
      }, { tab: { id: 41, url: 'moz-extension://peerd/engine-tabs/app-tab/index.html#a1' } } as any);
      const update = () => routes['dweb/app-update']({
        appId: 'a1', files: { 'i.html': 'new' }, entryFile: 'i.html', dweb: { version_id: 'v2' },
      }, offscreenSender);
      const operations = roomFirst ? [room(), update()] : [update(), room()];
      const results = await within(Promise.all(operations));
      expect(results.every((result) => result.ok === true)).toBe(true);
    }
  });
  test('outer update re-entry settles around a joining bridge in both queue orders', async () => {
    const run = async (callbackFirst: boolean) => {
    const publication = makeLane();
    const lifecycle = makeLane();
    const authority = makeLane();
    let releaseUpdateHost!: () => void;
    let updateHostStarted!: () => void;
    const updateHostGate = new Promise<void>((resolve) => { releaseUpdateHost = resolve; });
    const updateHostReady = new Promise<void>((resolve) => { updateHostStarted = resolve; });
    let releaseJoinHost!: () => void;
    let joinRequested!: () => void;
    const joinHostGate = new Promise<void>((resolve) => { releaseJoinHost = resolve; });
    const joinReady = new Promise<void>((resolve) => { joinRequested = resolve; });
    let updateReentered!: () => void;
    const updateReentryReady = new Promise<void>((resolve) => { updateReentered = resolve; });
    let storagePublicationStarted!: () => void;
    const storagePublicationReady = new Promise<void>((resolve) => { storagePublicationStarted = resolve; });
    let releaseStorageQuiesce!: () => void;
    let storageQuiesceStarted!: () => void;
    const storageQuiesceGate = new Promise<void>((resolve) => { releaseStorageQuiesce = resolve; });
    const storageQuiesceReady = new Promise<void>((resolve) => { storageQuiesceStarted = resolve; });
    let storageCallbackActive = false;
    let leaveCalls = 0;
    const lostLeaveReply = new Promise<never>(() => {});
    let routes!: ReturnType<typeof makeDwebRoutes>;
    let bridge!: ReturnType<typeof createDwebBridge>;
    const dwappId = 'd'.repeat(64);
    const publisher = 'did:key:zPublisher';
    const record = {
      id: 'a1', name: 'A', entryFile: 'index.html', fileKinds: {},
      dweb: {
        hash: 'bundle-v1', git_oid: 'base-v1', dwapp_id: dwappId, publisher,
        seq: 1, version_id: 'a'.repeat(64), release_entry_file: 'index.html', release_file_kinds: {},
      },
    };
    const sender = { tab: { id: 41, url: 'moz-extension://peerd/engine-tabs/app-tab/index.html#a1' } } as any;
    const tracker = {
      getTabId: () => 41,
      getDwebGeneration: () => 0,
      dwebGenerationsReady: async () => {},
      parseIdFromUrl: () => 'a1',
      withDwebAuthority: (_appId: string, operation: () => Promise<any>) => authority(operation),
    };
    const { deps } = baseDeps({
      appRegistry: {
        get: async () => record,
        update: async () => record,
      },
      appTabTracker: tracker,
      appQuiescence: {
        runUnlocked: async (_appId: string, operation: () => Promise<any>, options: any = {}) => {
          if (!options.invalidateDweb) return operation();
          if (callbackFirst) {
            storageQuiesceStarted();
            await storageQuiesceGate;
          }
          return tracker.withDwebAuthority('a1', operation);
        },
      },
      appClient: {
        withWriteLock: async (_appId: string, operation: () => Promise<any>) => operation(),
        replaceVersionedFilesUnlocked: async () => ({ record, oid: 'base-v2', created: true }),
      },
      createDwebRollbackGuard: () => ({ admit: async () => ({ accepted: true }) }),
      withDwebPublication: (operation: (current: () => boolean) => Promise<any>) => publication(() => {
        if (storageCallbackActive) storagePublicationStarted();
        return operation(() => true);
      }),
      withAppLifecycle: (_appId: string, operation: () => Promise<any>) => lifecycle(operation),
      browser: { runtime: { sendMessage: async (message: any): Promise<any> => {
        if (message.type === 'dweb/base-host/update-app') {
          updateHostStarted();
          await updateHostGate;
          updateReentered();
          storageCallbackActive = true;
          let applied;
          try {
            applied = await routes['dweb/app-update']({
              appId: 'a1', files: { 'index.html': 'new' }, entryFile: 'index.html', fileKinds: {},
              dweb: {
                hash: 'bundle-v2', dwapp_id: dwappId, publisher,
                seq: 2, version_id: 'b'.repeat(64),
              },
            }, offscreenSender);
          } finally { storageCallbackActive = false; }
          return {
            ...applied,
            cleanupHashes: applied.cleanupHashes ?? ['bundle-v1'],
            pendingUnserveHashes: [],
          };
        }
        if (message.type === 'dweb/base-host/room' && message.op === 'join') {
          await joinHostGate;
          return { ok: true, did: 'did:key:self', present: 1 };
        }
        if (message.type === 'dweb/base-host/room' && message.op === 'leave') {
          leaveCalls += 1;
          if (callbackFirst && leaveCalls === 1) return lostLeaveReply;
          return { ok: true, left: true };
        }
        return { ok: true };
      } } },
    });
    routes = makeDwebRoutes(deps);

    let bridgeMessage!: (message: any) => Promise<void>;
    bridge = createDwebBridge({
      appId: 'a1', appName: 'A', appDweb: { hash: 'bundle-v1', generation: 0 }, entryFile: 'index.html',
      transport: {
        send: () => {},
        onMessage: (handler) => {
          bridgeMessage = async (message) => { await handler(message); };
          return () => {};
        },
      },
      swCall: async (type, payload = {}) => {
        if (type === 'app/get-meta') return { ok: true, dweb: { hash: 'bundle-v1', forked: false } };
        if (type === 'dweb/base/room') {
          if (payload.op === 'join') joinRequested();
          return routes[type]({ type, ...payload }, sender);
        }
        return { ok: true };
      },
      storage: {
        get: async () => ({ 'dweb.grants.v1': { 'bundle-v1': { rooms: { r1: true } } } }),
        set: async () => {},
      },
      confirmAction: async () => true,
    });

    const updating = routes['dweb/base/update-app']({ appId: 'a1', uri: 'peerd://did:key:publisher/dw1' });
    await updateHostReady;
    if (callbackFirst) {
      releaseUpdateHost();
      await updateReentryReady;
      await storagePublicationReady;
      await storageQuiesceReady;
    }
    const joining = bridgeMessage({
      peerd: 'dweb', op: 'join', clientId: 'client-0001', id: 'request-0001', args: { roomId: 'r1' },
    });
    await joinReady;
    let editorStarted!: () => void;
    const editorReady = new Promise<void>((resolve) => { editorStarted = resolve; });
    const editing = authority(async () => {
      editorStarted();
      await bridge.invalidate();
    });
    await editorReady;
    if (callbackFirst) releaseStorageQuiesce();
    else {
      releaseUpdateHost();
      await updateReentryReady;
    }
    releaseJoinHost();
    const [updated] = await within(Promise.all([updating, joining, editing]));
    expect(updated).toMatchObject({ ok: true });
    if (callbackFirst) expect(leaveCalls).toBe(2);
    };
    for (const callbackFirst of [false, true]) await run(callbackFirst);
  });
  test('room publication relays one immutable snapshot only for the current generation', async () => {
    let generation = 0;
    const snapshot = { record: { id: 'a1', entryFile: 'index.html' }, files: { 'index.html': { base64: 'eA==' } }, totalBytes: 1 };
    const sender = { tab: { id: 41, url: 'moz-extension://peerd/engine-tabs/app-tab/index.html#a1' } } as any;
    const make = (changeAfterSnapshot: boolean) => baseDeps({
      appTabTracker: {
        getTabId: () => 41, getDwebGeneration: () => generation, parseIdFromUrl: () => 'a1',
      },
      appQuiescence: { runUnlocked: async (_appId: string, operation: () => Promise<any>) => operation() },
      appClient: {
        snapshotFilesBase64: async () => {
          if (changeAfterSnapshot) generation += 1;
          return snapshot;
        },
      },
      _reply: { ok: true, uri: 'peerd://bundle', hash: 'hash' },
    });
    let context = make(true);
    let route = makeDwebRoutes(context.deps)['dweb/base/room'];
    expect(await route({ op: 'publish-app', roomId: 'r1', appId: 'a2', bridgeAppId: 'a1', bridgeAppGeneration: 0 }, sender))
      .toEqual({ ok: false, error: 'app-identity-changed' });
    expect(await route({ op: 'publish-app', roomId: 'r1', appId: 'a1', bridgeAppId: 'a1', bridgeAppGeneration: 0 }, sender))
      .toEqual({ ok: false, error: 'app-identity-changed' });
    expect(context.sent).toEqual([]);

    generation = 0;
    context = make(false);
    route = makeDwebRoutes(context.deps)['dweb/base/room'];
    expect(await route({ op: 'publish-app', roomId: 'r1', appId: 'a1', bridgeAppId: 'a1', bridgeAppGeneration: 0 }, sender))
      .toEqual({ ok: true, uri: 'peerd://bundle', hash: 'hash' });
    expect(context.sent).toEqual([{
      type: 'dweb/base-host/room', op: 'publish-app', roomId: 'r1', appId: 'a1',
      roomOwnerId: 'app:a1:41:0',
      roomOwnerAppId: 'a1', roomOwnerGeneration: 0,
      roomSnapshot: { ok: true, ...snapshot },
    }]);
  });
});
