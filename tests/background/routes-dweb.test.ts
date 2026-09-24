import { describe, test, expect } from 'bun:test';
import { makeDwebRoutes } from '../../extension/background/routes/dweb.js';
import { createDwebRollbackGuard } from '../../extension/background/dweb-rollback-guard.js';
import { createAppQuiescence } from '../../extension/background/app-quiescence.js';
import { appReleaseDescriptorMatches } from '../../extension/background/app-client.js';

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
  let appGeneration = 0;
  const audits: any[] = [];
  const deps = {
    vault: { isLocked: () => false, getSecret: async () => 'id-secret', setSecret: async () => {} },
    auditLog: { append: async (e: any) => { audits.push(e); } },
    kv: { get: async () => ({}), set: async () => {} },
    ensureDwebFeature: async () => {},
    dwebPublicationGeneration: () => 1,
    browser: { runtime: { sendMessage: async (m: any) => { sent.push(m); return over._reply ?? { ok: true }; } } },
    appRegistry: { get: async () => ({ id: 'a1', name: 'A', entryFile: 'i.html', dweb: { git_oid: 'base' } }), list: async () => [], update: async (id: any, p: any) => ({ id, ...p }) },
    appClient: {
      create: async (r: any) => ({ id: 'new', ...r }),
      delete: async () => true,
      snapshotFilesBase64: async () => ({ record: {}, files: {} }),
      withWriteLock: async (_appId: string, operation: () => Promise<any>) => operation(),
      replaceVersionedFilesUnlocked: async (args: any) => {
        const record = { id: args.appId, ...args.metadataForOid('new-base', { dweb: { git_oid: 'base' } }) };
        await args.afterCommit?.(record);
        return { record, oid: 'new-base', created: true };
      },
    },
    appTabTracker: {
      dwebGenerationsReady: async () => {},
      dwebGenerationSnapshot: async () => ({ a1: appGeneration }),
      getDwebGeneration: () => appGeneration,
      withDwebAuthority: async (_id: string, op: () => Promise<any>, opts: any = {}) => {
        if (opts.expectedGeneration != null && opts.expectedGeneration !== appGeneration) {
          throw Object.assign(new Error('stale generation'), { name: 'AppDwebAuthorityChangedError' });
        }
        if (opts.invalidate) appGeneration += 1;
        return op();
      },
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
  test('refuses construction without exact feature and publication custody', () => {
    const first = baseDeps();
    expect(() => makeDwebRoutes({ ...first.deps, ensureDwebFeature: undefined }))
      .toThrow('dweb route custody dependencies are required');
    const second = baseDeps();
    expect(() => makeDwebRoutes({ ...second.deps, dwebPublicationGeneration: undefined }))
      .toThrow('dweb route custody dependencies are required');
  });

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
  test.each([
    ['start', 'dweb/base/start', {}],
    ['install', 'dweb/base/install', { uri: 'peerd://one', name: 'One' }],
  ])('%s does not adopt a newer publication generation after host startup', async (
    _label, routeName, request,
  ) => {
    let generation = 7;
    let current = true;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const { deps, sent } = baseDeps({
      dwebPublicationGeneration: () => generation,
      withDwebPublication: async (operation: any) => operation(() => current),
      ensureDwebFeature: async () => { entered(); await gate; },
    });
    const pending = makeDwebRoutes(deps)[routeName](request);
    await started;
    current = false;
    generation = 8;
    release();
    expect(await pending).toEqual({ ok: false, error: 'dweb-custody-changed' });
    expect(sent).toEqual([]);
  });

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
    const res = await makeDwebRoutes(deps)['dweb/app-install']({ appId: 'app-new12345', name: 'X', files: {}, entryFile: 'i.html', dweb: { uri: 'u', publisher: 'p' }, publicationGeneration: 1 }, offscreenSender);
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
      publicationGeneration: 1,
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
      publicationGeneration: 1,
    }, offscreenSender)).ok).toBe(true);
  });
  test('a post-commit install audit failure does not report the installed App as absent', async () => {
    const { deps } = baseDeps({
      auditLog: { append: async () => { throw new Error('audit unavailable'); } },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-install']({
      appId: 'app-new12345', name: 'X', files: {}, entryFile: 'i.html', dweb: { uri: 'u', publisher: 'p' },
      publicationGeneration: 1,
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
      publicationGeneration: 1,
    }, offscreenSender);
    expect(result).toEqual({ ok: false, error: 'app disappeared while recording install lineage' });
    expect(deleted).toEqual(['app-new12345']);
  });
  test('failed install rollback preserves unknown durable App custody', async () => {
    const { deps } = baseDeps({
      appRegistry: {
        get: async () => null,
        list: async () => [],
        update: async () => null,
      },
      appClient: {
        create: async (args: any) => ({ id: args.appId, ...args }),
        delete: async () => { throw new Error('OPFS cleanup failed'); },
      },
    });
    expect(await makeDwebRoutes(deps)['dweb/app-install']({
      appId: 'app-new12345', name: 'X', files: {}, entryFile: 'i.html', dweb: { uri: 'u' },
      publicationGeneration: 1,
    }, offscreenSender)).toEqual({
      ok: false, error: 'dweb-install-rollback-failed',
      performed: true, outcomeKnown: false, outcomeKind: 'host-lost', retryable: false,
    });
  });
  test('install preserves an incomplete host rollback verdict before an App id exists', async () => {
    const failure = Object.assign(new Error('creation rollback incomplete'), {
      performed: true, outcomeKnown: false,
      outcomeKind: 'host-lost', retryable: false,
    });
    const { deps, audits } = baseDeps({
      appClient: { create: async () => { throw failure; } },
    });
    expect(await makeDwebRoutes(deps)['dweb/app-install']({
      appId: 'app-new12345', name: 'X', files: {}, entryFile: 'i.html',
      dweb: { uri: 'u' }, publicationGeneration: 1,
    }, offscreenSender)).toEqual({
      ok: false, error: 'creation rollback incomplete', performed: true,
      outcomeKnown: false, outcomeKind: 'host-lost', retryable: false,
    });
    expect(audits.some((entry) => entry.type === 'dweb_app_installed')).toBe(false);
  });
  test('lock invalidation crossing an offscreen install callback removes the created App', async () => {
    let generation = 7;
    let releaseCreate = () => {};
    let markStarted = () => {};
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const deleted: string[] = [];
    const { deps } = baseDeps({
      dwebPublicationGeneration: () => generation,
      appClient: {
        create: async (args: any) => {
          markStarted();
          await createGate;
          return { id: args.appId, ...args };
        },
        delete: async (id: string) => { deleted.push(id); return true; },
      },
    });
    const pending = makeDwebRoutes(deps)['dweb/app-install']({
      appId: 'app-race12345', name: 'X', files: {}, entryFile: 'i.html',
      dweb: { uri: 'u' }, publicationGeneration: 7,
    }, offscreenSender);
    await started;
    generation = 8;
    releaseCreate();
    expect(await pending).toEqual({ ok: false, error: 'dweb-custody-changed' });
    expect(deleted).toEqual(['app-race12345']);
  });
  test('install rolls back the exact created App when lock invalidates its publication generation', async () => {
    let generation = 7;
    const deleted: string[] = [];
    const { deps, audits } = baseDeps({
      dwebPublicationGeneration: () => generation,
      appClient: {
        create: async (args: any) => {
          generation += 1;
          return { id: args.appId, ...args };
        },
        delete: async (id: string) => { deleted.push(id); return true; },
      },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-install']({
      appId: 'app-new12345', name: 'X', files: {}, entryFile: 'i.html',
      dweb: { uri: 'u', publisher: 'p' }, publicationGeneration: 7,
    }, offscreenSender);
    expect(result).toEqual({ ok: false, error: 'dweb-custody-changed' });
    expect(deleted).toEqual(['app-new12345']);
    expect(audits.some((entry) => entry.type === 'dweb_app_installed')).toBe(false);
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
          const record = { id: 'a1', ...args.metadataForOid('new-base', { dweb: { git_oid: 'base' } }) };
          await args.afterCommit(record);
          return { record, oid: 'new-base' };
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
      publicationGeneration: 1,
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
      publicationGeneration: 1,
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
        replaceVersionedFilesUnlocked: async (args: any) => {
          order.push('replace');
          const record = { id: 'a1' };
          await args.afterCommit(record);
          return { record, oid: 'new-base' };
        },
      },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', entryFile: 'i.html', files: { 'i.html': 'new' }, dweb: { version_id: 'v2' },
      publicationGeneration: 1,
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
      publicationGeneration: 1,
    }, offscreenSender);
    expect(res).toEqual({ ok: false, error: 'metadata store failed' });
    expect(audits.some((entry) => entry.type === 'dweb_app_updated')).toBe(false);
  });
  test('lock invalidation crossing an offscreen update callback refuses the durable mutation', async () => {
    let generation = 11;
    let releaseReplace = () => {};
    let markStarted = () => {};
    const replaceGate = new Promise<void>((resolve) => { releaseReplace = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let committed = false;
    const { deps } = baseDeps({
      dwebPublicationGeneration: () => generation,
      appClient: {
        replaceVersionedFilesUnlocked: async (args: any) => {
          markStarted();
          await replaceGate;
          if (!args.isCurrent()) throw new Error('dweb-custody-changed');
          committed = true;
          return { record: { id: 'a1' }, oid: 'new-base' };
        },
      },
      appRegistry: { get: async () => ({ id: 'a1', dweb: { git_oid: 'base' } }) },
    });
    const pending = makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', entryFile: 'index.html', files: {}, dweb: { version_id: 'v2' },
      publicationGeneration: 11,
    }, offscreenSender);
    await started;
    generation = 12;
    releaseReplace();
    expect(await pending).toEqual({ ok: false, error: 'dweb-custody-changed' });
    expect(committed).toBe(false);
  });
  test('a post-commit update audit failure still reports the committed version', async () => {
    let replaced = false;
    const { deps } = baseDeps({
      auditLog: { append: async () => { throw new Error('audit unavailable'); } },
      appClient: { replaceVersionedFilesUnlocked: async (args: any) => {
        replaced = true;
        const record = { id: 'a1', dweb: { hash: 'v2' } };
        await args.afterCommit(record);
        return { record, oid: 'new-base' };
      } },
      appRegistry: { get: async () => ({ id: 'a1', dweb: { git_oid: 'base' } }) },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', entryFile: 'index.html', files: {}, dweb: { version_id: 'v2' },
      publicationGeneration: 1,
    }, offscreenSender);
    expect(replaced).toBe(true);
    expect(result).toMatchObject({ ok: true, app: { id: 'a1' }, warning: 'audit-write-failed' });
  });
  test('a publication invalidated during success audit stays committed and truthfully audited', async () => {
    let generation = 1;
    let rolledBack = false;
    const { deps, audits } = baseDeps({
      dwebPublicationGeneration: () => generation,
      auditLog: { append: async (entry: any) => { audits.push(entry); generation = 2; } },
      appClient: {
        replaceVersionedFilesUnlocked: async (args: any) => {
          const record = { id: 'a1' };
          try { await args.afterCommit(record); }
          catch (error) { rolledBack = true; throw error; }
          return { record, oid: 'new-base' };
        },
      },
    });
    expect(await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', entryFile: 'index.html', files: {}, dweb: { version_id: 'v2' },
      publicationGeneration: 1,
    }, offscreenSender)).toMatchObject({ ok: true, app: { id: 'a1' } });
    expect(rolledBack).toBe(false);
    expect(audits).toContainEqual(expect.objectContaining({ type: 'dweb_app_updated' }));
  });
  test('update preserves an incomplete host rollback verdict', async () => {
    const failure = Object.assign(new Error('replacement rollback incomplete'), {
      performed: true, outcomeKnown: false,
      outcomeKind: 'host-lost', retryable: false,
    });
    const { deps, audits } = baseDeps({
      appClient: { replaceVersionedFilesUnlocked: async () => { throw failure; } },
    });
    expect(await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', entryFile: 'index.html', files: {}, dweb: { version_id: 'v2' },
      publicationGeneration: 1,
    }, offscreenSender)).toEqual({
      ok: false, error: 'replacement rollback incomplete', performed: true,
      outcomeKnown: false, outcomeKind: 'host-lost', retryable: false,
    });
    expect(audits.some((entry) => entry.type === 'dweb_app_updated')).toBe(false);
  });
  test('update hands an exact publication fence to the atomic replacement transaction', async () => {
    let generation = 11;
    let entered = false;
    const { deps, audits } = baseDeps({
      dwebPublicationGeneration: () => generation,
      appClient: { replaceVersionedFilesUnlocked: async (args: any) => {
        entered = true;
        expect(args.isCurrent()).toBe(true);
        generation += 1;
        if (!args.isCurrent()) throw new Error('dweb-custody-changed');
        throw new Error('unreachable');
      } },
      appRegistry: { get: async () => ({ id: 'a1', dweb: { git_oid: 'base' } }) },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', entryFile: 'index.html', files: {}, dweb: { version_id: 'v2' },
      publicationGeneration: 11,
    }, offscreenSender);
    expect(entered).toBe(true);
    expect(result).toEqual({ ok: false, error: 'dweb-custody-changed' });
    expect(audits.some((entry) => entry.type === 'dweb_app_updated')).toBe(false);
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
      appId: 'a1', uri: 'peerd://new', hash: 'new', publicationGeneration: 1,
    }, offscreenSender);
    expect(result).toEqual({ ok: true, pendingUnserveHashes: ['old'] });
    expect(patch).toEqual({
      shared: true,
      dweb: {
        seed: 'commons', room_hash: 'new', room_uri: 'peerd://new',
        pending_room_unserve_hashes: ['old'],
      },
    });
  });
  test('served-hash persistence requires the current publication generation', async () => {
    let touched = 0;
    let generation = 3;
    const { deps } = baseDeps({
      dwebPublicationGeneration: () => generation,
      appRegistry: {
        get: async () => { touched += 1; return { id: 'a1', dweb: {} }; },
        update: async () => { touched += 1; return { id: 'a1' }; },
      },
    });
    const route = makeDwebRoutes(deps)['dweb/app-record-served'];
    const request = { appId: 'a1', uri: 'peerd://new', hash: 'new' };
    expect(await route(request, offscreenSender)).toEqual({ ok: false, error: 'dweb-custody-changed' });
    expect(await route({ ...request, publicationGeneration: 2 }, offscreenSender))
      .toEqual({ ok: false, error: 'dweb-custody-changed' });
    expect(touched).toBe(0);
    expect((await route({ ...request, publicationGeneration: 3 }, offscreenSender)).ok).toBe(true);
    expect(touched).toBe(2);
    generation = 4;
  });
  test('served-hash persistence rechecks generation after reading the App', async () => {
    let generation = 5;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let writes = 0;
    const { deps } = baseDeps({
      dwebPublicationGeneration: () => generation,
      appRegistry: {
        get: async () => { entered(); await gate; return { id: 'a1', dweb: {} }; },
        update: async () => { writes += 1; return { id: 'a1' }; },
      },
    });
    const pending = makeDwebRoutes(deps)['dweb/app-record-served']({
      appId: 'a1', uri: 'peerd://new', hash: 'new', publicationGeneration: 5,
    }, offscreenSender);
    await started;
    generation = 6;
    release();
    expect(await pending).toEqual({ ok: false, error: 'dweb-custody-changed' });
    expect(writes).toBe(0);
  });
  test('served-hash persistence reports unknown when generation changes during its write', async () => {
    let generation = 5;
    const { deps } = baseDeps({
      dwebPublicationGeneration: () => generation,
      appRegistry: {
        get: async () => ({ id: 'a1', dweb: {} }),
        update: async () => { generation = 6; return { id: 'a1' }; },
      },
    });
    expect(await makeDwebRoutes(deps)['dweb/app-record-served']({
      appId: 'a1', uri: 'peerd://new', hash: 'new', publicationGeneration: 5,
    }, offscreenSender)).toEqual({
      ok: false, error: 'dweb-custody-changed',
      performed: true, outcomeKnown: false,
      outcomeKind: 'host-lost', retryable: false,
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
  test('update-app cannot adopt a generation that changes during catalog lookup', async () => {
    let generation = 7;
    let current = true;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const { deps, sent } = baseDeps({
      dwebPublicationGeneration: () => generation,
      withDwebPublication: async (operation: any) => operation(() => current),
      appRegistry: { get: async () => {
        entered();
        await gate;
        return { id: 'a1', dweb: { dwapp_id: 'd1', publisher: 'did:key:one' } };
      } },
    });
    const pending = makeDwebRoutes(deps)['dweb/base/update-app']({
      appId: 'a1', uri: 'peerd://v2', name: 'A',
    });
    await started;
    current = false;
    generation = 8;
    release();
    expect(await pending).toEqual({ ok: false, error: 'dweb-custody-changed' });
    expect(sent).toEqual([]);
  });
  test('base install preserves an unknown durable storage verdict', async () => {
    const unknown = {
      ok: false, error: 'install rollback incomplete', performed: true,
      outcomeKnown: false, outcomeKind: 'host-lost', retryable: false,
    };
    const { deps } = baseDeps({ _reply: unknown });
    expect(await makeDwebRoutes(deps)['dweb/base/install']({
      uri: 'peerd://one', name: 'One',
    })).toEqual(unknown);
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
    const result = await makeDwebRoutes(deps)['dweb/app-update']({ appId: 'a1', files: { 'i.html': 'new' }, entryFile: 'i.html', dweb: { version_id: 'v2' }, publicationGeneration: 1 }, offscreenSender);
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
    const args = { appId: 'a1', files: { 'i.html': 'new' }, entryFile: 'i.html', dweb: { version_id: 'v2' }, publicationGeneration: 1 };
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
      appId: 'a1', files: { 'i.html': 'new' }, entryFile: 'i.html', dweb: { version_id: 'v2' }, publicationGeneration: 1,
    }, offscreenSender)).ok).toBe(true);
    record = {
      ...record, fileKinds: {},
      dweb: { ...record.dweb, release_file_kinds: { 'data/state.json': 'text' } },
    };
    expect((await route({
      appId: 'a1', files: { 'i.html': 'new' }, entryFile: 'i.html', dweb: { version_id: 'v2' }, publicationGeneration: 1,
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
          const record = { id: 'a1', ...input.metadataForOid('new-base', { dweb: { git_oid: 'base' } }) };
          await input.afterCommit(record);
          return { record, oid: 'new-base' };
        },
      },
      repositories: {
        statusApp: async () => ({ oid: 'local', branch: 'main', dirty: true }),
        matches: async () => false,
        fork: async () => { order.push('fork-copy'); return { oid: 'local' }; },
      },
    });
    const result = await makeDwebRoutes(deps)['dweb/app-update']({ appId: 'a1', strategy: 'fork', conflictToken: 0, files: { 'i.html': 'upstream' }, entryFile: 'i.html', dweb: { version_id: 'v2' }, publicationGeneration: 1 }, offscreenSender);
    expect(result).toMatchObject({ ok: true, fork: { id: 'fork-1' } });
    expect(new TextDecoder().decode(forked.files['i.html'])).toBe('local');
    expect(replacement.files).toEqual({ 'i.html': 'upstream' });
    expect(order).toEqual(['lock-enter', 'fork-copy', 'replace-unlocked', 'lock-exit']);
  });
  test('a failed forked update removes the local fork before returning', async () => {
    const deleted: string[] = [];
    const { deps } = baseDeps({
      appRegistry: {
        get: async () => ({ id: 'a1', name: 'A', entryFile: 'i.html', tags: [], dweb: { git_oid: 'base' } }),
      },
      appClient: {
        opfsForApp: () => ({
          list: async () => [{ path: '/i.html' }],
          readBytes: async () => new TextEncoder().encode('local'),
        }),
        create: async () => ({ id: 'fork-1', name: 'A: local fork' }),
        delete: async (id: string) => { deleted.push(id); return true; },
        replaceVersionedFilesUnlocked: async () => { throw new Error('replacement failed'); },
      },
      repositories: {
        statusApp: async () => ({ oid: 'local', branch: 'main', dirty: true }),
        matches: async () => false,
        fork: async () => ({ oid: 'local' }),
      },
    });
    expect(await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', strategy: 'fork', conflictToken: 0, files: { 'i.html': 'upstream' },
      entryFile: 'i.html', dweb: { version_id: 'v2' }, publicationGeneration: 1,
    }, offscreenSender)).toEqual({ ok: false, error: 'replacement failed' });
    expect(deleted).toEqual(['fork-1']);
  });
  test('a failed fork cleanup retains explicit unknown custody', async () => {
    const { deps } = baseDeps({
      appRegistry: {
        get: async () => ({ id: 'a1', name: 'A', entryFile: 'i.html', tags: [], dweb: { git_oid: 'base' } }),
      },
      appClient: {
        opfsForApp: () => ({ list: async () => [], readBytes: async () => new Uint8Array() }),
        create: async () => ({ id: 'fork-1', name: 'A: local fork' }),
        delete: async () => { throw new Error('cleanup failed'); },
        replaceVersionedFilesUnlocked: async () => { throw new Error('replacement failed'); },
      },
      repositories: {
        statusApp: async () => ({ oid: 'local', branch: 'main', dirty: true }),
        matches: async () => false,
        fork: async () => ({ oid: 'local' }),
      },
    });
    expect(await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', strategy: 'fork', conflictToken: 0, files: { 'i.html': 'upstream' },
      entryFile: 'i.html', dweb: { version_id: 'v2' }, publicationGeneration: 1,
    }, offscreenSender)).toMatchObject({
      ok: false, code: 'dweb-update-fork-rollback-incomplete',
      performed: true, outcomeKnown: false,
      outcomeKind: 'host-lost', retryable: false,
    });
  });
  test('fork creation is refused when publication custody changes during snapshot', async () => {
    let generation = 1;
    let created = false;
    const { deps } = baseDeps({
      dwebPublicationGeneration: () => generation,
      appRegistry: {
        get: async () => ({ id: 'a1', name: 'A', entryFile: 'i.html', tags: [], dweb: { git_oid: 'base' } }),
      },
      appClient: {
        opfsForApp: () => ({
          list: async () => [{ path: '/i.html' }],
          readBytes: async () => { generation = 2; return new TextEncoder().encode('local'); },
        }),
        create: async () => { created = true; return { id: 'fork-1' }; },
      },
      repositories: {
        statusApp: async () => ({ oid: 'local', branch: 'main', dirty: true }),
        matches: async () => false,
      },
    });
    expect(await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', strategy: 'fork', conflictToken: 0, files: { 'i.html': 'upstream' },
      entryFile: 'i.html', dweb: { version_id: 'v2' }, publicationGeneration: 1,
    }, offscreenSender)).toEqual({ ok: false, error: 'dweb-custody-changed' });
    expect(created).toBe(false);
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
    const { deps, sent } = baseDeps({
      appTabTracker: {
        parseIdFromUrl: () => 'app-one',
        getTabId: () => 41,
      },
    });
    const sender = {
      url: 'chrome-extension://peerd/engine-tabs/app-tab/index.html#app-one',
      documentId: 'document-one',
      tab: { id: 41 },
    };
    await makeDwebRoutes(deps)['dweb/base/room']({
      type: 'dweb/base/room', op: 'join', roomId: 'r1', appId: 'app-one',
      roomAdmissionToken: 'room-admission-token-one', bridgeAppId: 'app-one', bridgeAppGeneration: 0,
    }, sender as any);
    expect(sent[0]).toEqual({
      type: 'dweb/base-host/room', op: 'join', roomId: 'r1', appId: 'app-one',
      roomAdmissionToken: 'room-admission-token-one',
      publicationGeneration: 1, appGeneration: 0,
      appDocumentId: 'document-one', appTabId: 41,
    });
  });
  test('room publish clears durable stale-hash custody after host cleanup', async () => {
    let patch: any = null;
    const { deps } = baseDeps({
      _reply: { ok: true, hash: 'new', pendingRoomUnserveHashes: [] },
      appRegistry: {
        get: async () => ({
          id: 'app-one', dweb: {
            room_hash: 'new', pending_room_unserve_hashes: ['old'],
          },
        }),
        update: async (_id: string, value: any) => { patch = value; return { id: 'app-one' }; },
      },
      appTabTracker: { parseIdFromUrl: () => 'app-one', getTabId: () => 41 },
    });
    const result = await makeDwebRoutes(deps)['dweb/base/room']({
      op: 'publish-app', appId: 'app-one', roomId: 'room-one', bridgeAppId: 'app-one', bridgeAppGeneration: 0,
    }, {
      url: 'chrome-extension://peerd/engine-tabs/app-tab/index.html#app-one',
      documentId: 'document-one', tab: { id: 41 },
    } as any);
    expect(result).toEqual({ ok: true, hash: 'new', pendingRoomUnserveHashes: [] });
    expect(patch.dwebExact.pending_room_unserve_hashes).toBeUndefined();
  });
  test('room publish keeps a retry warning when stale-hash cleanup cannot persist', async () => {
    const { deps } = baseDeps({
      _reply: { ok: true, hash: 'new', pendingRoomUnserveHashes: ['old'] },
      appRegistry: {
        get: async () => ({ id: 'app-one', dweb: { room_hash: 'new' } }),
        update: async () => { throw new Error('disk'); },
      },
      appTabTracker: { parseIdFromUrl: () => 'app-one', getTabId: () => 41 },
    });
    expect(await makeDwebRoutes(deps)['dweb/base/room']({
      op: 'publish-app', appId: 'app-one', roomId: 'room-one', bridgeAppId: 'app-one', bridgeAppGeneration: 0,
    }, {
      url: 'chrome-extension://peerd/engine-tabs/app-tab/index.html#app-one',
      documentId: 'document-one', tab: { id: 41 },
    } as any)).toMatchObject({
      ok: true, hash: 'new', warning: 'previous-version-cleanup-pending',
      pendingRoomUnserveHashes: ['old'],
    });
  });

  test('room relay does not dispatch after publication invalidates during host startup', async () => {
    let generation = 9;
    let current = true;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const { deps, sent } = baseDeps({
      dwebPublicationGeneration: () => generation,
      withDwebPublication: async (operation: any) => operation(() => current),
      ensureDwebFeature: async () => { entered(); await gate; },
      appTabTracker: { parseIdFromUrl: () => 'app-one', getTabId: () => 41 },
    });
    const sender = {
      url: 'chrome-extension://peerd/engine-tabs/app-tab/index.html#app-one',
      documentId: 'document-one', tab: { id: 41 },
    };
    const pending = makeDwebRoutes(deps)['dweb/base/room']({
      type: 'dweb/base/room', op: 'join', roomId: 'r1', appId: 'app-one',
      roomAdmissionToken: 'room-admission-token-one', bridgeAppId: 'app-one', bridgeAppGeneration: 0,
    }, sender as any);
    await started;
    current = false;
    generation = 10;
    release();
    expect(await pending).toEqual({ ok: false, error: 'dweb-custody-changed' });
    expect(sent).toEqual([]);
  });

  test('room relay waits for cold App owner revalidation before checking the live tab', async () => {
    let ready = false;
    let release!: () => void;
    const trackerReady = new Promise<void>((resolve) => { release = resolve; });
    const { deps, sent } = baseDeps({
      ensureAppTrackerReady: async () => trackerReady,
      appTabTracker: {
        parseIdFromUrl: () => 'app-one',
        getTabId: () => (ready ? 41 : null),
      },
    });
    const pending = makeDwebRoutes(deps)['dweb/base/room']({
      op: 'join', roomId: 'r1', appId: 'app-one',
      roomAdmissionToken: 'room-admission-token-one', bridgeAppId: 'app-one', bridgeAppGeneration: 0,
    }, {
      url: 'chrome-extension://peerd/engine-tabs/app-tab/index.html#app-one',
      documentId: 'document-one', tab: { id: 41 },
    } as any);
    await Promise.resolve();
    expect(sent).toEqual([]);
    ready = true;
    release();
    expect(await pending).toMatchObject({ ok: true });
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'dweb/base-host/room', op: 'join', appId: 'app-one',
        appDocumentId: 'document-one', appTabId: 41,
      }),
    ]);
  });

  test('room relay rejects a forged App, stale tab, or missing document before host start', async () => {
    const { deps, sent } = baseDeps({
      appTabTracker: {
        parseIdFromUrl: () => 'app-one',
        getTabId: () => 41,
      },
    });
    const route = makeDwebRoutes(deps)['dweb/base/room'];
    expect(await route({ op: 'join', roomId: 'r1', appId: 'app-two' }, {
      url: 'chrome-extension://peerd/engine-tabs/app-tab/index.html#app-one',
      documentId: 'document-one', tab: { id: 41 },
    } as any)).toEqual({ ok: false, error: 'app-room-owner-mismatch' });
    expect(await route({ op: 'join', roomId: 'r1', appId: 'app-one' }, {
      url: 'chrome-extension://peerd/engine-tabs/app-tab/index.html#app-one',
      documentId: 'document-one', tab: { id: 42 },
    } as any)).toEqual({ ok: false, error: 'app-room-owner-mismatch' });
    expect(await route({ op: 'join', roomId: 'r1', appId: 'app-one' }, {
      url: 'chrome-extension://peerd/engine-tabs/app-tab/index.html#app-one', tab: { id: 41 },
    } as any)).toEqual({ ok: false, error: 'app-room-owner-mismatch' });
    expect(sent).toEqual([]);
  });
});

describe('App consent update and room custody cutover', () => {
  const sender: any = { url: 'chrome-extension://peerd/engine-tabs/app-tab/index.html#app-one',
    documentId: 'document-one', tab: { id: 41 } };
  const claim = { appId: 'app-one', bridgeAppId: 'app-one', bridgeAppGeneration: 0,
    roomClientId: 'client-one', roomAdmissionToken: 'admission-one', expectedHostEpoch: 'host-one' };
  const tracked = { parseIdFromUrl: () => 'app-one', getTabId: () => 41 };

  test('a room request queued behind consent rotation refuses before relay', async () => {
    const authority = makeLane();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let generation = 0;
    const rotating = authority(async () => {
      started.resolve();
      await release.promise;
      generation += 1;
    });
    await started.promise;
    const { deps, sent } = baseDeps({ appTabTracker: {
      ...tracked, getDwebGeneration: () => generation,
      withDwebAuthority: (_id: string, operation: () => Promise<any>) => authority(operation),
    } });
    const route = makeDwebRoutes(deps)['dweb/base/room'];
    const joining = route({ ...claim, op: 'join', roomId: 'room-one' }, sender);
    await Promise.resolve();
    expect(sent).toEqual([]);
    release.resolve();
    const [result] = await within(Promise.all([joining, rotating]));
    expect(result).toEqual({ ok: false, error: 'app-identity-changed' });
    expect(sent).toEqual([]);
    expect(await within(route({ ...claim, op: 'leave', roomId: 'room-one' }, sender)))
      .toMatchObject({ ok: true });
    expect(sent[0]).toMatchObject({ op: 'leave', appGeneration: 0,
      appDocumentId: 'document-one', roomAdmissionToken: 'admission-one' });
  });

  test.each([false, true])('outer update callback and room operation settle without re-entering held lanes (room first: %s)', async (roomFirst) => {
    const publication = makeLane();
    const lifecycle = makeLane();
    const authority = makeLane();
    const repository = makeLane();
    let publicationCalls = 0;
    let generation = 0;
    let routes!: ReturnType<typeof makeDwebRoutes>;
    const { deps } = baseDeps({
      withDwebPublication: (operation: (current: () => boolean) => Promise<any>) => {
        publicationCalls += 1;
        return publication(() => operation(() => true));
      },
      withAppLifecycle: (_id: string, operation: () => Promise<any>) => lifecycle(operation),
      appTabTracker: {
        ...tracked, getDwebGeneration: () => generation,
        withDwebAuthority: (_id: string, operation: () => Promise<any>, options: any = {}) => authority(async () => {
          if (options.expectedGeneration != null && options.expectedGeneration !== generation) {
            throw Object.assign(new Error('retired'), { name: 'AppDwebAuthorityChangedError' });
          }
          if (options.invalidate) generation += 1;
          return operation();
        }),
      },
      appRegistry: {
        get: async () => ({ id: 'app-one', entryFile: 'i.html', dweb: {
          git_oid: 'base', dwapp_id: 'stream-one', publisher: 'did:key:publisher',
        } }),
        update: async (_id: string, patch: any) => ({ id: 'app-one', ...patch }),
      },
      appClient: { withWriteLock: (_id: string, operation: () => Promise<any>) => repository(operation) },
      browser: { runtime: { sendMessage: async (message: any) => {
        if (message.type !== 'dweb/base-host/update-app') return { ok: true };
        const applied = await routes['dweb/app-update']({
          appId: 'app-one', entryFile: 'i.html', files: { 'i.html': 'new' },
          publicationGeneration: message.publicationGeneration,
          dweb: { version_id: 'v2', dwapp_id: 'stream-one', publisher: 'did:key:publisher', seq: 2 },
        }, offscreenSender);
        return { ...applied, pendingUnserveHashes: [] };
      } } },
      createDwebRollbackGuard: () => ({ admit: async () => ({ accepted: true }) }),
    });
    routes = makeDwebRoutes(deps);
    const room = () => routes['dweb/base/room']({ ...claim, op: 'publish', roomId: 'room-one' }, sender);
    const update = () => routes['dweb/base/update-app']({ appId: 'app-one', uri: 'peerd://update' });
    const [first, second] = await within(Promise.all(roomFirst ? [room(), update()] : [update(), room()]));
    expect(roomFirst ? second : first).toMatchObject({ ok: true });
    const roomResult = roomFirst ? first : second;
    expect(roomResult.ok || roomResult.error === 'app-identity-changed').toBe(true);
    expect(publicationCalls).toBe(2);
  });

  test('generation hydration is accepted only from the exact offscreen owner', async () => {
    const { deps } = baseDeps();
    const route = makeDwebRoutes(deps)['dweb/app-authority-generations'];
    expect(await route({}, sender)).toMatchObject({ ok: false, error: 'offscreen-sender-required' });
    expect(await route({}, offscreenSender)).toEqual({ ok: true, generations: { a1: 0 } });
  });

  test('a destructive update requires the exact conflict generation', async () => {
    let replacements = 0;
    const { deps } = baseDeps({ appClient: { replaceVersionedFilesUnlocked: async () => { replacements += 1; return { record: {} }; } } });
    const route = makeDwebRoutes(deps)['dweb/app-update'];
    const request = { appId: 'a1', entryFile: 'i.html', files: { 'i.html': 'new' },
      publicationGeneration: 1, strategy: 'replace' };
    expect(await route(request, offscreenSender)).toMatchObject({ error: 'update-conflict-token-required' });
    await deps.appTabTracker.withDwebAuthority('a1', async () => {}, { invalidate: true });
    expect(await route({ ...request, conflictToken: 0 }, offscreenSender))
      .toMatchObject({ error: 'local-changes', conflictToken: 1 });
    expect(replacements).toBe(0);
    expect(await route({ ...request, conflictToken: 1 }, offscreenSender)).toMatchObject({ ok: true });
    expect(replacements).toBe(1);
  });

  test('an equal release tree is safe despite another Git HEAD and excludes only runtime data', async () => {
    let options: any;
    const { deps } = baseDeps({ repositories: {
      statusApp: async () => ({ oid: 'another-commit' }),
      matches: async (_ref: any, opts: any) => { options = opts; return true; },
    } });
    expect(await makeDwebRoutes(deps)['dweb/app-update']({
      appId: 'a1', entryFile: 'i.html', files: { 'i.html': 'new' }, publicationGeneration: 1,
    }, offscreenSender)).toMatchObject({ ok: true });
    expect(options).toEqual({ at: 'base', excludeAppData: true });
  });

  test('a matching hash cannot admit changed executable interpretation as the installed release', async () => {
    const { deps, sent } = baseDeps({
      appTabTracker: tracked,
      appRegistry: { get: async () => ({ id: 'app-one', entryFile: 'changed.html', fileKinds: {},
        dweb: { hash: 'release-hash', git_oid: 'base', release_entry_file: 'index.html', release_file_kinds: {} } }) },
    });
    expect(await makeDwebRoutes(deps)['dweb/base/room']({
      ...claim, op: 'join', bridgeAppHash: 'release-hash', bridgeAppForked: false,
    }, sender)).toMatchObject({ ok: false, error: 'app-identity-changed' });
    expect(sent).toEqual([]);
  });

  test('a queued room operation cannot spend a retired generation but token-bound leave can finish', async () => {
    const { deps, sent } = baseDeps({ appTabTracker: tracked });
    await deps.appTabTracker.withDwebAuthority('app-one', async () => {}, { invalidate: true });
    const route = makeDwebRoutes(deps)['dweb/base/room'];
    expect(await route({ ...claim, op: 'join' }, sender)).toMatchObject({ error: 'app-identity-changed' });
    expect(await route({ ...claim, op: 'leave' }, sender)).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ op: 'leave', appGeneration: 0,
      roomClientId: claim.roomClientId, roomAdmissionToken: claim.roomAdmissionToken, expectedHostEpoch: claim.expectedHostEpoch });
  });

  test('room relay strips forged snapshots and stamps only the held host generation', async () => {
    const { deps, sent } = baseDeps({ appTabTracker: tracked });
    expect(await makeDwebRoutes(deps)['dweb/base/room']({
      ...claim, op: 'join', appGeneration: 500, roomSnapshot: { malicious: true },
      releaseSnapshot: { malicious: true }, release: { malicious: true }, expectedHash: 'forged', created: 1,
    }, sender)).toMatchObject({ ok: true });
    expect(sent[0]).toMatchObject({ appGeneration: 0, publicationGeneration: 1,
      appTabId: 41, appDocumentId: 'document-one' });
    for (const field of ['bridgeAppGeneration', 'roomSnapshot', 'releaseSnapshot', 'release', 'expectedHash', 'created']) {
      expect(Object.hasOwn(sent[0], field)).toBe(false);
    }
  });

  test('publish flushes and snapshots before taking consent and repository locks', async () => {
    const order: string[] = [];
    let authorityHeld = false;
    const snapshot = { record: { id: 'app-one' }, files: { 'index.html': 'eA==' } };
    const { deps, sent } = baseDeps({
      appTabTracker: { ...tracked, withDwebAuthority: async (_id: string, operation: () => Promise<any>) => {
        order.push('authority'); authorityHeld = true;
        try { return await operation(); } finally { authorityHeld = false; }
      } },
      appQuiescence: { runUnlocked: async (_id: string, op: () => Promise<any>) => {
        expect(authorityHeld).toBe(false); order.push('flush'); return op();
      } },
      appClient: {
        snapshotFilesBase64: async () => { expect(authorityHeld).toBe(false); order.push('snapshot'); return snapshot; },
        withWriteLock: async (_id: string, op: () => Promise<any>) => {
          expect(authorityHeld).toBe(true); order.push('repository'); return op();
        },
      },
    });
    expect(await makeDwebRoutes(deps)['dweb/base/room']({ ...claim, op: 'publish-app' }, sender)).toMatchObject({ ok: true });
    expect(order).toEqual(['flush', 'snapshot', 'authority', 'repository']);
    expect(sent[0].roomSnapshot).toEqual({ ok: true, ...snapshot });
  });
});
