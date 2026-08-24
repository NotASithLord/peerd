import { describe, test, expect } from 'bun:test';
import { makeEngineRoutes } from '../../extension/background/routes/engine.js';
import { createAppQuiescence } from '../../extension/background/app-quiescence.js';
import { listOffscreenContexts } from '../../extension/background/offscreen-contexts.js';
import { requireDenylistPolicy } from '../../extension/background/denylist-store.js';
import { parseAppManifest } from '../../extension/peerd-engine/app-manifest.js';
import { podGitRemoteOperation } from '../../extension/peerd-engine/pod-shell.js';

class ArtifactTooLargeError extends Error {}
class EnvelopeFormatError extends Error {}
class EnvelopeIntegrityError extends Error {}

const baseDeps = (over: any = {}) => ({
  vault: { isLocked: () => false },
  auditLog: { append: async () => {} },
  pushState: () => {},
  browser: {
    runtime: {
      getContexts: async () => [], sendMessage: async () => ({ ok: true }),
      getURL: (path: string) => `moz-extension://peerd/${path}`,
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  },
  // #53: engine's sw/web-fetch now delegates to the vm-net vmHttpFetch factory
  // (cache + host-bound git-auth + body cap + base64 — those are covered by
  // tests/peerd-engine/vm-net/vm-http-fetch.test.ts). engine.js only validates
  // the url and wraps EgressDeniedError, so the route's own tests inject vmHttpFetch.
  vmHttpFetch: async () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, bodyB64: btoa('hello') }),
  appRegistry: {
    get: async (id: string) => (id === 'a1' ? { id, name: 'App', entryFile: 'index.html' } : null),
    update: async (id: string, patch: any) => (id === 'a1' ? { id, ...patch } : null),
    list: async () => [{ id: 'a1' }],
  },
  vmRegistry: { get: async (id: string) => (id === 'v1' ? { id, name: 'VM' } : null), create: async () => ({ id: 'vNew' }) },
  jsRegistry: { get: async () => null, create: async () => ({ id: 'nNew' }) },
  podRegistry: { get: async (id: string) => (id === 'pod-1' ? { id, name: 'Pod' } : null) },
  podTabTracker: { getTabId: (id: string) => (id === 'pod-1' ? 99 : null) },
  appClient: {
    open: async () => {},
    create: async () => ({ id: 'imported' }),
    readFile: async () => JSON.stringify({
      schema: 1, kind: 'app', entry: 'index.html',
      agent: { kind: 'bound-app' }, capabilities: [],
    }),
    listFiles: async () => [{ path: '/index.html' }, { path: '/peerd.json' }],
    snapshotFiles: async () => ({
      record: { id: 'a1', name: 'App', entryFile: 'index.html', fileKinds: { 'index.html': 'text' } },
      files: { 'index.html': new TextEncoder().encode('<h1>x</h1>') },
    }),
  },
  appTabTracker: {
    reloadTab: async () => {}, getTabId: () => null,
    parseIdFromUrl: () => null,
    quiesceTab: async () => true, resumeTab: async () => true,
    closeTab: async () => {}, ensureTab: async () => {},
  },
  appQuiescence: { run: async (_appId: string, operation: () => Promise<any>) => operation() },
  opfsHelpers: () => ({ list: async () => [], read: async () => '', readBytes: async () => new Uint8Array(), write: async () => {} }),
  NOTEBOOK_OPFS_ROOT: 'peerd-notebooks',
  IMAGE_PIN_STORAGE_KEY: 'vm.imagePins',
  artifactEngine: {
    buildAppExport: async () => ({ env: 'app' }),
    buildNotebookExport: async () => ({ env: 'nb' }),
    buildVmRecipeExport: async () => ({ env: 'vm' }),
    openEnvelope: async () => ({ kind: 'app', name: 'X', entry: 'i.html', files: {}, meta: { tags: [] } }),
    inspectEnvelope: async () => ({ ok: true, summary: 'x' }),
    exportFilename: (name: string, kind: string) => `${name}.${kind}.peerd`,
  },
  ArtifactTooLargeError, EnvelopeFormatError, EnvelopeIntegrityError,
  settingsStore: { get: () => ({ dwebEnabled: false }) },
  DWEB_ENABLED: false,
  withDwebPublication: async (operation: (isCurrent: () => boolean) => Promise<any>) => operation(() => true),
  withAppLifecycle: async (_appId: string, operation: () => Promise<any>) => operation(),
  listOffscreenContexts,
  isOffscreenSender: (sender: any) => sender?.url === 'moz-extension://peerd/offscreen/offscreen.html',
  assertOpfsWritable: async () => {},
  // The SW always injects the extract post-step (a passthrough when extract is
  // absent — that contract is pinned in tests/shared/fetch-extract.test.ts).
  applyWebExtract: async (resp: any) => resp,
  awaitDenylistPolicy: async () => {},
  parseAppManifest,
  podGitRemoteOperation,
  repositories: {
    init: async () => 'abc123456789',
    status: async () => ({ oid: 'abc', branch: 'main', dirty: false, changed: [] }),
    stage: async () => ({ staged: [] }),
    commit: async () => ({ oid: 'abc', changed: [], created: false }),
    history: async () => [],
    branches: async () => ['main'],
    branch: async (_ref: any, opts: any) => ({ branch: opts.name }),
    checkout: async (_ref: any, opts: any) => ({ branch: opts.name, oid: 'abc' }),
    clone: async (_ref: any, opts: any) => ({ remote: { url: opts.url } }),
    fetch: async () => ({ remote: { url: 'https://github.com/a/b.git' } }),
    push: async () => ({ ok: true, branch: 'main', remote: { url: 'https://github.com/a/b.git' } }),
    setRemote: async (_ref: any, opts: any) => ({ url: opts.url }),
    getRemote: async () => null,
    statusApp: async () => ({ oid: 'abc', branch: 'main', dirty: false, changed: [] }),
    getAppRemote: async () => null,
    historyApp: async () => [],
    diffApp: async () => ({ files: [], patch: '', truncated: false }),
    commitApp: async () => ({ oid: 'abc', changed: [], created: false }),
    restoreApp: async (_id: string, opts: any) => ({ oid: opts.to, restored: true }),
    coordinate: async (_ref: any, operation: any) => operation(),
    destroy: async () => {},
  },
  ...over,
});

describe('pod/git: instance-pinned isomorphic-git shell bridge', () => {
  const sender = { tab: { id: 99 } };

  test('refuses a first-party page that is not the Pod\'s owning tab', async () => {
    const routes = makeEngineRoutes(baseDeps());
    expect(await routes['pod/git'](
      { podId: 'pod-1', argv: ['status'] },
      { tab: { id: 12 } },
    )).toEqual({ ok: false, error: 'pod-sender-not-instance-pinned' });
  });

  test('maps local shell Git to the exact Pod repository', async () => {
    let seen: any = null;
    const deps = baseDeps();
    deps.repositories.status = async (ref: any) => {
      seen = ref;
      return { branch: 'main', changed: [{ status: 'modified', path: 'a.txt' }] };
    };
    const reply = await makeEngineRoutes(deps)['pod/git'](
      { podId: 'pod-1', argv: ['status'] }, sender,
    );
    expect(seen).toEqual({ kind: 'pod', id: 'pod-1' });
    expect(reply).toMatchObject({ ok: true, result: { exitCode: 0 } });
    expect(reply.result.stdout).toContain('modified a.txt');
  });

  test('remote operations fail closed without an exact one-job grant', async () => {
    let pushed = false;
    const deps = baseDeps();
    deps.repositories.getRemote = async () => ({ url: 'https://github.com/a/b.git' });
    deps.repositories.push = async () => { pushed = true; return { ok: true }; };
    const routes = makeEngineRoutes(deps);
    const missing = await routes['pod/git'](
      { podId: 'pod-1', argv: ['push', 'origin', 'main'] }, sender,
    );
    const mismatched = await routes['pod/git']({
      podId: 'pod-1', argv: ['push', 'origin', 'main'],
      remoteGrant: { op: 'fetch', url: 'https://github.com/a/b.git' },
    }, sender);
    const wrongTarget = await routes['pod/git']({
      podId: 'pod-1', argv: ['push', 'origin', 'main'],
      remoteGrant: { op: 'push', url: 'https://evil.example/x.git' },
    }, sender);
    for (const reply of [missing, mismatched, wrongTarget]) {
      expect(reply.result.exitCode).toBe(126);
      expect(reply.result.stderr).toContain('explicit authorization');
    }
    expect(pushed).toBe(false);
  });

  test('an exact grant reaches the brokered transport with a cancellation signal', async () => {
    let pushedRef: any = null;
    const deps = baseDeps();
    deps.repositories.getRemote = async () => ({ url: 'https://github.com/a/b.git' });
    deps.repositories.push = async (ref: any, opts: any) => {
      pushedRef = { ref, opts };
      return { ok: true, branch: 'main', remote: { url: 'https://github.com/a/b.git' } };
    };
    const reply = await makeEngineRoutes(deps)['pod/git']({
      podId: 'pod-1', jobId: 'job-authorized', argv: ['push', 'origin', 'main'],
      remoteGrant: { op: 'push', url: 'https://github.com/a/b.git' },
    }, sender);
    expect(reply.result.exitCode).toBe(0);
    expect(pushedRef.ref).toEqual({ kind: 'pod', id: 'pod-1' });
    expect(pushedRef.opts.ref).toBe('main');
    expect(pushedRef.opts.signal).toBeInstanceOf(AbortSignal);
  });

  test('an indeterminate remote result is never presented as a safe retry', async () => {
    const deps = baseDeps();
    deps.repositories.getRemote = async () => ({ url: 'https://github.com/a/b.git' });
    deps.repositories.push = async () => {
      throw Object.assign(new Error('transport closed'), {
        code: 'repository-outcome-unknown', outcomeKnown: false,
      });
    };
    const reply = await makeEngineRoutes(deps)['pod/git']({
      podId: 'pod-1', jobId: 'job-unknown', argv: ['push', 'origin', 'main'],
      remoteGrant: { op: 'push', url: 'https://github.com/a/b.git' },
    }, sender);
    expect(reply).toMatchObject({
      ok: false, code: 'repository-outcome-unknown', outcomeKnown: false,
      outcomeKind: 'unknown', retryable: false,
    });
  });

  test('validates the granted target and pushes under one repository coordinator', async () => {
    let coordinated = false;
    const order: string[] = [];
    const deps = baseDeps();
    deps.repositories.coordinate = async (ref: any, operation: any) => {
      expect(ref).toEqual({ kind: 'pod', id: 'pod-1' });
      coordinated = true;
      order.push('lock');
      try { return await operation(); }
      finally { coordinated = false; order.push('unlock'); }
    };
    deps.repositories.getRemote = async () => {
      expect(coordinated).toBe(true);
      order.push('remote');
      return { url: 'https://github.com/a/b.git' };
    };
    deps.repositories.push = async () => {
      expect(coordinated).toBe(true);
      order.push('push');
      return { ok: true, branch: 'main', remote: { url: 'https://github.com/a/b.git' } };
    };
    const reply = await makeEngineRoutes(deps)['pod/git']({
      podId: 'pod-1', jobId: 'job-coordinated', argv: ['push', 'origin', 'main'],
      remoteGrant: { op: 'push', url: 'https://github.com/a/b.git' },
    }, sender);
    expect(reply.result.exitCode).toBe(0);
    expect(order).toEqual(['lock', 'remote', 'push', 'unlock']);
  });

  test('job cancellation aborts an in-flight remote Git transport', async () => {
    let seenSignal: AbortSignal | null = null;
    const deps = baseDeps();
    deps.repositories.getRemote = async () => ({ url: 'https://github.com/a/b.git' });
    deps.repositories.push = async (_ref: any, opts: any) => {
      seenSignal = opts.signal;
      await new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('git operation aborted')), { once: true });
      });
    };
    const routes = makeEngineRoutes(deps);
    const running = routes['pod/git']({
      podId: 'pod-1', jobId: 'job-cancel-me', argv: ['push', 'origin', 'main'],
      remoteGrant: { op: 'push', url: 'https://github.com/a/b.git' },
    }, sender);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cancelled = await routes['pod/cancel-io'](
      { podId: 'pod-1', jobId: 'job-cancel-me' }, sender,
    );
    expect(cancelled).toMatchObject({ ok: true, cancelled: 1 });
    expect((seenSignal as AbortSignal | null)?.aborted).toBe(true);
    expect((await running).result.stderr).toContain('aborted');
  });
});

describe('App repository quiescence', () => {
  for (const [routeName, message, repositoryMethod] of [
    ['apps/repository/commit', { appId: 'a1', message: 'save' }, 'commitApp'],
    ['apps/repository/push', { appId: 'a1' }, 'push'],
    ['apps/repository/restore', { appId: 'a1', to: 'old' }, 'restoreApp'],
    ['apps/repository/checkout', { appId: 'a1', name: 'feature' }, 'checkout'],
  ] as const) {
    test(`${routeName} flushes and fences the App before taking its repository lock`, async () => {
      const order: string[] = [];
      const tracker = {
        getTabId: () => 41,
        quiesceTab: async () => { order.push('flush'); return true; },
        resumeTab: async () => { order.push('resume'); return true; },
        closeTab: async () => { order.push('close'); return true; },
        ensureTab: async () => { order.push('reopen'); return 41; },
        reloadTab: async () => true,
      };
      const deps = baseDeps({
        appTabTracker: tracker,
        appQuiescence: createAppQuiescence({
          tracker,
          withLifecycle: async (_appId, operation) => {
            order.push('lifecycle');
            try { return await operation(); }
            finally { order.push('lifecycle-release'); }
          },
          afterClose: async () => {},
        }),
      });
      deps.repositories.coordinate = async (_ref: any, operation: () => Promise<any>) => {
        order.push('lock');
        try { return await operation(); }
        finally { order.push('unlock'); }
      };
      deps.repositories.commitApp = async () => {
        order.push(repositoryMethod === 'commitApp' ? 'operation' : 'checkpoint');
        return { oid: 'new', changed: [], created: true };
      };
      deps.repositories.push = async () => {
        order.push('operation');
        return { ok: true, branch: 'main', remote: { host: 'github.com', url: 'https://github.com/a/b.git' } };
      };
      deps.repositories.restoreApp = async () => { order.push('operation'); return { oid: 'old', restored: true }; };
      deps.repositories.checkout = async () => { order.push('operation'); return { oid: 'new', branch: 'feature' }; };
      const result = await makeEngineRoutes(deps)[routeName](message);
      expect(result.ok).toBe(true);
      const keepsVisible = repositoryMethod === 'commitApp' || repositoryMethod === 'push';
      const operationOrder = repositoryMethod === 'push'
        ? ['lifecycle', 'flush', 'lock', 'checkpoint', 'operation', 'unlock', 'resume', 'lifecycle-release']
        : keepsVisible
          ? ['lifecycle', 'flush', 'lock', 'operation', 'unlock', 'resume', 'lifecycle-release']
          : ['lifecycle', 'flush', 'close', 'lock', 'operation', 'unlock', 'reopen', 'lifecycle-release'];
      expect(order).toEqual(operationOrder);
    });
  }

  test('a failed editor flush prevents close and repository mutation', async () => {
    let closed = false;
    let mutated = false;
    const tracker = {
      getTabId: () => 41,
      quiesceTab: async () => { throw new Error('save failed'); },
      resumeTab: async () => true,
      closeTab: async () => { closed = true; return true; },
      ensureTab: async () => 41,
      reloadTab: async () => true,
    };
    const deps = baseDeps({
      appTabTracker: tracker,
      appQuiescence: createAppQuiescence({
        tracker,
        withLifecycle: async (_appId, operation) => operation(),
        afterClose: async () => {},
      }),
    });
    deps.repositories.commitApp = async () => { mutated = true; return {}; };
    const result = await makeEngineRoutes(deps)['apps/repository/commit']({ appId: 'a1' });
    expect(result).toEqual({
      ok: false, code: 'repository-operation-failed', outcomeKnown: true,
      retryable: true, error: 'Peerd could not save the Git checkpoint. Try again.',
    });
    expect(closed).toBe(false);
    expect(mutated).toBe(false);
  });

  test('lock refuses every Git route before repository IO and rechecks inside mutation custody', async () => {
    let locked = true;
    let calls = 0;
    const deps = baseDeps({ vault: { isLocked: () => locked } });
    for (const name of [
      'statusApp', 'getAppRemote', 'branches', 'historyApp', 'diffApp', 'commitApp',
      'restoreApp', 'branch', 'checkout', 'setRemote', 'fetch', 'push',
    ]) deps.repositories[name] = async () => { calls += 1; return {}; };
    const routes = makeEngineRoutes(deps);
    for (const [type, message] of [
      ['apps/repository/status', { appId: 'a1' }],
      ['apps/repository/history', { appId: 'a1' }],
      ['apps/repository/diff', { appId: 'a1' }],
      ['apps/repository/commit', { appId: 'a1' }],
      ['apps/repository/restore', { appId: 'a1', to: 'old' }],
      ['apps/repository/branch', { appId: 'a1', name: 'next' }],
      ['apps/repository/checkout', { appId: 'a1', name: 'next' }],
      ['apps/repository/link', { appId: 'a1', url: 'https://example.com/a.git' }],
      ['apps/repository/fetch', { appId: 'a1' }],
      ['apps/repository/push', { appId: 'a1' }],
    ] as const) expect(await routes[type](message)).toEqual({ ok: false, error: 'vault-locked' });
    expect(calls).toBe(0);

    locked = false;
    deps.repositories.coordinate = async (_ref: any, operation: () => Promise<any>) => {
      locked = true;
      return operation();
    };
    const raced = await makeEngineRoutes(deps)['apps/repository/commit']({ appId: 'a1' });
    expect(raced).toMatchObject({ ok: false, outcomeKnown: true, retryable: true });
    expect(calls).toBe(0);
  });

  test('post-dispatch unknown Git custody survives the live route for reconcile-only UX', async () => {
    const unknown = Object.assign(new Error('transport lost'), {
      code: 'repository-host-timeout', outcomeKnown: false,
    });
    const deps = baseDeps();
    deps.repositories.commitApp = async () => { throw unknown; };
    expect(await makeEngineRoutes(deps)['apps/repository/commit']({ appId: 'a1' }))
      .toEqual({
        ok: false, code: 'repository-host-timeout', outcomeKnown: false,
        retryable: false,
        error: 'Peerd could not confirm the result of trying to save the Git checkpoint. Refresh Git history to reconcile before trying again.',
      });
  });
});

describe('lifecycle/assert-opfs-writable', () => {
  test('the Firefox Notebook host reaches the authoritative write posture', async () => {
    let checks = 0;
    const routes = makeEngineRoutes(baseDeps({
      assertOpfsWritable: async () => { checks += 1; },
    }));
    const result = await (routes['lifecycle/assert-opfs-writable'] as any)(
      {}, { url: 'moz-extension://peerd/engine-tabs/notebook-tab/index.html#nb-1' });
    expect(result).toEqual({ ok: true });
    expect(checks).toBe(1);
  });

  test('the offscreen host reaches the same posture', async () => {
    let checks = 0;
    const routes = makeEngineRoutes(baseDeps({
      assertOpfsWritable: async () => { checks += 1; },
    }));
    const result = await (routes['lifecycle/assert-opfs-writable'] as any)(
      {}, { url: 'moz-extension://peerd/offscreen/offscreen.html' });
    expect(result).toEqual({ ok: true });
    expect(checks).toBe(1);
  });

  test('blocked posture returns the precise refusal without mutating', async () => {
    const routes = makeEngineRoutes(baseDeps({
      assertOpfsWritable: async () => {
        throw new Error("store 'opfs-workspaces' is read-only. No data was changed. Diagnostic: opfs-v2.");
      },
    }));
    const result = await (routes['lifecycle/assert-opfs-writable'] as any)(
      {}, { url: 'moz-extension://peerd/engine-tabs/notebook-tab/index.html#nb-1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("'opfs-workspaces'");
    expect(result.error).toContain('No data was changed');
    expect(result.error).toContain('opfs-v2');
  });

  test('an unrelated extension page cannot probe the posture', async () => {
    let checks = 0;
    const routes = makeEngineRoutes(baseDeps({
      assertOpfsWritable: async () => { checks += 1; },
    }));
    const result = await (routes['lifecycle/assert-opfs-writable'] as any)(
      {}, { url: 'moz-extension://peerd/sidepanel/sidepanel.html' });
    expect(result).toEqual({ ok: false, error: 'unauthorized OPFS posture request' });
    expect(checks).toBe(0);
  });
});

describe('sw/web-fetch', () => {
  test('denylist hydration is a required route dependency', () => {
    expect(() => makeEngineRoutes(baseDeps({ awaitDenylistPolicy: undefined })))
      .toThrow('awaitDenylistPolicy is required');
  });
  test('rejects empty url', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['sw/web-fetch']({ url: '' })).toEqual({ ok: false, error: 'url-required' });
  });
  test('returns base64 body + status', async () => {
    const r = makeEngineRoutes(baseDeps());
    const res = await r['sw/web-fetch']({ url: 'https://x' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(atob(res.bodyB64)).toBe('hello');
  });
  test('denylisted egress surfaces a clear error', async () => {
    const err: any = new Error('blocked.example'); err.name = 'EgressDeniedError';
    const r = makeEngineRoutes(baseDeps({ vmHttpFetch: async () => { throw err; } }));
    expect(await r['sw/web-fetch']({ url: 'https://blocked.example' })).toEqual({ ok: false, error: 'denylisted: blocked.example' });
  });
  test('passes a vmHttpFetch error result (e.g. over-cap body) straight through', async () => {
    const r = makeEngineRoutes(baseDeps({ vmHttpFetch: async () => ({ ok: false, error: 'body too large: 53477376B > 52428800B' }) }));
    const res = await r['sw/web-fetch']({ url: 'https://x' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('body too large');
  });

  // The denylist seed hydrates async at SW boot. A fetch racing a cold start
  // must WAIT for the one-time load (not refuse), and a genuinely failed load
  // must still refuse before any egress. The injected gate mirrors the SW's
  // composition exactly: requireDenylistPolicy(await denylistReady).
  test('a fetch racing seed hydration waits for the load instead of refusing', async () => {
    const order: string[] = [];
    let releaseHydration: (value: { ok: boolean }) => void = () => {};
    const denylistReady = new Promise<{ ok: boolean }>((resolve) => { releaseHydration = resolve; });
    const r = makeEngineRoutes(baseDeps({
      awaitDenylistPolicy: async () => { requireDenylistPolicy(await denylistReady); },
      vmHttpFetch: async () => { order.push('fetch'); return { ok: true, status: 200, headers: {}, bodyB64: btoa('hello') }; },
    }));
    const pending = r['sw/web-fetch']({ url: 'https://x' });
    await Promise.resolve();
    order.push('hydrated');
    releaseHydration({ ok: true });
    const res = await pending;
    expect(res.ok).toBe(true);
    expect(order).toEqual(['hydrated', 'fetch']);
  });
  test('a failed seed hydration refuses the fetch before any egress', async () => {
    let fetched = false;
    const r = makeEngineRoutes(baseDeps({
      awaitDenylistPolicy: async () => { requireDenylistPolicy(await Promise.resolve({ ok: false })); },
      vmHttpFetch: async () => { fetched = true; return { ok: true }; },
    }));
    expect(await r['sw/web-fetch']({ url: 'https://x' })).toEqual({
      ok: false,
      error: 'The sensitive-origin policy is unavailable. Network access is blocked.',
    });
    expect(fetched).toBe(false);
  });

  // Design 02, 2a: the Notebook tab's code-mode bridge widened this route with
  // an `extract` post-step (the SAME shared/fetch-extract.js step the headless
  // host applies locally). The SW composes it as deps.applyWebExtract; the
  // route only threads { resp, extract, url } through — pinned here.
  test('extract rides to the injected applyWebExtract post-step (Notebook tab relay)', async () => {
    let seen: any = null;
    const r = makeEngineRoutes(baseDeps({
      applyWebExtract: async (resp: any, extract: unknown, url: string) => {
        seen = { extract, url };
        return { ...resp, bodyB64: btoa('# md'), extracted: true };
      },
    }));
    const res = await r['sw/web-fetch']({ url: 'https://site.example/post', extract: 'markdown' });
    expect(seen).toEqual({ extract: 'markdown', url: 'https://site.example/post' });
    expect(res.extracted).toBe(true);
    expect(atob(res.bodyB64)).toBe('# md');
  });

  test('without extract the step sees undefined and the response is untouched — the VM path', async () => {
    let seenExtract: unknown = 'sentinel';
    const withStep = makeEngineRoutes(baseDeps({
      applyWebExtract: async (resp: any, extract: unknown) => {
        // the real step is a no-op passthrough when extract is absent
        seenExtract = extract;
        return resp;
      },
    }));
    const raw = await withStep['sw/web-fetch']({ url: 'https://x' });
    expect(atob(raw.bodyB64)).toBe('hello');
    expect(raw.extracted).toBeUndefined();
    expect(seenExtract).toBeUndefined();
  });

  test('a run-scoped fetch needs exact offscreen provenance and a live owner capability', async () => {
    let fetched = false;
    let admissions = 0;
    const controller = new AbortController();
    const routes = makeEngineRoutes(baseDeps({
      vmHttpFetch: async () => { fetched = true; return { ok: true }; },
      isOffscreenSender: (sender: any) => sender?.url === 'offscreen',
      scriptRuns: {
        ownerFor: () => 'owner-1',
        allows: () => true,
        admitOp: () => { admissions += 1; return true; },
        signalFor: () => controller.signal,
      },
    }));
    const forged = await (routes['sw/web-fetch'] as any)({
      url: 'https://example.com', runId: 'run-1', ownerSessionId: 'owner-1',
    }, { url: 'engine-tab' });
    expect(forged).toEqual({ ok: false, error: 'web_fetch_unknown_finished_foreign_or_over_limit_run' });
    expect(fetched).toBe(false);
    expect(admissions).toBe(0);
  });

  test('Stop aborts an admitted run-scoped fetch through the injected HTTP signal', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const routes = makeEngineRoutes(baseDeps({
      vmHttpFetch: async ({ signal }: any) => {
        seenSignal = signal;
        return await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
      isOffscreenSender: (sender: any) => sender?.url === 'offscreen',
      scriptRuns: {
        ownerFor: () => 'owner-1',
        allows: (_runId: string, cap: string) => cap === 'egress',
        admitOp: () => true,
        signalFor: () => controller.signal,
      },
    }));
    const pending = (routes['sw/web-fetch'] as any)({
      url: 'https://example.com', runId: 'run-1', ownerSessionId: 'owner-1',
      deadlineAt: Date.now() + 10_000,
    }, { url: 'offscreen' });
    for (let attempt = 0; attempt < 10 && !seenSignal; attempt += 1) await Promise.resolve();
    expect(seenSignal).toBeDefined();
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: 'aborted' });
    expect(seenSignal?.aborted).toBe(true);
  });

  test('Stop during unresolved denylist hydration admits then exits without egress', async () => {
    const controller = new AbortController();
    let hydrationStarted = false;
    let fetched = false;
    let admissions = 0;
    const routes = makeEngineRoutes(baseDeps({
      awaitDenylistPolicy: () => {
        hydrationStarted = true;
        return new Promise(() => {});
      },
      vmHttpFetch: async () => { fetched = true; return { ok: true }; },
      isOffscreenSender: (sender: any) => sender?.url === 'offscreen',
      scriptRuns: {
        ownerFor: () => 'owner-1', allows: () => true,
        admitOp: () => { admissions += 1; return true; },
        signalFor: () => controller.signal,
      },
    }));
    const pending = (routes['sw/web-fetch'] as any)({
      url: 'https://example.com', runId: 'run-1', ownerSessionId: 'owner-1',
      deadlineAt: Date.now() + 10_000,
    }, { url: 'offscreen' });
    await Promise.resolve();
    expect(hydrationStarted).toBe(true);
    expect(admissions).toBe(1);
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: 'aborted' });
    expect(fetched).toBe(false);
  });

  test('deadline during unresolved denylist hydration exits without egress', async () => {
    let fetched = false;
    const routes = makeEngineRoutes(baseDeps({
      awaitDenylistPolicy: () => new Promise(() => {}),
      vmHttpFetch: async () => { fetched = true; return { ok: true }; },
      isOffscreenSender: (sender: any) => sender?.url === 'offscreen',
      scriptRuns: {
        ownerFor: () => 'owner-1', allows: () => true, admitOp: () => true,
        signalFor: () => new AbortController().signal,
      },
    }));
    const result = await (routes['sw/web-fetch'] as any)({
      url: 'https://example.com', runId: 'run-1', ownerSessionId: 'owner-1',
      deadlineAt: Date.now() + 10,
    }, { url: 'offscreen' });
    expect(result).toEqual({ ok: false, error: 'aborted' });
    expect(fetched).toBe(false);
  });

  test('a Notebook can cancel only its own token-bound module fetch', async () => {
    let seenSignal: AbortSignal | undefined;
    const notebookUrl = 'moz-extension://test/engine-tabs/notebook-tab/index.html#n1';
    const routes = makeEngineRoutes(baseDeps({
      browser: {
        runtime: {
          getURL: (path: string) => `moz-extension://test/${path}`,
          getContexts: async () => [], sendMessage: async () => ({ ok: true }),
        },
        storage: { local: { get: async () => ({}), set: async () => {} } },
      },
      vmHttpFetch: async ({ signal }: any) => {
        seenSignal = signal;
        return await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    }));
    const sender = { tab: { id: 41, url: notebookUrl }, url: notebookUrl };
    const pending = (routes['sw/web-fetch'] as any)({
      url: 'https://modules.example/a.js', noCache: true,
      abortToken: 'token-1', notebookId: 'n1',
    }, sender);
    for (let attempt = 0; attempt < 10 && !seenSignal; attempt += 1) await Promise.resolve();
    expect(seenSignal).toBeDefined();
    expect(await (routes['sw/web-fetch-abort'] as any)(
      { abortToken: 'token-1', notebookId: 'n2' }, {
        tab: { id: 99, url: 'moz-extension://test/engine-tabs/notebook-tab/index.html#n2' },
        url: 'moz-extension://test/engine-tabs/notebook-tab/index.html#n2',
      },
    )).toEqual({ ok: true, aborted: false });
    expect(await (routes['sw/web-fetch-abort'] as any)(
      { abortToken: 'token-1', notebookId: 'n1' }, sender,
    )).toEqual({ ok: true, aborted: true });
    expect(await pending).toEqual({ ok: false, error: 'aborted' });
    expect(seenSignal?.aborted).toBe(true);

    const deadlinePending = (routes['sw/web-fetch'] as any)({
      url: 'https://modules.example/slow.js', noCache: true,
      abortToken: 'token-2', notebookId: 'n1', deadlineAt: Date.now() + 10,
    }, sender);
    expect(await deadlinePending).toEqual({ ok: false, error: 'aborted' });
    expect(seenSignal?.aborted).toBe(true);
    expect(await (routes['sw/web-fetch-abort'] as any)(
      { abortToken: 'token-2', notebookId: 'n1' }, sender,
    )).toEqual({ ok: true, aborted: false });
  });
});

describe('app/vm meta + apps Library', () => {
  test('app/get-meta unknown → app-not-found', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['app/get-meta']({ appId: 'zzz' })).toEqual({ ok: false, error: 'app-not-found' });
  });
  test('app/get-meta returns name, entry, file kinds, and dweb metadata', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['app/get-meta']({ appId: 'a1' })).toEqual({
      ok: true,
      name: 'App',
      entryFile: 'index.html',
      fileKinds: {},
      dweb: null,
      agent: { kind: 'bound-app', profile: 'developer', surface: 'code' },
    });
  });

  test('app/get-meta returns the manifest-defined bound actor contract', async () => {
    const r = makeEngineRoutes(baseDeps({
      appClient: {
        readFile: async () => JSON.stringify({
          schema: 1,
          kind: 'app',
          entry: 'index.html',
          agent: {
            kind: 'bound-app',
            name: 'Game developer',
            instructions: 'Playtest before and after edits.',
            profile: 'developer',
            surface: 'code',
            runtime: ['observe', 'act'],
          },
          capabilities: [],
        }),
        listFiles: async () => [{ path: '/index.html' }, { path: '/peerd.json' }],
      },
    }));
    expect((await r['app/get-meta']({ appId: 'a1' })).agent).toEqual({
      kind: 'bound-app',
      profile: 'developer',
      surface: 'code',
      name: 'Game developer',
      instructions: 'Playtest before and after edits.',
      runtime: ['observe', 'act'],
    });
  });
  test('app/get-meta observes the manifest entry without repairing the registry', async () => {
    let writes = 0;
    const r = makeEngineRoutes(baseDeps({
      appRegistry: {
        get: async () => ({ id: 'a1', name: 'App', entryFile: 'old.html' }),
        update: async () => { writes += 1; throw new Error('read wrote'); },
      },
      appClient: {
        readFile: async () => JSON.stringify({
          schema: 1, kind: 'app', entry: 'main.html', agent: { kind: 'bound-app' },
          capabilities: [],
        }),
        listFiles: async () => [{ path: 'main.html' }, { path: 'peerd.json' }],
      },
    }));
    expect(await r['app/get-meta']({ appId: 'a1' })).toMatchObject({
      ok: true, entryFile: 'main.html',
    });
    expect(writes).toBe(0);
  });
  test('app/get-meta revokes a stale registry bridge when peerd.json removes dweb', async () => {
    const r = makeEngineRoutes(baseDeps({
      appRegistry: {
        get: async () => ({ id: 'a1', name: 'App', entryFile: 'index.html', dweb: { publisher: 'did:key:zOld' } }),
        update: async (_id: string, patch: any) => ({ id: 'a1', name: 'App', dweb: { publisher: 'did:key:zOld' }, ...patch }),
      },
    }));
    expect((await r['app/get-meta']({ appId: 'a1' })).dweb).toBeNull();
  });
  test('app/get-meta grants the bridge from peerd.json without mutating provenance', async () => {
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      appClient: {
        readFile: async () => JSON.stringify({ schema: 1, kind: 'app', entry: 'index.html', agent: { kind: 'bound-app' }, capabilities: ['dweb'] }),
        listFiles: async () => [{ path: '/index.html' }, { path: '/peerd.json' }],
      },
    }));
    expect((await r['app/get-meta']({ appId: 'a1' })).dweb).toMatchObject({ local: true });
  });
  test('vm/get-meta requires a string id', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['vm/get-meta']({ vmId: 5 })).toEqual({ ok: false, error: 'vmId-required' });
  });
  test('apps/list refused when locked', async () => {
    const r = makeEngineRoutes(baseDeps({ vault: { isLocked: () => true } }));
    expect(await r['apps/list']()).toEqual({ ok: false, error: 'vault-locked' });
  });
  test('apps/import-git instantiates a manifest App, preserves its repository, and opens it under the active root', async () => {
    const calls: any[] = [];
    const audit: any[] = [];
    const contract = parseAppManifest(JSON.stringify({
      schema: 1,
      kind: 'dwapp',
      entry: 'index.html',
      agent: { kind: 'bound-app', profile: 'developer', surface: 'code' },
      capabilities: ['dweb'],
    }));
    const repository = {
      branch: 'release', oid: 'abc123',
      remote: { url: 'https://github.com/example/notes.git', host: 'github.com' },
    };
    const app = { id: 'git-app', name: 'Notes', entryFile: 'index.html' };
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      getCurrentSessionId: async () => 'root-chat',
      auditLog: { append: async (event: any) => { audit.push(event); } },
      appClient: {
        createFromGit: async (opts: any) => {
          calls.push({ op: 'clone', opts });
          return { record: app, repository, contract };
        },
        open: async (opts: any) => { calls.push({ op: 'open', opts }); },
      },
    }));
    expect(await r['apps/import-git']({
      url: ' https://github.com/example/notes ', name: ' Notes ', ref: 'release', depth: 900,
    })).toEqual({ ok: true, record: app, repository, contract });
    expect(calls).toEqual([
      { op: 'clone', opts: {
        url: ' https://github.com/example/notes ', name: ' Notes ', ref: 'release', depth: 900,
        sessionId: 'root-chat', allowDweb: true,
      } },
    ]);
    expect(audit).toEqual([]);
  });
  test('apps/import-git remains vault-gated', async () => {
    const r = makeEngineRoutes(baseDeps({ vault: { isLocked: () => true } }));
    expect(await r['apps/import-git']({ url: 'https://github.com/example/app' }))
      .toEqual({ ok: false, error: 'vault-locked' });
  });
  test('apps/import-git delegates URL validation to the repository boundary', async () => {
    const r = makeEngineRoutes(baseDeps({
      appClient: { createFromGit: async () => { throw new Error('git URL required'); } },
    }));
    expect(await r['apps/import-git']({ url: '' })).toEqual({ ok: false, error: 'git URL required' });
  });

  test('apps/import-git preserves an unknown repository outcome without exposing transport text', async () => {
    const failure = Object.assign(new Error('raw repository channel text'), {
      code: 'repository-host-timeout', outcomeKnown: false,
    });
    const r = makeEngineRoutes(baseDeps({
      appClient: { createFromGit: async () => { throw failure; } },
    }));
    expect(await r['apps/import-git']({ url: 'https://github.com/example/app' }))
      .toEqual({
        ok: false,
        code: 'repository-host-timeout',
        outcomeKnown: false,
        retryable: false,
        error: 'Peerd could not confirm whether the Git import finished. Refresh and inspect the Library before trying again.',
      });
  });
  test('App data mutations reuse exact-tab-pinned editor authority', async () => {
    const sender = { tab: { id: 44, url: 'moz-extension://peerd/engine-tabs/app-tab/index.html#app-1' } };
    const writes: any[] = [];
    const r = makeEngineRoutes(baseDeps({
      appTabTracker: {
        getTabId: (id: string) => id === 'app-1' ? 44 : null,
        parseIdFromUrl: (url: string) => url.endsWith('#app-1') ? 'app-1' : null,
      },
      appClient: {
        writeFile: async ({ path, content, reload }: any) => {
          expect(reload).toBe(false);
          writes.push({ path, content });
        },
        deleteFile: async ({ path, reload }: any) => {
          expect(reload).toBe(false);
          writes.push({ path, delete: true });
        },
      },
    }));
    expect(await r['app/editor-write']({
      appId: 'app-1', path: 'data/document.json', content: '{"text":"hello"}', runtimeData: true,
    }, sender))
      .toEqual({ ok: true });
    expect(await r['app/editor-delete']({
      appId: 'app-1', path: 'data/document.json', runtimeData: true,
    }, sender))
      .toEqual({ ok: true });
    expect(writes).toEqual([
      { path: 'data/document.json', content: '{"text":"hello"}' },
      { path: 'data/document.json', delete: true },
    ]);
    expect(await r['app/editor-write']({
      appId: 'app-1', path: '../peerd.json', content: '{}', runtimeData: true,
    }, sender))
      .toEqual({ ok: false, error: 'app-data-unauthorized' });
    expect(await r['app/editor-write'](
      { appId: 'app-1', path: 'data/document.json', content: '{}', runtimeData: true },
      { tab: { id: 45, url: sender.tab.url } },
    )).toEqual({ ok: false, error: 'app-data-unauthorized' });
  });
  test('apps/favorite requires a boolean', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['apps/favorite']({ appId: 'a1', favorite: 'yes' })).toEqual({ ok: false, error: 'favorite-boolean-required' });
  });
  test('apps/rename trims + caps the name', async () => {
    const r = makeEngineRoutes(baseDeps());
    const res = await r['apps/rename']({ appId: 'a1', name: '  Renamed  ' });
    expect(res).toEqual({ ok: true, app: { id: 'a1', name: 'Renamed' } });
  });
});

describe('apps/delete', () => {
  test('unknown id → app-not-found', async () => {
    const r = makeEngineRoutes(baseDeps({ appClient: { delete: async () => false } }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: false, error: 'app-not-found' });
  });
  test('deletes locally without an unshare when dweb is off', async () => {
    let unshared = false;
    const r = makeEngineRoutes(baseDeps({
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', shared: true }) },
      appClient: { delete: async () => true },
      browser: { runtime: { sendMessage: async () => { unshared = true; } }, storage: { local: { get: async () => ({}) } } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(unshared).toBe(false); // DWEB_ENABLED false → no offscreen round-trip
  });
  test('retires chat-scoped actor bindings after the App is deleted', async () => {
    const retired: string[] = [];
    const r = makeEngineRoutes(baseDeps({
      appRegistry: { get: async () => ({ id: 'a1', name: 'A' }) },
      appClient: { delete: async () => true },
      onAppDeleted: async (appId: string) => { retired.push(appId); },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(retired).toEqual(['a1']);
  });
  test('un-shares a shared app when dweb is on', async () => {
    let msg: any = null;
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      settingsStore: { get: () => ({ dwebEnabled: true }) },
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', shared: true, dweb: { publisher: 'pub', hash: 'h', slug: 'custom-a', local: true } }) },
      appClient: { delete: async () => true },
      listOffscreenContexts: async () => [{}],
      browser: { runtime: { getContexts: async () => [{}], sendMessage: async (m: any) => { msg = m; return { ok: true }; } } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(msg).toEqual({
      type: 'dweb/base-host/unshare-app', appId: 'a1', name: 'A', slug: 'custom-a',
      publisher: 'pub', unpublish: true, hash: 'h', hashes: ['h'],
    });
  });
  test('disabled dweb still revokes a networked App from a surviving host before delete', async () => {
    const events: string[] = [];
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      settingsStore: { get: () => ({ dwebEnabled: false }) },
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', shared: true, dweb: { local: true, hash: 'h' } }) },
      appClient: { delete: async () => { events.push('delete'); return true; } },
      listOffscreenContexts: async () => [{}],
      browser: { runtime: {
        getContexts: async () => [{}],
        sendMessage: async () => { events.push('unshare'); return { ok: true }; },
      } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(events).toEqual(['unshare', 'delete']);
  });
  test('disabled dweb deletes safely without creating an absent offscreen host', async () => {
    let sent = false;
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      settingsStore: { get: () => ({ dwebEnabled: false }) },
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', shared: true, dweb: { hash: 'h' } }) },
      appClient: { delete: async () => true },
      listOffscreenContexts: async () => [],
      browser: { runtime: {
        getContexts: async () => [],
        sendMessage: async () => { sent = true; return { ok: true }; },
      } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(sent).toBe(false);
  });
  test('Firefox deletes a networked App without probing the absent offscreen API', async () => {
    let sent = false;
    let probed = false;
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', shared: true, dweb: { hash: 'h' } }) },
      appClient: { delete: async () => true },
      browser: { runtime: {
        getContexts: async () => { probed = true; throw new Error('OFFSCREEN_DOCUMENT is unsupported'); },
        sendMessage: async () => { sent = true; return { ok: true }; },
      } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(probed).toBe(false);
    expect(sent).toBe(false);
  });
  test('un-shares both discovery and room-published versions on delete', async () => {
    let msg: any = null;
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      settingsStore: { get: () => ({ dwebEnabled: true }) },
      appRegistry: { get: async () => ({
        id: 'a1', name: 'A', shared: true,
        dweb: {
          publisher: 'pub', hash: 'main', room_hash: 'room', slug: 'a',
          pending_unserve_hashes: ['older-share'],
          pending_seed_unserve_hashes: ['older-seed'],
        },
      }) },
      appClient: { delete: async () => true },
      listOffscreenContexts: async () => [{}],
      browser: { runtime: { getContexts: async () => [{}], sendMessage: async (message: any) => { msg = message; return { ok: true }; } } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(msg.hashes).toEqual(['main', 'room', 'older-share', 'older-seed']);
  });
  test('deleting an installed App does not tombstone the peer discovery card', async () => {
    let msg: any = null;
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      appRegistry: { get: async () => ({
        id: 'a1', name: 'A', dweb: { publisher: 'peer', hash: 'main', slug: 'a' },
      }) },
      appClient: { delete: async () => true },
      listOffscreenContexts: async () => [{}],
      browser: { runtime: {
        getContexts: async () => [{}],
        sendMessage: async (message: any) => { msg = message; return { ok: true }; },
      } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(msg).toMatchObject({ publisher: 'peer', hash: 'main', unpublish: false });
  });
  test('does NOT unshare a purely-local app even with dweb fully on', async () => {
    let sent = false;
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      settingsStore: { get: () => ({ dwebEnabled: true }) },
      appRegistry: { get: async () => ({ id: 'a1', name: 'A' }) }, // neither dweb nor shared
      appClient: { delete: async () => true },
      browser: { runtime: { sendMessage: async () => { sent = true; } } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({ ok: true });
    expect(sent).toBe(false); // the (record.dweb || record.shared) gate must skip the offscreen round-trip
  });
  test('unshare failure preserves the local App and its revocation metadata', async () => {
    let deleted = false;
    const r = makeEngineRoutes(baseDeps({
      DWEB_ENABLED: true,
      settingsStore: { get: () => ({ dwebEnabled: true }) },
      appRegistry: { get: async () => ({ id: 'a1', name: 'A', dweb: {} }) },
      appClient: { delete: async () => { deleted = true; return true; } },
      listOffscreenContexts: async () => [{}],
      browser: { runtime: { getContexts: async () => [{}], sendMessage: async () => { throw new Error('mesh down'); } } },
    }));
    expect(await r['apps/delete']({ appId: 'a1' })).toEqual({
      ok: false,
      code: 'dweb-unshare-failed',
      error: 'Could not stop sharing, so your local App was kept. Try again when the dweb is available.',
    });
    expect(deleted).toBe(false);
  });
});

describe('export/artifact', () => {
  test('id required', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['export/artifact']({ kind: 'app', id: '' })).toEqual({ ok: false, error: 'id-required' });
  });
  test('unknown kind rejected', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['export/artifact']({ kind: 'spaceship', id: 'a1' })).toEqual({ ok: false, error: 'unknown-kind' });
  });
  test('app export returns filename + envelope', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['export/artifact']({ kind: 'app', id: 'a1' })).toEqual({ ok: true, filename: 'App.app.peerd', envelope: { env: 'app' } });
  });
  test('artifact export does not mutate audit state', async () => {
    let writes = 0;
    const r = makeEngineRoutes(baseDeps({
      auditLog: { append: async () => { writes += 1; } },
    }));
    expect((await r['export/artifact']({ kind: 'app', id: 'a1' })).ok).toBe(true);
    expect(writes).toBe(0);
  });
  test('app export preserves every file as bytes, including an unknown suffix', async () => {
    const raw = new Uint8Array([0xff, 0x00, 0xc0]);
    let exported: any = null;
    const r = makeEngineRoutes(baseDeps({
      artifactEngine: {
        ...baseDeps().artifactEngine,
        buildAppExport: async ({ files }: any) => { exported = files; return { env: 'app' }; },
      },
      appClient: {
        snapshotFiles: async () => ({
          record: { name: 'App', entryFile: 'index.html', fileKinds: { 'index.html': 'text', 'model.custom': 'binary' } },
          files: { 'index.html': new TextEncoder().encode('<h1>x</h1>'), 'model.custom': raw },
        }),
      },
    }));
    expect((await r['export/artifact']({ kind: 'app', id: 'a1' })).ok).toBe(true);
    expect(Array.from(exported['model.custom'])).toEqual(Array.from(raw));
  });
  test('vm export without an image pin refuses', async () => {
    const r = makeEngineRoutes(baseDeps());
    const res = await r['export/artifact']({ kind: 'vm', id: 'v1' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no-image-pin');
  });
});

describe('import/apply', () => {
  test('format error mapped to message', async () => {
    const r = makeEngineRoutes(baseDeps({ artifactEngine: {
      ...baseDeps().artifactEngine,
      openEnvelope: async () => { throw new EnvelopeFormatError('bad envelope'); },
    } }));
    expect(await r['import/apply']({ envelope: {} })).toEqual({ ok: false, error: 'bad envelope' });
  });
  test('integrity error mapped to message', async () => {
    const r = makeEngineRoutes(baseDeps({ artifactEngine: {
      ...baseDeps().artifactEngine,
      openEnvelope: async () => { throw new EnvelopeIntegrityError('hash mismatch'); },
    } }));
    expect(await r['import/apply']({ envelope: {} })).toEqual({ ok: false, error: 'hash mismatch' });
  });
  test('app import mints a fresh id', async () => {
    const r = makeEngineRoutes(baseDeps());
    expect(await r['import/apply']({ envelope: {} })).toEqual({ ok: true, kind: 'app', id: 'imported' });
  });
  test('app import passes raw bytes to storage without classifying the suffix', async () => {
    const raw = new Uint8Array([0xff, 0x00, 0xc0]);
    let received: any = null;
    const r = makeEngineRoutes(baseDeps({
      appClient: { create: async (opts: any) => { received = opts.files; return { id: 'imported' }; } },
      artifactEngine: {
        ...baseDeps().artifactEngine,
        openEnvelope: async () => ({
          kind: 'app', name: 'X', entry: 'index.html', meta: { tags: [] },
          files: { 'index.html': new TextEncoder().encode('<h1>x</h1>'), 'model.custom': raw },
        }),
      },
    }));
    expect((await r['import/apply']({ envelope: {} })).ok).toBe(true);
    expect(received['index.html']).toBeInstanceOf(Uint8Array);
    expect(Array.from(received['model.custom'])).toEqual(Array.from(raw));
  });
  test('a blocked Notebook import refuses before metadata or OPFS mutation', async () => {
    let creates = 0;
    let writes = 0;
    const r = makeEngineRoutes(baseDeps({
      artifactEngine: {
        ...baseDeps().artifactEngine,
        openEnvelope: async () => ({
          kind: 'notebook', name: 'Imported', entry: 'notebook.js', meta: { tags: [] },
          files: { 'notebook.js': new TextEncoder().encode('return 1;') },
        }),
      },
      jsRegistry: {
        get: async () => null,
        create: async () => { creates += 1; return { id: 'nNew' }; },
      },
      opfsHelpers: () => ({ write: async () => { writes += 1; } }),
      assertOpfsWritable: async () => {
        throw new Error("store 'opfs-workspaces' is read-only. No data was changed.");
      },
    }));
    const result = await r['import/apply']({ envelope: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("'opfs-workspaces'");
    expect(creates).toBe(0);
    expect(writes).toBe(0);
  });
  test('unexpected error rethrown (not swallowed)', async () => {
    const r = makeEngineRoutes(baseDeps({ artifactEngine: {
      ...baseDeps().artifactEngine,
      openEnvelope: async () => { throw new Error('weird'); },
    } }));
    await expect(r['import/apply']({ envelope: {} })).rejects.toThrow('weird');
  });
});
