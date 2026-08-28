import { describe, expect, test } from 'bun:test';
import { makeDwebShare } from '../../extension/background/dweb-share.js';
import { createAppQuiescence } from '../../extension/background/app-quiescence.js';

const makeLane = () => {
  let tail = Promise.resolve();
  return <T>(operation: () => Promise<T>) => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
};
const withAppLifecycle = <T>(_appId: string, operation: () => Promise<T>) => operation();
const withDwebPublication = <T>(operation: (isCurrent: () => boolean) => Promise<T>) => operation(() => true);

describe('identity-bound dweb share', () => {
  test('refuses a changed live tree before the mesh publication edge', async () => {
    let liveText = 'approved';
    const messages: any[] = [];
    const share = makeDwebShare({
      enabled: true, active: () => true, withDwebPublication,
      withIdentityMutation: makeLane(), withAppLifecycle,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: {} }),
        update: async () => ({ id: 'app-1' }),
      },
      repositories: {
        workingSnapshot: async () => ({
          'index.html': new TextEncoder().encode(liveText),
        }),
        statusApp: async () => ({ changed: [] }),
        commitApp: async () => ({ oid: 'a'.repeat(40) }),
        historyApp: async () => [],
        snapshot: async () => ({ 'index.html': new TextEncoder().encode(liveText) }),
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => { messages.push(message); return { ok: true }; },
    });

    const prepared = await share.prepare('app-1');
    liveText = 'changed-after-confirmation';
    expect(await share('app-1', undefined, prepared)).toEqual({
      ok: false, error: 'share-prepared-snapshot-changed',
      outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
    });
    expect(messages.some((message) => message.type === 'dweb/base-host/share-app')).toBe(false);
  });

  test('a post-commit snapshot mismatch preserves durable commit custody', async () => {
    const messages: any[] = [];
    let committed = false;
    const share = makeDwebShare({
      enabled: true, active: () => true, withDwebPublication,
      withIdentityMutation: makeLane(), withAppLifecycle,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: {} }),
        update: async () => ({ id: 'app-1' }),
      },
      repositories: {
        workingSnapshot: async () => ({
          'index.html': new TextEncoder().encode('approved'),
        }),
        statusApp: async () => ({ changed: [] }),
        commitApp: async () => { committed = true; return { oid: 'a'.repeat(40) }; },
        historyApp: async () => [],
        snapshot: async () => ({
          'index.html': new TextEncoder().encode('different-commit'),
        }),
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => { messages.push(message); return { ok: true }; },
    });

    const prepared = await share.prepare('app-1');
    expect(await share('app-1', undefined, prepared)).toEqual({
      ok: false, error: 'share-prepared-snapshot-changed', performed: true,
      outcomeKnown: true, outcomeKind: 'effect-completed', retryable: false,
    });
    expect(committed).toBe(true);
    expect(messages.some((message) => message.type === 'dweb/base-host/share-app')).toBe(false);
  });

  test.each([
    ['mesh refusal', 'mesh-refused', async () => ({ ok: false, error: 'mesh-refused' })],
    ['metadata rollback', 'share-metadata-store-failed', async (message: any) =>
      message.type === 'dweb/base-host/rollback-share'
        ? { ok: true } : { ok: true, hash: 'new', transactionId: 'tx' }],
  ] as const)('preserves the local commit after post-commit %s', async (
    _label, expectedError, sendMessage,
  ) => {
    const share = makeDwebShare({
      enabled: true, active: () => true, withDwebPublication,
      withIdentityMutation: makeLane(), withAppLifecycle,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: {} }),
        update: async () => {
          if (expectedError === 'share-metadata-store-failed') throw new Error('disk');
          return { id: 'app-1' };
        },
      },
      repositories: {
        workingSnapshot: async () => ({
          'index.html': new TextEncoder().encode('approved'),
        }),
        statusApp: async () => ({ changed: [] }),
        commitApp: async () => ({ oid: 'a'.repeat(40) }),
        historyApp: async () => [],
        snapshot: async () => ({
          'index.html': new TextEncoder().encode('approved'),
        }),
      },
      prepareRuntime: async () => ({ ok: true }), sendMessage,
    });
    const prepared = await share.prepare('app-1');
    expect(await share('app-1', undefined, prepared)).toMatchObject({
      ok: false, error: expectedError, performed: true,
      outcomeKnown: true, outcomeKind: 'effect-completed', retryable: false,
    });
  });

  test('a thrown mesh failure after a local commit remains unknown and nonretryable', async () => {
    const share = makeDwebShare({
      enabled: true, active: () => true, withDwebPublication,
      withIdentityMutation: makeLane(), withAppLifecycle,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: {} }),
        update: async () => ({ id: 'app-1' }),
      },
      repositories: {
        workingSnapshot: async () => ({
          'index.html': new TextEncoder().encode('approved'),
        }),
        statusApp: async () => ({ changed: [] }),
        commitApp: async () => ({ oid: 'a'.repeat(40) }),
        historyApp: async () => [],
        snapshot: async () => ({
          'index.html': new TextEncoder().encode('approved'),
        }),
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async () => { throw new Error('mesh disconnected'); },
    });
    const prepared = await share.prepare('app-1');
    await expect(share('app-1', undefined, prepared)).rejects.toMatchObject({
      performed: true, outcomeKnown: false, outcomeKind: 'host-lost', retryable: false,
    });
  });

  test('publish and complete identity metadata persistence stay in the custody lane', async () => {
    const events: string[] = [];
    const lane = makeLane();
    let releasePublish!: () => void;
    const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
    let publishStarted!: () => void;
    const published = new Promise<void>((resolve) => { publishStarted = resolve; });
    let persisted: any;
    const share = makeDwebShare({
      enabled: true, active: () => true, withDwebPublication, withIdentityMutation: lane, withAppLifecycle,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: {} }),
        update: async (_id, patch) => { events.push('persist'); persisted = patch; return { id: 'app-1' }; },
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => {
        if (message.type === 'dweb/base-host/commit-share') return { ok: true };
        events.push('publish');
        publishStarted();
        await publishGate;
        return { ok: true, uri: 'peerd://bundle', publisher: 'did:key:zOld', hash: 'hash', slug: 'app', dwapp_id: 'dwapp', seq: 7, transactionId: 'tx-1' };
      },
    });

    const sharing = share('app-1', 'app');
    await published;
    const replacing = lane(async () => { events.push('replace'); });
    expect(events).toEqual(['publish']);
    releasePublish();
    await Promise.all([sharing, replacing]);
    expect(events).toEqual(['publish', 'persist', 'replace']);
    expect(persisted).toEqual({
      shared: true,
      dweb: {
        uri: 'peerd://bundle', publisher: 'did:key:zOld', hash: 'hash', version_id: 'hash',
        slug: 'app', dwapp_id: 'dwapp', seq: 7, local: true,
      },
    });
  });

  test('publishes one immutable Git release and persists its signed lineage', async () => {
    const committedOid = 'a'.repeat(40);
    const previousOid = 'b'.repeat(40);
    const previousVersionId = 'c'.repeat(64);
    const publishedHash = 'd'.repeat(64);
    const events: string[] = [];
    const patches: any[] = [];
    let publication: any = null;
    const quiescence = createAppQuiescence({
      tracker: {
        getTabId: () => 41,
        quiesceTab: async () => { events.push('flush'); return true; },
        resumeTab: async () => { events.push('resume'); return true; },
        closeTab: async () => true,
        ensureTab: async () => 41,
        reloadTab: async () => true,
      },
      withLifecycle: async (_appId, operation) => operation(),
    });
    const share = makeDwebShare({
      enabled: true,
      active: () => true,
      withDwebPublication,
      withIdentityMutation: makeLane(),
      withAppLifecycle,
      withAppWriteLock: (appId, operation) => quiescence.runUnlocked(appId, async () => {
        events.push('lock-enter');
        try { return await operation(); }
        finally { events.push('lock-exit'); }
      }),
      appRegistry: {
        get: async () => ({
          name: 'Release App', entryFile: 'index.html',
          fileKinds: { 'index.html': 'text', 'module.wasm': 'binary' },
          dweb: {
            git_oid: previousOid,
            version_id: previousVersionId,
            published_hashes: ['e'.repeat(64)],
          },
        }),
        update: async (_id, patch) => { events.push('persist'); patches.push(patch); return { id: 'app-1', ...patch }; },
      },
      repositories: {
        statusApp: async () => ({ changed: [{ path: 'index.html' }, { path: 'module.wasm' }] }),
        commitApp: async (_id, opts) => {
          events.push(`commit:${opts.message}`);
          return { oid: committedOid, created: true };
        },
        historyApp: async () => [
          { oid: committedOid, message: 'release: update index.html, module.wasm' },
          { oid: 'f'.repeat(40), message: 'improve wasm worker\ninternal detail' },
          { oid: previousOid, message: 'previous release' },
        ],
        snapshot: async (_ref, opts) => {
          events.push(`snapshot:${opts.at}`);
          return {
            'index.html': new TextEncoder().encode('<h1>release</h1>'),
            'module.wasm': Uint8Array.of(0, 97, 115, 109),
          };
        },
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => {
        if (message.type === 'dweb/base-host/commit-share') return { ok: true };
        publication = message;
        events.push('publish');
        return {
          ok: true, uri: `peerd://did:key:zLocal/${publishedHash}`,
          publisher: 'did:key:zLocal', hash: publishedHash, slug: 'release-app',
          dwapp_id: 'dwapp', seq: 8, created: 1234, transactionId: 'tx-release',
        };
      },
    });

    expect(await share('app-1', 'release-app')).toMatchObject({ ok: true, hash: publishedHash });
    expect(publication.release).toEqual({
      previousVersionId,
      gitCommitOid: committedOid,
      changelog: 'improve wasm worker\nrelease: update index.html, module.wasm',
    });
    expect(publication.releaseSnapshot).toMatchObject({
      ok: true,
      oid: committedOid,
      totalBytes: 20,
      record: {
        name: 'Release App', entryFile: 'index.html',
        fileKinds: { 'index.html': 'text', 'module.wasm': 'binary' },
      },
    });
    expect(atob(publication.releaseSnapshot.files['index.html'].base64)).toBe('<h1>release</h1>');
    expect([...Uint8Array.from(atob(publication.releaseSnapshot.files['module.wasm'].base64), (c) => c.charCodeAt(0))])
      .toEqual([0, 97, 115, 109]);
    expect(patches[0].dweb).toMatchObject({
      git_oid: committedOid,
      source_git_oid: committedOid,
      previous_version_id: previousVersionId,
      changelog: 'improve wasm worker\nrelease: update index.html, module.wasm',
      release_created: 1234,
      published_hashes: ['e'.repeat(64), publishedHash],
    });
    expect(events).toEqual([
      'flush',
      'lock-enter',
      'lock-exit',
      'resume',
      'flush',
      'lock-enter',
      'commit:release: update index.html, module.wasm',
      `snapshot:${committedOid}`,
      'publish',
      'persist',
      'lock-exit',
      'resume',
    ]);
  });

  test('passes the previously served hash so a successful reshare can revoke it', async () => {
    const messages: any[] = [];
    const patches: any[] = [];
    const share = makeDwebShare({
      enabled: true, active: () => true, withDwebPublication, withIdentityMutation: makeLane(), withAppLifecycle,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: { hash: 'old', slug: 'app', local: true } }),
        update: async (_id, patch) => { patches.push(patch); return { id: 'app-1', ...patch }; },
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => {
        messages.push(message);
        if (message.type === 'dweb/base-host/commit-share') return { ok: true };
        if (message.type === 'dweb/base-host/unserve-content') return { ok: true, unserved: true };
        return { ok: true, uri: 'peerd://new', hash: 'new', slug: 'app', dwapp_id: 'd', seq: 2, transactionId: 'tx-2' };
      },
    });
    expect((await share('app-1', undefined)).ok).toBe(true);
    expect(messages[0]).toMatchObject({
      type: 'dweb/base-host/share-app', previousHash: 'old', slug: 'app',
    });
    expect(messages.find((message) => message.type === 'dweb/base-host/unserve-content')).toEqual({
      type: 'dweb/base-host/unserve-content', appId: 'app-1', hash: 'old', slot: 'share',
    });
    expect(patches[0].dweb.pending_unserve_hashes).toEqual(['old']);
    expect(patches[1].dwebExact.pending_unserve_hashes).toBeUndefined();
  });

  test('metadata failure rolls back the published share and reports failure', async () => {
    const messages: any[] = [];
    const share = makeDwebShare({
      enabled: true, active: () => true, withDwebPublication, withIdentityMutation: makeLane(), withAppLifecycle,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: {} }),
        update: async () => { throw new Error('disk'); },
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => {
        messages.push(message);
        return message.type === 'dweb/base-host/rollback-share'
          ? { ok: true }
          : { ok: true, publisher: 'did:key:zOld', hash: 'hash', slug: 'custom-slug', transactionId: 'tx-3' };
      },
    });
    expect(await share('app-1', undefined)).toMatchObject({ ok: false, error: 'share-metadata-store-failed' });
    expect(messages.map((message) => message.type)).toEqual([
      'dweb/base-host/share-app', 'dweb/base-host/rollback-share',
    ]);
    expect(messages[1]).toMatchObject({
      transactionId: 'tx-3',
    });
  });

  test('cold runtime preparation completes before the share takes the custody lane', async () => {
    const events: string[] = [];
    const lane = makeLane();
    const share = makeDwebShare({
      enabled: true, active: () => true, withDwebPublication, withIdentityMutation: lane, withAppLifecycle,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: { local: false } }),
        update: async (_id, patch) => { events.push('persist'); return { id: 'app-1', ...patch }; },
      },
      prepareRuntime: () => lane(async () => { events.push('mint'); return { ok: true }; }),
      sendMessage: async (message) => {
        if (message.type === 'dweb/base-host/commit-share') return { ok: true };
        events.push('publish');
        return { ok: true, uri: 'peerd://bundle', publisher: 'did:key:zLocal', hash: 'hash', slug: 'app', dwapp_id: 'dwapp', seq: 1, transactionId: 'tx-4' };
      },
    });
    expect(await share('app-1', undefined)).toMatchObject({ ok: true });
    expect(events).toEqual(['mint', 'publish', 'persist']);
  });

  test('a concurrent deletion is a persistence failure and rolls back', async () => {
    const messages: any[] = [];
    const share = makeDwebShare({
      enabled: true, active: () => true, withDwebPublication, withIdentityMutation: makeLane(), withAppLifecycle,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: {} }),
        update: async () => null,
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => {
        messages.push(message);
        return message.type === 'dweb/base-host/rollback-share'
          ? { ok: true }
          : { ok: true, publisher: 'did:key:zOld', hash: 'hash', slug: 'app', transactionId: 'tx-5' };
      },
    });
    expect(await share('app-1', undefined)).toMatchObject({
      ok: false, error: 'share-metadata-store-failed',
    });
    expect(messages.at(-1)).toMatchObject({
      type: 'dweb/base-host/rollback-share', transactionId: 'tx-5',
    });
  });

  test('a failed reshare restores the last durable share metadata', async () => {
    const messages: any[] = [];
    const share = makeDwebShare({
      enabled: true, active: () => true, withDwebPublication, withIdentityMutation: makeLane(), withAppLifecycle,
      appRegistry: {
        get: async () => ({
          name: 'App', entryFile: 'index.html',
          dweb: { hash: 'old', uri: 'peerd://old', size: 123, slug: 'app', local: true },
        }),
        update: async () => { throw new Error('disk'); },
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => {
        messages.push(message);
        if (message.type === 'dweb/base-host/rollback-share') return { ok: true, restored: true };
        return {
          ok: true, publisher: 'did:key:zOld', uri: 'peerd://new', hash: 'new',
          size: 456, slug: 'app', seq: 9, transactionId: 'tx-6',
        };
      },
    });

    expect(await share('app-1', undefined)).toMatchObject({
      ok: false, error: 'share-metadata-store-failed',
    });
    expect(messages[1]).toMatchObject({
      type: 'dweb/base-host/rollback-share', transactionId: 'tx-6', failedSeq: 9,
    });
  });

  test('reports committed success when old-version cleanup needs a later retry', async () => {
    const patches: any[] = [];
    const share = makeDwebShare({
      enabled: true, active: () => true, withDwebPublication, withIdentityMutation: makeLane(), withAppLifecycle,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: { hash: 'old', local: true } }),
        update: async (_id, patch) => { patches.push(patch); return { id: 'app-1', ...patch }; },
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => {
        if (message.type === 'dweb/base-host/unserve-content') return { ok: false, error: 'host busy' };
        if (message.type === 'dweb/base-host/commit-share') return { ok: true };
        return { ok: true, uri: 'peerd://new', hash: 'new', slug: 'app', seq: 2, transactionId: 'tx-7' };
      },
    });

    expect(await share('app-1', undefined)).toMatchObject({
      ok: true,
      hash: 'new',
      warning: 'previous-version-cleanup-pending',
      cleanupPending: true,
    });
    expect(patches).toHaveLength(1);
    expect(patches[0].dweb.pending_unserve_hashes).toEqual(['old']);
  });

  test('resharing an installed App cleans update retries through the seed slot', async () => {
    const messages: any[] = [];
    const patches: any[] = [];
    const share = makeDwebShare({
      enabled: true, active: () => true, withDwebPublication,
      withIdentityMutation: makeLane(), withAppLifecycle,
      appRegistry: {
        get: async () => ({
          name: 'Installed', entryFile: 'index.html',
          dweb: {
            hash: 'installed-current', slug: 'installed', local: false,
            pending_seed_unserve_hashes: ['installed-old'],
          },
        }),
        update: async (_id, patch) => { patches.push(patch); return { id: 'app-1', ...patch }; },
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => {
        messages.push(message);
        if (message.type === 'dweb/base-host/commit-share') return { ok: true };
        if (message.type === 'dweb/base-host/unserve-content') return { ok: true, unserved: true };
        return {
          ok: true, uri: 'peerd://local-new', hash: 'local-new', slug: 'installed',
          seq: 1, transactionId: 'tx-installed-reshare',
        };
      },
    });

    expect(await share('app-1', undefined)).toMatchObject({ ok: true, hash: 'local-new' });
    expect(messages[0]).toMatchObject({
      type: 'dweb/base-host/share-app', previousHash: null,
    });
    expect(messages.filter((message) => message.type === 'dweb/base-host/unserve-content'))
      .toEqual([
        { type: 'dweb/base-host/unserve-content', appId: 'app-1', hash: 'installed-old', slot: 'seed' },
        { type: 'dweb/base-host/unserve-content', appId: 'app-1', hash: 'installed-current', slot: 'seed' },
      ]);
    expect(patches[0].dweb.pending_seed_unserve_hashes)
      .toEqual(['installed-old', 'installed-current']);
    expect(patches[1].dwebExact.pending_seed_unserve_hashes).toBeUndefined();
  });

  test('requires host restoration when a legacy prior share lacks stored size', async () => {
    const share = makeDwebShare({
      enabled: true, active: () => true, withDwebPublication, withIdentityMutation: makeLane(), withAppLifecycle,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: { hash: 'old', uri: 'peerd://old', local: true } }),
        update: async () => { throw new Error('disk'); },
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => message.type === 'dweb/base-host/rollback-share'
        ? { ok: true, restored: false }
        : { ok: true, uri: 'peerd://new', hash: 'new', slug: 'app', seq: 4, transactionId: 'tx-8' },
    });

    expect(await share('app-1', undefined)).toMatchObject({
      ok: false, error: 'share-rollback-failed',
    });
  });

  test('retries one failed host rollback with the same transaction id', async () => {
    const rollbacks: any[] = [];
    const share = makeDwebShare({
      enabled: true, active: () => true, withDwebPublication,
      withIdentityMutation: makeLane(), withAppLifecycle,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: {} }),
        update: async () => { throw new Error('disk'); },
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => {
        if (message.type !== 'dweb/base-host/rollback-share') {
          return { ok: true, hash: 'new', slug: 'app', transactionId: 'tx-retry' };
        }
        rollbacks.push(message);
        return rollbacks.length === 1 ? { ok: false, error: 'restore failed' } : { ok: true };
      },
    });
    expect(await share('app-1', undefined)).toMatchObject({
      ok: false, error: 'share-metadata-store-failed',
    });
    expect(rollbacks.map((message) => message.transactionId)).toEqual(['tx-retry', 'tx-retry']);
  });

  test('records the uncertain new hash when rollback cannot finish', async () => {
    const patches: any[] = [];
    const share = makeDwebShare({
      enabled: true, active: () => true, withDwebPublication,
      withIdentityMutation: makeLane(), withAppLifecycle,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: { hash: 'old', local: true } }),
        update: async (_id, patch) => {
          patches.push(patch);
          if (patches.length === 1) throw new Error('disk');
          return { id: 'app-1', ...patch };
        },
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => message.type === 'dweb/base-host/rollback-share'
        ? { ok: false, error: 'host busy' }
        : { ok: true, hash: 'new', slug: 'app', transactionId: 'tx-uncertain' },
    });
    expect(await share('app-1', undefined)).toMatchObject({ ok: false, error: 'share-rollback-failed' });
    expect(patches[1]).toMatchObject({
      shared: true,
      dweb: { hash: 'old', local: true, pending_unserve_hashes: ['new'] },
    });
  });

  test('a master-off generation change after publication rolls the share back before metadata commit', async () => {
    let current = true;
    let updated = false;
    const messages: any[] = [];
    const share = makeDwebShare({
      enabled: true,
      active: () => current,
      withDwebPublication: (operation) => operation(() => current),
      withIdentityMutation: makeLane(),
      withAppLifecycle,
      appRegistry: {
        get: async () => ({ name: 'App', entryFile: 'index.html', dweb: {} }),
        update: async () => { updated = true; return { id: 'app-1' }; },
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => {
        messages.push(message);
        if (message.type === 'dweb/base-host/share-app') {
          current = false;
          return { ok: true, hash: 'new', slug: 'app', transactionId: 'tx-disabled' };
        }
        return { ok: true };
      },
    });
    expect(await share('app-1', undefined)).toEqual({ ok: false, error: 'dweb-disabled' });
    expect(updated).toBe(false);
    expect(messages.at(-1)).toMatchObject({
      type: 'dweb/base-host/rollback-share', transactionId: 'tx-disabled',
    });
  });

  test('master-off retains the new hash when both rollback attempts fail', async () => {
    let current = true;
    const patches: any[] = [];
    const rollbacks: any[] = [];
    const share = makeDwebShare({
      enabled: true,
      active: () => current,
      withDwebPublication: (operation) => operation(() => current),
      withIdentityMutation: makeLane(),
      withAppLifecycle,
      appRegistry: {
        get: async () => ({
          name: 'App', entryFile: 'index.html',
          dweb: { hash: 'old', local: true, pending_unserve_hashes: ['older'] },
        }),
        update: async (_id, patch) => { patches.push(patch); return { id: 'app-1', ...patch }; },
      },
      prepareRuntime: async () => ({ ok: true }),
      sendMessage: async (message) => {
        if (message.type === 'dweb/base-host/share-app') {
          current = false;
          return { ok: true, hash: 'new', slug: 'app', transactionId: 'tx-off-failed' };
        }
        rollbacks.push(message);
        return { ok: false, error: 'host busy' };
      },
    });

    expect(await share('app-1', undefined)).toMatchObject({
      ok: false, error: 'share-rollback-failed',
    });
    expect(rollbacks).toHaveLength(2);
    expect(rollbacks.every((message) => message.transactionId === 'tx-off-failed')).toBe(true);
    expect(patches).toEqual([{
      shared: true,
      dweb: { hash: 'old', local: true, pending_unserve_hashes: ['older', 'new'] },
    }]);
  });
});
