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
    getRemote: async () => ({ host: 'example.test', url: 'https://example.test/a.git' }),
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

  test('binds fetch and push to the remote observed inside repository custody', async () => {
    const options: any[] = [];
    const lane = repositoryLane({ repositories: {
      fetch: async (_ref: any, value: any) => {
        options.push(value); return { remote: { host: 'example.test' } };
      },
      push: async (_ref: any, value: any) => {
        options.push(value);
        return { ok: true, remote: { host: 'example.test' }, branch: 'main' };
      },
    } });
    await expect(lane.control.routes['apps/repository/fetch']({ appId: 'app-1' }))
      .resolves.toMatchObject({ ok: true });
    await expect(lane.control.routes['apps/repository/push']({
      appId: 'app-1', branch: 'main',
    })).resolves.toMatchObject({ ok: true });
    expect(options).toHaveLength(2);
    expect(options[0].expectedRemote).toBe('https://example.test/a.git');
    expect(options[1]).toMatchObject({
      ref: 'main', expectedRemote: 'https://example.test/a.git',
    });
  });

  test('does not roll back a provisional import after clone outcome loss', async () => {
    const lane = repositoryLane({ repositories: {
      clone: async () => { throw Object.assign(new Error('lost'), { outcomeKnown: false }); },
    } });
    expect(await lane.control.routes['apps/import-git']({
      name: 'Imported', url: 'https://example.test/a.git',
    })).toMatchObject({
      ok: false, code: 'repository-import-outcome-unknown', outcomeKnown: false,
    });
    expect(lane.calls).toEqual([]);
    expect(lane.records.has('import-1')).toBe(true);
  });

  test('reports the exact failed import rollback custodian', async () => {
    const repository = repositoryLane({ repositories: {
      clone: async () => { throw new Error('known failure'); },
      destroy: async () => { throw undefined; },
    } });
    expect(await repository.control.routes['apps/import-git']({
      url: 'https://example.test/a.git',
    })).toMatchObject({
      code: 'repository-import-repository-rollback-unknown', outcomeKnown: false,
    });

    const catalog = repositoryLane({
      repositories: { clone: async () => { throw new Error('known failure'); } },
      catalog: { ...repositoryDeps().catalog, remove: async () => { throw undefined; } },
    });
    expect(await catalog.control.routes['apps/import-git']({
      url: 'https://example.test/a.git',
    })).toMatchObject({
      code: 'repository-import-catalog-rollback-unknown', outcomeKnown: false,
    });
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
      callFeature: async (payload: any, options: any = {}) => {
        const authority = control.authorize(payload);
        const signal = options.signal ?? new AbortController().signal;
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
      providerProjection: {
        observeOllamaStatus: () => {},
        authoritySnapshot: async () => ({
          settings: {
            providerName: 'anthropic', providerModel: '', openrouterModels: [],
          },
          session: null,
          locked: false,
          usable: ['anthropic'],
          localModels: false,
          downloaded: [],
          configRevision: 0,
          ollamaStatus: null,
        }),
      },
      providerEgress: {
        openInference: async () => ({
          ok: false, code: 'model-egress-credential-unavailable', outcomeKnown: true,
        }),
        readInferenceChunk: async () => ({
          ok: true, outcomeKnown: true, value: { done: true },
        }),
        cancelInference: async () => ({ ok: true, outcomeKnown: true, value: null }),
      },
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
      .toMatchObject({ ok: false, code: 'feature-effect-denied', outcomeKnown: true });
  });

  test('preserves model option projection behind exact kernel snapshots', async () => {
    expect(await lane().routes['models/options']({})).toMatchObject({
      ok: true, selected: 'anthropic::claude-sonnet-4-6', sessionProvider: null,
    });
  });

  test('unchosen display hydrates Ollama through the actual finite host protocol without writing settings', async () => {
    const requests: unknown[] = [];
    const observations: unknown[] = [];
    const updates: unknown[] = [];
    const control = lane({ deps: {
      settingsStore: {
        get: () => ({ providerName: '', providerModel: '', ollamaHost: 'http://localhost:11434' }),
        update: async (patch: unknown) => { updates.push(patch); },
      },
      providerProjection: { observeOllamaStatus: (status: unknown) => { observations.push(status); } },
      providerEgress: { readModelInventory: async (request: unknown) => {
        requests.push(request);
        return { ok: true, outcomeKnown: true, value: {
          status: 200, body: new TextEncoder().encode(JSON.stringify({ models: [{ name: 'installed:latest' }] })),
        } };
      } },
    } });
    expect(await control.routes['models/state-projection']({
      settings: { providerName: '', providerModel: '' }, usable: ['ollama'], locked: false,
      localModels: false, downloaded: [], ollamaStatus: null,
    })).toMatchObject({
      providers: { current: 'ollama', model: 'installed:latest' },
      composer: { canSend: true },
    });
    expect(requests).toEqual([{ providerId: 'ollama' }]);
    expect(observations).toEqual([{ known: true, reachable: true, count: 1, models: ['installed:latest'] }]);
    expect(updates).toEqual([]);
  });

  test('keeps an unconfirmed provider probe unknown', async () => {
    const control = lane({ deps: {
      providerEgress: {
        openInference: async () => {
          throw Object.assign(new Error('transport lost'), { outcomeKnown: false });
        },
        readInferenceChunk: async () => ({
          ok: true, outcomeKnown: true, value: { done: true },
        }),
        cancelInference: async () => ({ ok: true, outcomeKnown: true, value: null }),
      },
    } });
    expect(await control.routes['provider/test']({ provider: 'anthropic' }))
      .toMatchObject({ ok: false, outcomeKnown: false });
  });

  const daemonLane = (overrides: Record<string, any> = {}) => {
    let settings = { providerName: '', providerModel: '', ollamaHost: 'http://localhost:11434' };
    let locked = false;
    let credentialEpoch = 0;
    const observations: unknown[] = [];
    const updates: unknown[] = [];
    const audits: unknown[] = [];
    let pushed = 0;
    let revisions = 0;
    const control = lane({ loader: overrides.loader, deps: {
      vault: {
        isLocked: () => locked, getSecret: overrides.getSecret ?? (async () => null),
        captureRequestAuthority: () => {
          const epoch = credentialEpoch;
          return () => !locked && epoch === credentialEpoch;
        },
      },
      settingsStore: {
        get: () => ({ ...settings }),
        update: async (patch: any) => { updates.push(patch); settings = { ...settings, ...patch }; },
      },
      providerProjection: {
        observeOllamaStatus: (status: unknown) => { observations.push(status); },
        bumpRevision: () => { revisions += 1; },
      },
      providerEgress: { readModelInventory: async (_request: any, context: any) => {
        await overrides.beforeReply?.(context);
        return { ok: true, outcomeKnown: true, value: {
          status: overrides.status ?? 200,
          body: new TextEncoder().encode(JSON.stringify({
            models: overrides.models ?? [{ name: 'gemma:latest' }],
          })),
        } };
      } },
      auditLog: { append: async (entry: unknown) => { audits.push(entry); } },
      pushState: async () => { pushed += 1; },
    } });
    return {
      control, updates, audits, observations,
      setSettings: (patch: Partial<typeof settings>) => { settings = { ...settings, ...patch }; },
      lock: () => { locked = true; credentialEpoch += 1; },
      unlock: () => { locked = false; },
      replaceKey: () => { credentialEpoch += 1; },
      pushed: () => pushed,
      revisions: () => revisions,
    };
  };

  test.each(['host', 'lock-unlock', 'key'] as const)(
    'an inventory reply cannot populate readiness after a %s authority change', async (change) => {
      const entered = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<void>();
      const h = daemonLane({ beforeReply: async () => { entered.resolve(); await reply.promise; } });
      const result = h.control.routes['provider/test']({ provider: 'ollama', activate: false });
      await entered.promise;
      if (change === 'host') h.setSettings({ ollamaHost: 'http://localhost:11435' });
      if (change === 'lock-unlock') { h.lock(); h.unlock(); }
      if (change === 'key') h.replaceKey();
      reply.resolve();
      expect(await result).toMatchObject({ ok: false, code: 'local-ollama-authority-changed', outcomeKnown: true });
      expect(h.observations).toEqual([]);
      expect(h.updates).toEqual([]);
    },
  );

  test.each(['host', 'lock-unlock', 'key'] as const)('inventory %s authority is rechecked at the later observation boundary', async (change) => {
    const entered = Promise.withResolvers<void>();
    const observe = Promise.withResolvers<void>();
    const h = daemonLane({ loader: async () => ({ routes: {
      'provider/test': async (_message: unknown, context: any) => {
        await context.effects.call('local.models.ollama', {});
        entered.resolve();
        await observe.promise;
        return context.effects.call('local.models.observe-ollama', {
          known: true, reachable: true, count: 1, models: ['old-host:latest'],
        });
      },
    } }) });
    const result = h.control.routes['provider/test']({ provider: 'ollama', activate: false });
    await entered.promise;
    if (change === 'host') h.setSettings({ ollamaHost: 'http://localhost:11435' });
    if (change === 'lock-unlock') { h.lock(); h.unlock(); }
    if (change === 'key') h.replaceKey();
    observe.resolve();
    expect(await result).toMatchObject({ ok: false, code: 'local-ollama-authority-changed' });
    expect(h.observations).toEqual([]);
  });

  test('a controller cannot publish an inventory observation without its matching host read', async () => {
    const h = daemonLane({ loader: async () => ({ routes: {
      'provider/test': async (_message: unknown, context: any) =>
        context.effects.call('local.models.observe-ollama', {
          known: true, reachable: true, count: 1, models: ['forged:latest'],
        }),
    } }) });
    expect(await h.control.routes['provider/test']({ provider: 'ollama', activate: false }))
      .toMatchObject({ ok: false, code: 'local-ollama-authority-changed' });
    expect(h.observations).toEqual([]);
  });

  test.each(['', 'anthropic'])('a tested usable daemon activates over an unusable %s selection', async (providerName) => {
    const h = daemonLane();
    h.setSettings({ providerName, providerModel: 'old-model' });
    expect(await h.control.routes['provider/test']({ provider: 'ollama' }))
      .toEqual({ ok: true, reachable: true, models: 1 });
    expect(h.updates).toEqual([{ providerName: 'ollama', providerModel: '' }]);
    expect(h.audits).toEqual([{ type: 'provider_validated', details: { provider: 'ollama' } }]);
    expect(h.pushed()).toBe(1);
    expect(h.revisions()).toBe(1);
  });

  test.each([
    { providerName: 'anthropic', key: 'existing-key', activate: true },
    { providerName: 'local-webgpu', key: null, activate: true },
    { providerName: 'ollama', key: null, activate: true },
    { providerName: '', key: null, activate: false },
  ])('daemon activation preserves $providerName with activate=$activate', async ({ providerName, key, activate }) => {
    const h = daemonLane({ getSecret: async () => key });
    h.setSettings({ providerName, providerModel: 'explicit-model' });
    expect(await h.control.routes['provider/test']({ provider: 'ollama', activate }))
      .toMatchObject({ ok: true, models: 1 });
    expect(h.updates).toEqual([]);
  });

  test.each([
    { models: [], status: 200, error: 'no-models' },
    { models: [{ name: 'gemma:latest' }], status: 503, error: 'unreachable' },
  ])('daemon activation refuses $error inventory', async ({ models, status, error }) => {
    const h = daemonLane({ models, status });
    expect(await h.control.routes['provider/test']({ provider: 'ollama' }))
      .toMatchObject({ ok: false, error });
    expect(h.updates).toEqual([]);
  });

  test.each(['selection', 'host', 'locked', 'aborted'] as const)(
    'daemon activation ignores a %s change during the live probe', async (change) => {
      const entered = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<void>();
      const h = daemonLane({ beforeReply: async () => { entered.resolve(); await reply.promise; } });
      const result = h.control.routes['provider/test']({ provider: 'ollama' });
      await entered.promise;
      if (change === 'selection') h.setSettings({ providerName: 'local-webgpu' });
      if (change === 'host') h.setSettings({ ollamaHost: 'http://localhost:11435' });
      if (change === 'locked') h.lock();
      if (change === 'aborted') h.control.abort();
      reply.resolve();
      const value = await result;
      if (change === 'aborted') expect(value).toMatchObject({ ok: false, code: 'provider-test-aborted' });
      expect(h.updates).toEqual([]);
    },
  );

  test('abort after the daemon reply but during credential lookup still refuses activation', async () => {
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<null>();
    const h = daemonLane({ getSecret: () => { entered.resolve(); return reply.promise; } });
    h.setSettings({ providerName: 'anthropic' });
    const result = h.control.routes['provider/test']({ provider: 'ollama' });
    await entered.promise;
    h.control.abort();
    reply.resolve(null);
    expect(await result).toMatchObject({ ok: false, code: 'provider-test-aborted' });
    expect(h.updates).toEqual([]);
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
    expect(firefox.has('background/repository-local-client.js')).toBe(false);
    expect(readFileSync(join(EXTENSION_DIR, 'background/kernel-firefox-addon.js'), 'utf8'))
      .toContain("import('./repository-local-client.js')");
    const chrome = await graph('background/vault-kernel.js');
    expect(chrome.has('background/repository-local-client.js')).toBe(false);
  });

  test('keeps the new authored custody and host graphs bounded', async () => {
    expect(bytes(await graph('background/kernel-repository-control.js'))).toBeLessThan(160_000);
    expect(bytes(await graph('background/kernel-local-control.js'))).toBeLessThan(180_000);
    expect(bytes(await graph('offscreen/kernel-repository-host.js'))).toBeLessThan(80_000);
    const localHost = await graph('offscreen/kernel-local-host.js');
    const localAuthority = await graph('background/kernel-local-control.js');
    expect(localHost.has('peerd-provider/controller.js')).toBe(true);
    expect(localAuthority.has('peerd-provider/controller.js')).toBe(false);
    expect([...localAuthority].some((module) => module.includes('peerd-provider/adapters/')))
      .toBe(false);
  });
});
