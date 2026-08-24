import { describe, expect, test } from 'bun:test';
import { makeKernelRepositoryReadRoutes } from '../../extension/background/kernel-repository-read-routes.js';

const makeHarness = (overrides: Record<string, any> = {}) => {
  const calls: string[] = [];
  const audits: any[] = [];
  const ref = { kind: 'app', id: 'app-1' };
  const repositories = {
    coordinate: async (_ref: any, operation: () => Promise<any>) => {
      calls.push('coordinate'); return operation();
    },
    statusApp: async () => { calls.push('status'); return { branch: 'main', dirty: false }; },
    getAppRemote: async () => { calls.push('remote'); return null; },
    branches: async () => { calls.push('branches'); return ['main']; },
    historyApp: async (_id: string, options: any) => {
      calls.push(`history:${options.depth}`); return [{ oid: 'abc' }];
    },
    diffApp: async () => { calls.push('diff'); return { patch: 'same' }; },
    commitApp: async () => { calls.push('commit'); return { oid: 'new', changed: ['index.html'], created: true }; },
    restoreApp: async () => { calls.push('restore'); return { oid: 'old', restored: true }; },
    branch: async () => { calls.push('branch'); return { name: 'next' }; },
    checkout: async () => { calls.push('checkout'); return { name: 'next' }; },
    setRemote: async () => { calls.push('link'); return { host: 'example.test', url: 'https://example.test/a.git' }; },
    fetch: async () => { calls.push('fetch'); return { remote: { host: 'example.test' } }; },
    push: async () => { calls.push('push'); return { ok: true, branch: 'main', remote: { host: 'example.test' } }; },
  };
  const browser = { tabs: {
    query: async () => [], sendMessage: async () => ({ ok: true }),
    remove: async () => {}, create: async () => ({}),
  } };
  const routes = makeKernelRepositoryReadRoutes({
    browser,
    vault: { isLocked: () => false },
    catalog: { get: async (id: string) => id === 'app-1' ? { id } : null },
    repositories,
    auditLog: { append: async (event: any) => { audits.push(event); } },
    appTabUrl: 'chrome-extension://id/engine-tabs/app-tab/index.html',
    wait: async () => {},
    ...overrides,
  } as any);
  return { routes, calls, audits, repositories, browser, ref };
};

describe('native kernel on-demand App Git routes', () => {
  test('read routes preserve the legacy view and clamp history without an App tab', async () => {
    const h = makeHarness();
    await expect(h.routes['apps/repository/status']({ appId: 'app-1' })).resolves.toEqual({
      ok: true, status: { branch: 'main', dirty: false }, remote: null, branches: ['main'],
    });
    await expect(h.routes['apps/repository/history']({ appId: 'app-1', depth: 1000 }))
      .resolves.toEqual({ ok: true, commits: [{ oid: 'abc' }] });
    await expect(h.routes['apps/repository/diff']({ appId: 'app-1', from: 'abc' }))
      .resolves.toEqual({ ok: true, diff: { patch: 'same' } });
    expect(h.calls).toEqual(['status', 'remote', 'branches', 'history:100', 'diff']);
  });

  test('locked, malformed, and missing Apps refuse before Git or tab IO', async () => {
    let tabReads = 0;
    const h = makeHarness({
      vault: { isLocked: () => true },
      browser: { tabs: { query: async () => { tabReads += 1; return []; } } },
    });
    await expect(h.routes['apps/repository/commit']({ appId: 'app-1' }))
      .resolves.toEqual({ ok: false, error: 'vault-locked' });
    await expect(h.routes['apps/repository/status']({}))
      .resolves.toEqual({ ok: false, error: 'appId-required' });
    expect(h.calls).toEqual([]);
    expect(tabReads).toBe(0);
  });

  test('a tree-changing restore closes and reopens the exact owner URL in order', async () => {
    const order: string[] = [];
    const h = makeHarness({
      browser: { tabs: {
        query: async () => [{ id: 9, url: 'chrome-extension://id/engine-tabs/app-tab/index.html#app-1?owner=chat' }],
        sendMessage: async () => { order.push('flush'); return { ok: true }; },
        remove: async () => { order.push('close'); },
        create: async ({ url }: any) => { order.push(`reopen:${url}`); return {}; },
      } },
      repositories: {
        ...hPlaceholder,
        coordinate: async (_ref: any, operation: () => Promise<any>) => {
          order.push('coordinate'); return operation();
        },
        restoreApp: async () => { order.push('restore'); return { oid: 'old', restored: true }; },
      },
      wait: async () => { order.push('settle'); },
    });
    await expect(h.routes['apps/repository/restore']({ appId: 'app-1', to: 'old' }))
      .resolves.toMatchObject({ ok: true, result: { oid: 'old' } });
    expect(order).toEqual([
      'flush', 'close', 'settle', 'coordinate', 'restore',
      'reopen:chrome-extension://id/engine-tabs/app-tab/index.html#app-1?owner=chat',
    ]);
  });

  test('checkpoint work freezes then resumes the live App without making it disappear', async () => {
    const order: string[] = [];
    const h = makeHarness({
      browser: { tabs: {
        query: async () => [{ id: 9, url: 'chrome-extension://id/engine-tabs/app-tab/index.html#app-1?owner=chat' }],
        sendMessage: async (_id: number, message: any) => {
          order.push(message.action); return { ok: true };
        },
        remove: async () => { order.push('unexpected-close'); },
        reload: async () => {},
      } },
      repositories: {
        ...hPlaceholder,
        coordinate: async (_ref: any, operation: () => Promise<any>) => operation(),
        commitApp: async () => { order.push('commit'); return { oid: 'new', changed: [] }; },
      },
    });
    await expect(h.routes['apps/repository/commit']({ appId: 'app-1' }))
      .resolves.toMatchObject({ ok: true });
    expect(order).toEqual(['acquire', 'commit', 'release']);
  });

  test('post-dispatch unknown outcome is explicit, human, and never replayed', async () => {
    let commits = 0;
    const error = Object.assign(new Error('raw transport code'), {
      code: 'repository-host-timeout', outcomeKnown: false,
    });
    const h = makeHarness({ repositories: {
      ...hPlaceholder,
      coordinate: async (_ref: any, operation: () => Promise<any>) => operation(),
      commitApp: async () => { commits += 1; throw error; },
    } });
    await expect(h.routes['apps/repository/commit']({ appId: 'app-1' })).resolves.toEqual({
      ok: false, code: 'repository-host-timeout', outcomeKnown: false,
      retryable: false,
      error: 'Peerd could not confirm the result of trying to save the Git checkpoint. Refresh Git history to reconcile before trying again.',
    });
    expect(commits).toBe(1);
  });

  test('remote linking is serialized and audited without opening an App tab', async () => {
    const h = makeHarness();
    await expect(h.routes['apps/repository/link']({
      appId: 'app-1', url: 'https://example.test/a.git',
    })).resolves.toMatchObject({ ok: true, remote: { host: 'example.test' } });
    expect(h.calls).toEqual(['coordinate', 'link']);
    expect(h.audits).toEqual([{ type: 'git_remote_linked', details: {
      kind: 'app', appId: 'app-1', host: 'example.test', url: 'https://example.test/a.git',
    } }]);
  });

  test('fetch is serialized while push checkpoints inside the quiesced transaction', async () => {
    const h = makeHarness();
    await expect(h.routes['apps/repository/fetch']({ appId: 'app-1' }))
      .resolves.toMatchObject({ ok: true, result: { remote: { host: 'example.test' } } });
    await expect(h.routes['apps/repository/push']({ appId: 'app-1', branch: 'main' }))
      .resolves.toMatchObject({ ok: true, result: { branch: 'main' } });
    expect(h.calls).toEqual(['coordinate', 'fetch', 'coordinate', 'commit', 'push']);
    expect(h.audits.map((event) => event.type)).toEqual([
      'git_remote_fetched', 'git_remote_pushed',
    ]);
  });

  test('a post-dispatch push loss is unknown and never replayed', async () => {
    let pushes = 0;
    const cause = Object.assign(new Error('lost after dispatch'), {
      code: 'repository-host-timeout', outcomeKnown: false,
    });
    const h = makeHarness({ repositories: {
      ...hPlaceholder,
      coordinate: async (_ref: any, operation: () => Promise<any>) => operation(),
      commitApp: async () => ({ oid: 'checkpoint', changed: [], created: false }),
      push: async () => { pushes += 1; throw cause; },
    } });
    await expect(h.routes['apps/repository/push']({ appId: 'app-1' })).resolves.toEqual({
      ok: false, code: 'repository-host-timeout', outcomeKnown: false,
      retryable: false,
      error: 'Peerd could not confirm the result of trying to push this Git branch. Refresh Git history to reconcile before trying again.',
    });
    expect(pushes).toBe(1);
  });

  test('Git import preserves the manifest, byte kinds, owner, and repository result', async () => {
    const catalogCalls: any[] = [];
    const repositoryCalls: any[] = [];
    const record = { id: 'app-import', name: 'Imported' };
    const files: Record<string, Uint8Array> = {
      'peerd.json': new TextEncoder().encode(JSON.stringify({
        schema: 1, kind: 'app', entry: 'src/main.html',
        agent: { kind: 'bound-app', profile: 'developer', surface: 'code' },
        capabilities: [],
      })),
      'src/main.html': new TextEncoder().encode('<main>hello</main>'),
      'assets/pixel.png': new TextEncoder().encode('valid utf8 but binary by suffix'),
    };
    const h = makeHarness({
      sessionCache: { sessionGet: async () => 'chat-root' },
      catalog: {
        get: async () => null,
        createImported: async (input: any) => {
          catalogCalls.push(['create', input]); return record;
        },
        patch: async (id: string, patch: any) => {
          catalogCalls.push(['patch', id, patch]); return { ...record, ...patch };
        },
        setDefaultForSession: async (...args: any[]) => { catalogCalls.push(['default', ...args]); },
        remove: async (...args: any[]) => { catalogCalls.push(['remove', ...args]); },
      },
      repositories: {
        ...hPlaceholder,
        coordinate: async (_ref: any, operation: () => Promise<any>) => operation(),
        clone: async (...args: any[]) => {
          repositoryCalls.push(['clone', ...args]); return { branch: 'main', oid: 'abc' };
        },
        destroy: async (...args: any[]) => { repositoryCalls.push(['destroy', ...args]); },
      },
      appFiles: {
        inspectApp: async () => ({
          fileKinds: {
            'peerd.json': 'text', 'src/main.html': 'text', 'assets/pixel.png': 'binary',
          },
          contract: {
            schema: 1, kind: 'app', entry: 'src/main.html',
            agent: { kind: 'bound-app', profile: 'developer', surface: 'code' },
            capabilities: [],
          },
        }),
      },
    });
    const reply = await h.routes['apps/import-git']({
      url: 'https://example.test/app.git', name: 'Imported', ref: 'stable', depth: 900,
    });
    expect(reply).toMatchObject({
      ok: true, record: { id: 'app-import', entryFile: 'src/main.html' },
      repository: { branch: 'main', oid: 'abc' },
      contract: { kind: 'app', entry: 'src/main.html' },
    });
    expect(repositoryCalls).toEqual([['clone', { kind: 'app', id: 'app-import' }, {
      url: 'https://example.test/app.git', ref: 'stable', depth: 500,
    }]]);
    expect(catalogCalls).toEqual([
      ['create', { name: 'Imported', ownerSessionId: 'chat-root' }],
      ['patch', 'app-import', {
        entryFile: 'src/main.html',
        fileKinds: {
          'peerd.json': 'text', 'src/main.html': 'text', 'assets/pixel.png': 'binary',
        },
      }],
      ['default', 'chat-root', 'app-import'],
    ]);
  });

  test('unknown clone custody keeps its exact provisional record for reconciliation', async () => {
    const effects: string[] = [];
    const cause = Object.assign(new Error('raw lost reply'), {
      code: 'repository-host-timeout', outcomeKnown: false,
    });
    const h = makeHarness({
      catalog: {
        get: async () => null,
        createImported: async () => ({ id: 'app-import' }),
        remove: async () => { effects.push('remove'); },
      },
      repositories: {
        ...hPlaceholder,
        coordinate: async (_ref: any, operation: () => Promise<any>) => operation(),
        clone: async () => { effects.push('clone'); throw cause; },
        destroy: async () => { effects.push('destroy'); },
      },
      appFiles: { inspectApp: async () => ({ fileKinds: {}, contract: null }) },
    });
    await expect(h.routes['apps/import-git']({ url: 'https://example.test/app.git' }))
      .resolves.toEqual({
        ok: false, code: 'repository-host-timeout', outcomeKnown: false,
        retryable: false, appId: 'app-import',
        error: 'Peerd could not confirm the result of trying to finish the Git import. Refresh Git history to reconcile before trying again.',
      });
    expect(effects).toEqual(['clone']);
  });

  test('known invalid repositories are destroyed before their catalog record is removed', async () => {
    const effects: string[] = [];
    const h = makeHarness({
      catalog: {
        get: async () => null,
        createImported: async () => ({ id: 'app-import' }),
        remove: async () => { effects.push('remove'); return true; },
      },
      repositories: {
        ...hPlaceholder,
        coordinate: async (_ref: any, operation: () => Promise<any>) => operation(),
        clone: async () => ({ branch: 'main' }),
        destroy: async () => { effects.push('destroy'); },
      },
      appFiles: { inspectApp: async () => { throw new Error('repository is not an App: add peerd.json or index.html'); } },
    });
    await expect(h.routes['apps/import-git']({ url: 'https://example.test/not-app.git' }))
      .resolves.toEqual({ ok: false, error: 'repository is not an App: add peerd.json or index.html' });
    expect(effects).toEqual(['destroy', 'remove']);
  });
});

const hPlaceholder = {
  statusApp: async () => ({}), getAppRemote: async () => null,
  branches: async () => [], historyApp: async () => [], diffApp: async () => ({}),
  restoreApp: async () => ({}), branch: async () => ({}), checkout: async () => ({}),
  setRemote: async () => ({}), fetch: async () => ({}), push: async () => ({}),
  commitApp: async () => ({ oid: 'checkpoint', changed: [], created: false }),
};
