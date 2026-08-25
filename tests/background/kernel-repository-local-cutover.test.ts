import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createKernelFeatureHost } from '../../extension/offscreen/kernel-feature-host.js';
import { createKernelRepositoryControl } from '../../extension/background/kernel-repository-control.js';
import { createKernelLocalControl } from '../../extension/background/kernel-local-control.js';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

const repositoryDeps = (overrides: Record<string, any> = {}) => {
  const records = new Map([['app-1', { id: 'app-1', name: 'One' }]]);
  const calls: string[] = [];
  const repositories = {
    coordinate: async (_ref: any, operation: () => Promise<any>) => operation(),
    statusApp: async () => ({ branch: 'main' }),
    getAppRemote: async () => null,
    branches: async () => ['main'],
    historyApp: async () => [{ oid: 'one' }],
    diffApp: async () => 'diff',
    commitApp: async () => ({ oid: 'two', changed: ['index.js'] }),
    restoreApp: async () => ({ oid: 'one' }),
    branch: async () => ({ branch: 'next' }),
    checkout: async () => ({ branch: 'next' }),
    setRemote: async () => ({ host: 'example.test', url: 'https://example.test/a.git' }),
    fetch: async () => ({ remote: { host: 'example.test' } }),
    push: async () => ({ ok: true, remote: { host: 'example.test' }, branch: 'main' }),
    clone: async () => ({ branch: 'main' }),
    destroy: async () => { calls.push('destroy'); },
    ...overrides.repositories,
  };
  return {
    records, calls,
    catalog: {
      get: async (id: string) => records.get(id) ?? null,
      createImported: async ({ name }: any) => {
        const record = { id: 'import-1', name: name ?? 'Imported' };
        records.set(record.id, record);
        return record;
      },
      patch: async (id: string, patch: any) => {
        const record = records.get(id);
        if (!record) return null;
        const next = { ...record, ...patch };
        records.set(id, next);
        return next;
      },
      remove: async (id: string) => { records.delete(id); },
      setDefaultForSession: async () => {},
    },
    appFiles: { inspectApp: async () => ({
      fileKinds: { 'index.js': 'text' },
      contract: { entry: 'index.js', capabilities: [] },
    }) },
    vault: { isLocked: () => false },
    browser: { tabs: {
      query: async () => [], sendMessage: async () => ({ ok: true }),
      remove: async () => {}, create: async () => {}, reload: async () => {},
    } },
    auditLog: { append: async () => {} },
    appTabUrl: 'chrome-extension://id/engine-tabs/app-tab/index.html',
    sessionCache: { sessionGet: async () => 'session-1' },
    allowDweb: false,
    ...overrides,
    repositories,
  };
};

const repositoryLane = (overrides: Record<string, any> = {}) => {
  const host = createKernelFeatureHost({
    loaders: { repository: overrides.loader
      ?? (() => import('../../extension/offscreen/kernel-repository-host.js')) },
    loadTimeoutMs: overrides.loadTimeoutMs ?? 50,
  });
  let control: ReturnType<typeof createKernelRepositoryControl>;
  const deps = repositoryDeps(overrides);
  control = createKernelRepositoryControl({
    ...deps,
    callFeature: async (payload: any) => {
      const authority = control.authorize(payload);
      const signal = new AbortController().signal;
      const deadlineAt = Date.now() + 120_000;
      return host.dispatch(payload, {
        signal, deadlineAt, authority,
        kernelCall: (operation: string, value: unknown) => control.handleKernelCall(
          operation, value, { capability: 'feature.dispatch', authority, signal, deadlineAt },
        ),
      });
    },
  });
  return { control, ...deps };
};

describe('repository controller cutover', () => {
  test('preserves the status result shape', async () => {
    const lane = repositoryLane();
    expect(await lane.control.routes['apps/repository/status']({ appId: 'app-1' }))
      .toEqual({ ok: true, status: { branch: 'main' }, remote: null, branches: ['main'] });
  });

  test('rejects same-route effect substitution', async () => {
    const lane = repositoryLane({ loader: async () => ({ routes: {
      'apps/repository/commit': async (_message: any, context: any) =>
        context.effects.call('repository.commit', {
          appId: 'app-2', message: 'checkpoint',
        }),
    } }) });
    expect(await lane.control.routes['apps/repository/commit']({
      appId: 'app-1', message: 'checkpoint',
    })).toMatchObject({ ok: false, code: 'repository-effect-substitution', outcomeKnown: true });
  });

  test('keeps an unknown mutation unknown and does not replay it', async () => {
    let commits = 0;
    const lane = repositoryLane({ repositories: {
      commitApp: async () => {
        commits += 1;
        throw Object.assign(new Error('transport lost'), { outcomeKnown: false });
      },
    } });
    expect(await lane.control.routes['apps/repository/commit']({ appId: 'app-1' }))
      .toMatchObject({ ok: false, outcomeKnown: false });
    expect(commits).toBe(1);
  });

  test('does not roll back a provisional import after clone outcome loss', async () => {
    const lane = repositoryLane({ repositories: {
      clone: async () => { throw Object.assign(new Error('lost'), { outcomeKnown: false }); },
    } });
    expect(await lane.control.routes['apps/import-git']({
      name: 'Imported', url: 'https://example.test/a.git',
    })).toMatchObject({ ok: false, outcomeKnown: false });
    expect(lane.calls).toEqual([]);
    expect(lane.records.has('import-1')).toBe(true);
  });

  test('bounds a repository module hang before any effect', async () => {
    const lane = repositoryLane({ loader: () => new Promise(() => {}), loadTimeoutMs: 5 });
    expect(await lane.control.routes['apps/repository/status']({ appId: 'app-1' }))
      .toMatchObject({
        ok: false, code: 'feature-repository-load-timeout', outcomeKnown: true,
      });
  });

  test('releases a late App quiesce acquisition after timeout', async () => {
    let resolveAcquire!: (value: any) => void;
    const actions: string[] = [];
    const acquisition = new Promise((resolve) => { resolveAcquire = resolve; });
    const lane = repositoryLane({
      quiesceTimeoutMs: 5,
      browser: { tabs: {
        query: async () => [{ id: 7 }],
        sendMessage: async (_id: number, message: any) => {
          actions.push(message.action);
          return message.action === 'acquire' ? acquisition : { ok: true };
        },
        remove: async () => {}, create: async () => {}, reload: async () => {},
      } },
    });
    expect(await lane.control.routes['apps/repository/commit']({ appId: 'app-1' }))
      .toMatchObject({ ok: false, outcomeKnown: true });
    resolveAcquire({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actions).toEqual(['acquire', 'release']);
  });
});

describe('local controller cutover', () => {
  const lane = (overrides: Record<string, any> = {}) => {
    const host = createKernelFeatureHost({
      loaders: { local: overrides.loader
        ?? (() => import('../../extension/offscreen/kernel-local-host.js')) },
      loadTimeoutMs: overrides.loadTimeoutMs ?? 50,
    });
    let control: ReturnType<typeof createKernelLocalControl>;
    control = createKernelLocalControl({
      callFeature: async (payload: any) => {
        const authority = control.authorize(payload);
        const signal = new AbortController().signal;
        const deadlineAt = Date.now() + 60_000;
        return host.dispatch(payload, {
          signal, deadlineAt, authority,
          kernelCall: (operation: string, value: unknown) => control.handleKernelCall(
            operation, value, { capability: 'feature.dispatch', authority, signal, deadlineAt },
          ),
        });
      },
      vault: { isLocked: () => false, getSecret: async () => 'secret' },
      settingsStore: { get: () => ({
        providerName: 'anthropic', providerModel: '', openrouterModels: [],
        ollamaHost: 'http://localhost:11434',
      }) },
      sessions: { get: async () => null },
      browser: { storage: { local: { get: async () => ({}) } } },
      auditLog: { append: async () => {} },
      ready: Promise.resolve(),
      featureHost: { runtime: {} },
      offscreenUrl: 'chrome-extension://id/offscreen/offscreen.html',
      localModels: false,
      providerProjection: { observeOllamaStatus: () => {} },
      pushState: () => {},
      fetchFn: async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
      ...overrides.deps,
    });
    return control;
  };

  test('rejects a forged provider effect', async () => {
    const control = lane({
      loader: async () => ({ routes: {
        'provider/test': async (_message: any, context: any) =>
          context.effects.call('local.provider.test', { provider: 'openai' }),
      } }),
    });
    expect(await control.routes['provider/test']({ provider: 'anthropic' }))
      .toMatchObject({ ok: false, code: 'local-effect-substitution', outcomeKnown: true });
  });

  test('preserves model option projection behind exact kernel snapshots', async () => {
    expect(await lane().routes['models/options']({})).toMatchObject({
      ok: true, selected: 'anthropic::claude-sonnet-4-6', sessionProvider: null,
    });
  });

  test('keeps an unconfirmed provider probe unknown', async () => {
    const control = lane({ deps: {
      fetchFn: async () => { throw new Error('transport lost'); },
    } });
    expect(await control.routes['provider/test']({ provider: 'anthropic' }))
      .toMatchObject({ ok: false, outcomeKnown: false });
  });

  test('bounds a local module hang before custody starts', async () => {
    const control = lane({ loader: () => new Promise(() => {}), loadTimeoutMs: 5 });
    expect(await control.routes['models/options']({}))
      .toMatchObject({ ok: false, code: 'feature-local-load-timeout', outcomeKnown: true });
  });
});

describe('repository/local production composition', () => {
  const graph = async (entry: string) => new Set(
    [...await collectStaticModuleGraph(EXTENSION_DIR, join(EXTENSION_DIR, entry))]
      .map((file) => relative(EXTENSION_DIR, file).split('\\').join('/')),
  );
  const bytes = (modules: Set<string>) => [...modules].reduce(
    (sum, file) => sum + statSync(join(EXTENSION_DIR, file)).size, 0,
  );

  test('removes the broad route roots and keeps Firefox repository ownership private', async () => {
    const vault = readFileSync(join(EXTENSION_DIR, 'background/vault-kernel.js'), 'utf8');
    expect(vault).not.toContain("import('./kernel-local-routes.js')");
    expect(vault).not.toContain("import('./kernel-repository-read-routes.js')");
    const runtime = await graph('background/kernel-semantic-runtime.js');
    expect(runtime.has('background/kernel-local-routes.js')).toBe(false);
    expect(runtime.has('background/kernel-repository-read-routes.js')).toBe(false);
    const firefox = await graph('background/kernel-firefox-addon.js');
    expect(firefox.has('background/repository-local-client.js')).toBe(true);
    expect(readFileSync(join(EXTENSION_DIR, 'background/kernel-firefox-addon.js'), 'utf8'))
      .toContain("from './repository-local-client.js'");
    const chrome = await graph('background/vault-kernel.js');
    expect(chrome.has('background/repository-local-client.js')).toBe(false);
  });

  test('keeps the new authored custody and host graphs bounded', async () => {
    expect(bytes(await graph('background/kernel-repository-control.js'))).toBeLessThan(160_000);
    expect(bytes(await graph('background/kernel-local-control.js'))).toBeLessThan(180_000);
    expect(bytes(await graph('offscreen/kernel-repository-host.js'))).toBeLessThan(80_000);
    expect(bytes(await graph('offscreen/kernel-local-host.js'))).toBeLessThan(100_000);
  });
});
