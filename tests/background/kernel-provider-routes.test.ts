import { describe, expect, test } from 'bun:test';
import {
  createKernelOpenRouterModelsRoute,
  createKernelLocalRoutes,
  createKernelProviderTestRoute,
  createKernelSemanticRoutes,
  makeKernelModelOptionsRoute,
  makeKernelProviderSetKeyRoute,
} from '../../extension/background/kernel-local-routes.js';
import {
  PROVIDER_AUTHORITY,
  OPENROUTER_POPULAR,
  normalizeOpenRouterModels,
} from '../../extension/shared/provider-authority-policy.js';
import { listProviders } from '../../extension/peerd-provider/background.js';
import { makeModelCatalog } from '../../extension/background/model-catalog.js';
import { anthropicAdapter } from '../../extension/peerd-provider/adapters/anthropic.js';
import {
  listOpenRouterModels,
  OPENROUTER_POPULAR as ADAPTER_OPENROUTER_POPULAR,
  openrouterAdapter,
} from '../../extension/peerd-provider/adapters/openrouter.js';
import { openaiAdapter } from '../../extension/peerd-provider/adapters/openai.js';
import { glmAdapter } from '../../extension/peerd-provider/adapters/glm.js';

describe('native provider authority policy', () => {
  test('pins every shipped provider to its exact vault-secret posture', () => {
    expect(JSON.parse(JSON.stringify(PROVIDER_AUTHORITY))).toEqual(listProviders().map((provider) => ({
      name: provider.name,
      label: provider.label,
      secretName: provider.vaultSecretName ?? null,
      defaultModel: provider.defaultModel,
      defaultRunnerModel: provider.defaultRunnerModel,
      probeKind: provider.name === 'anthropic' ? 'anthropic'
        : provider.name === 'ollama' ? 'ollama'
          : provider.name === 'local-webgpu' ? 'none' : 'openai',
      probeEndpoint: provider.name === 'anthropic' ? 'https://api.anthropic.com/v1/messages'
        : provider.name === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions'
          : provider.name === 'openai' ? 'https://api.openai.com/v1/chat/completions'
            : provider.name === 'glm' ? 'https://api.z.ai/api/paas/v4/chat/completions' : null,
    })));
  });

  test('native status is descriptor-only, secret-masked, and host-free', async () => {
    const reads: string[] = [];
    const routes = createKernelSemanticRoutes({
      idb: { get: async () => undefined, getAll: async () => [], put: async () => {}, del: async () => {} },
      auditLog: { list: async () => [] }, ready: Promise.resolve(),
      vault: { isLocked: () => false, getSecret: async (name: string) => {
        reads.push(name);
        return name === 'anthropic_api_key' ? 'sk-ant-example-123456' : null;
      } },
    });
    const direct = await routes['provider/status']();
    expect(reads).toEqual(PROVIDER_AUTHORITY.flatMap((row) => row.secretName ? [row.secretName] : []));
    expect(direct).toEqual({
      ok: true,
      providers: PROVIDER_AUTHORITY.map((provider) => ({
        name: provider.name,
        label: provider.label,
        defaultModel: provider.defaultModel,
        defaultRunnerModel: provider.defaultRunnerModel,
        hasKey: provider.secretName === null || provider.name === 'anthropic',
        keyless: provider.secretName === null,
        liveModels: provider.probeKind === 'ollama',
        keyPreview: provider.name === 'anthropic' ? 'sk-ant-…456 · 21 chars' : null,
      })),
    });
    expect(JSON.stringify(direct)).not.toContain('example-123456');
  });

  test('pins every credentialed probe to its shipped endpoint and default model', () => {
    const adapters = [anthropicAdapter, openrouterAdapter, openaiAdapter, glmAdapter];
    expect(PROVIDER_AUTHORITY.filter((row) => row.probeEndpoint !== null).map((row) => ({
      name: row.name, endpoint: row.probeEndpoint, model: row.defaultModel,
    }))).toEqual(adapters.map((adapter) => ({
      name: adapter.name, endpoint: adapter.endpoint, model: adapter.defaultModel,
    })));
    expect(PROVIDER_AUTHORITY.map((row) => String(row.name)))
      .toEqual(listProviders().map((provider) => provider.name));
  });

});

describe('native UI-base provider/composer projection', () => {
  const makeLocal = (overrides: Record<string, any> = {}) => {
    let settings = overrides.settings ?? { providerName: 'anthropic', providerModel: '' };
    const pushes: string[] = [];
    const appFiles = Object.fromEntries([
      'listApp', 'listAppInfo', 'readText', 'readBytes', 'write', 'writeText', 'deleteFile',
    ].map((name) => [name, async () => name.startsWith('list') ? [] : undefined]));
    const routes = createKernelLocalRoutes({
      vault: overrides.vault ?? { getSecret: async () => null },
      idb: { get: async () => undefined },
      auditLog: { append: async () => {} },
      sessionCache: { sessionGet: async () => null },
      repositories: { appFiles, coordinate: async (_ref: any, fn: Function) => fn() },
      ready: Promise.resolve(), settingsStore: { get: () => settings, update: async () => {} },
      pushState: () => { pushes.push('state'); },
      isAllowed: () => true, isOptions: () => true, isVoice: () => true,
      sessions: { getMetadata: async () => null },
      browser: { storage: { local: { get: async () => overrides.local ?? {} } } },
      fetchFn: overrides.fetchFn ?? (async () => new Response('{}', { status: 500 })),
      localModels: true,
    });
    return { routes, pushes, setSettings: (next: any) => { settings = next; } };
  };

  test('uses the session-bound provider and model instead of future defaults', async () => {
    const { routes } = makeLocal({
      vault: { getSecret: async (name: string) => name === 'openrouter_api_key' ? 'key' : null },
    });
    expect(await routes.providerView({ provider: 'openrouter', model: 'bound/model' }, false))
      .toMatchObject({
        providers: { current: 'anthropic' },
        composer: { provider: 'openrouter', model: 'bound/model', canSend: true },
      });
  });

  test('never treats an uninstalled local model as ready', async () => {
    const { routes } = makeLocal({
      settings: { providerName: 'local-webgpu', providerModel: 'gemma-4-e2b' }, local: {},
    });
    expect((await routes.providerView(null, false)).composer).toMatchObject({
      localReady: false, canSend: false, reason: 'local-model-not-installed',
    });
  });

  test('feeds exact Ollama inventory into composer readiness and state refresh', async () => {
    const { routes, pushes } = makeLocal({
      settings: { providerName: 'ollama', providerModel: 'wanted:latest' },
      fetchFn: async () => new Response(JSON.stringify({ models: [] })),
    });
    expect((await routes.providerView(null, false)).composer.canSend).toBe(true);
    await routes.modelOptions();
    expect(pushes).toEqual(['state']);
    expect((await routes.providerView(null, false)).composer).toMatchObject({
      ollamaReady: false, canSend: false, reason: 'ollama-no-models',
    });
  });

  test('blocks a missing Ollama selection, warns on unreachable, and invalidates old hosts', async () => {
    const { routes, setSettings } = makeLocal({
      settings: { providerName: 'ollama', providerModel: 'wanted:latest',
        ollamaHost: 'http://one.local:11434' },
      fetchFn: async () => new Response(JSON.stringify({ models: [{ name: 'other:latest' }] })),
    });
    await routes.modelOptions();
    expect((await routes.providerView(null, false)).composer).toMatchObject({
      canSend: false, reason: 'ollama-model-missing',
    });
    setSettings({ providerName: 'ollama', providerModel: 'wanted:latest',
      ollamaHost: 'http://two.local:11434' });
    expect((await routes.providerView(null, false)).composer).toMatchObject({
      canSend: true, reason: null, warning: null,
    });

    const unreachable = makeLocal({
      settings: { providerName: 'ollama', providerModel: 'wanted:latest',
        ollamaHost: 'http://box.local:11434' },
      fetchFn: async () => new Response('', { status: 503 }),
    });
    await unreachable.routes.modelOptions();
    expect((await unreachable.routes.providerView(null, false)).composer).toMatchObject({
      canSend: true, reason: null, warning: 'ollama-unreachable',
    });
  });
});

describe('native model option projection', () => {
  const route = (overrides: Record<string, any> = {}) => makeKernelModelOptionsRoute({
    ready: Promise.resolve(),
    vault: { getSecret: async (name: string) => name === 'anthropic_api_key' ? 'key' : null },
    settingsStore: { get: () => ({
      providerName: 'anthropic', providerModel: '',
      openrouterModels: ['custom/router-model'], ollamaHost: 'http://box.local:11434',
    }) },
    sessions: { getMetadata: async () => null },
    browser: { storage: { local: { get: async () => ({
      localModelDownloaded: ['gemma-4-e2b'],
    }) } } },
    fetchFn: async () => new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] })),
    localModels: true,
    ...overrides,
  });

  test('builds a host-free fresh catalog from bounded authority projections', async () => {
    const calls: any[] = [];
    const result = await route({
      fetchFn: async (url: URL, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 7 }] }));
      },
    })();
    expect(result.ok).toBe(true);
    expect(result.selected).toBe('anthropic::claude-sonnet-4-6');
    expect(result.sessionProvider).toBe(null);
    expect(result.options.some((row: any) => row.value === 'anthropic::claude-sonnet-4-6')).toBe(true);
    expect(result.options.some((row: any) => row.value === 'ollama::qwen3:8b')).toBe(true);
    expect(result.options.some((row: any) => row.value === 'local-webgpu::gemma-4-e2b')).toBe(true);
    expect(result.options.some((row: any) => row.provider === 'openrouter')).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://box.local:11434/api/tags');
    expect(calls[0].init.redirect).toBe('manual');
    expect(calls[0].init.credentials).toBe('omit');
  });

  test('matches the legacy catalog for keyed, curated, daemon, and local providers', async () => {
    const settings = {
      providerName: 'openrouter', providerModel: 'custom/router-model',
      openrouterModels: ['custom/router-model'], ollamaHost: 'http://box.local:11434',
    };
    const vault = { getSecret: async (name: string) => name.endsWith('_api_key') ? 'key' : null };
    const legacy = await makeModelCatalog({
      listProviders,
      listProviderModels: async (name: string) => name === 'ollama'
        ? [{ model: 'qwen3:8b', label: 'qwen3:8b' }] : null,
      providerModelContextWindow: async () => null,
      localModelIds: () => ['gemma-4-e2b'],
      localModelLabel: () => 'Gemma 4 E2B',
      settingsStore: { get: () => settings }, vault,
      sessions: { get: async () => null },
      resolveActiveProvider: () => ({ name: 'openrouter', model: 'custom/router-model' }),
      getSecret: vault.getSecret, safeFetch: async () => new Response(),
    }).buildModelOptions();
    const native = await route({
      settingsStore: { get: () => settings }, vault,
      fetchFn: async () => new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] })),
    })();
    expect(native).toEqual({ ok: true, ...legacy });
  });

  test('locks a session to its provider and keeps a custom current model visible', async () => {
    const result = await route({
      vault: { getSecret: async () => null },
      sessions: { getMetadata: async () => ({ provider: 'openrouter', model: 'private/current' }) },
    })({ sessionId: 'session-1' });
    expect(result.sessionProvider).toBe('openrouter');
    expect(result.selected).toBe('openrouter::private/current');
    expect(result.options.every((row: any) => row.provider === 'openrouter')).toBe(true);
    expect(result.options.some((row: any) => row.value === 'openrouter::private/current')).toBe(true);
    expect(result.options.some((row: any) => row.value === 'openrouter::custom/router-model')).toBe(true);
  });

  test('Firefox excludes the Chrome-only local provider without touching local storage', async () => {
    let storageReads = 0;
    const result = await route({
      localModels: false,
      browser: { storage: { local: { get: async () => { storageReads += 1; return {}; } } } },
    })();
    expect(storageReads).toBe(0);
    expect(result.options.some((row: any) => row.provider === 'local-webgpu')).toBe(false);
  });

  test('bounds malformed live inventory and preserves an explicit unavailable selection', async () => {
    const result = await route({
      settingsStore: { get: () => ({
        providerName: 'ollama', providerModel: 'wanted:latest',
        openrouterModels: [], ollamaHost: 'http://box.local:11434',
      }) },
      fetchFn: async () => new Response(JSON.stringify({ models: new Array(250).fill({ nope: true }) })),
    })();
    expect(result.selected).toBe('ollama::wanted:latest');
    expect(result.options[0]).toMatchObject({
      value: 'ollama::wanted:latest', unavailable: true,
    });
  });
});

describe('native OpenRouter model inventory', () => {
  const modelBody = {
    data: [
      { id: 'vendor/two', name: 'Zulu', context_length: 12,
        pricing: { prompt: '0.2', completion: 'nope' } },
      { id: 'vendor/one', name: 'Alpha', context_length: Infinity,
        pricing: { prompt: 0.1, completion: 0.3 } },
      { id: '', name: 'ignored' },
    ],
  };

  test('shares the exact curated and normalized catalog contract with the legacy adapter', async () => {
    expect(ADAPTER_OPENROUTER_POPULAR).toBe(OPENROUTER_POPULAR);
    const legacy = await listOpenRouterModels({
      safeFetch: async () => new Response(JSON.stringify(modelBody)),
      getSecret: async () => 'secret',
    });
    expect(legacy).toEqual(normalizeOpenRouterModels(modelBody));
    expect(legacy).toEqual([
      { model: 'vendor/one', label: 'Alpha', contextLength: 0,
        promptPrice: 0.1, completionPrice: 0.3 },
      { model: 'vendor/two', label: 'Zulu', contextLength: 12,
        promptPrice: 0.2, completionPrice: 0 },
    ]);
  });

  test('uses one exact attributed GET, keeps the vaulted key kernel-side, and coalesces demand', async () => {
    const requests: any[] = [];
    let release!: (response: Response) => void;
    let entered!: () => void;
    const fetching = new Promise<void>((resolve) => { entered = resolve; });
    const response = new Promise<Response>((resolve) => { release = resolve; });
    const client = createKernelOpenRouterModelsRoute({
      ready: Promise.resolve(),
      vault: { isLocked: () => false, getSecret: async () => 'router-secret' },
      fetchFn: async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        entered();
        return response;
      },
    });
    const first = client.route();
    const second = client.route();
    await fetching;
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://openrouter.ai/api/v1/models');
    expect(requests[0].init).toMatchObject({
      method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
    });
    expect(requests[0].init.headers).toEqual({
      'http-referer': 'https://peerd.ai', 'x-title': 'peerd.ai',
      'x-openrouter-categories': 'personal-agent', authorization: 'Bearer router-secret',
    });
    release(new Response(JSON.stringify(modelBody)));
    expect(await first).toEqual({
      ok: true, models: normalizeOpenRouterModels(modelBody), popular: OPENROUTER_POPULAR,
    });
    expect(await second).toEqual(await first);
    expect(JSON.stringify(await first)).not.toContain('router-secret');
  });

  test('bounds cold readiness, response bytes, redirects, and credential refusals as safe reads', async () => {
    const never = new Promise(() => {});
    const timed = createKernelOpenRouterModelsRoute({
      ready: never,
      vault: { isLocked: () => false, getSecret: async () => null },
      fetchFn: async () => new Response('{}'), timeoutMs: 5,
    });
    expect(await timed.route()).toEqual({ ok: false, status: null, error: 'unreachable' });

    const resultFor = (response: Response, maxBytes = 20) => createKernelOpenRouterModelsRoute({
      ready: Promise.resolve(),
      vault: { isLocked: () => false, getSecret: async () => null },
      fetchFn: async () => response, maxBytes,
    }).route();
    expect(await resultFor(new Response('x'.repeat(21))))
      .toEqual({ ok: false, status: null, error: 'unreachable' });
    expect(await resultFor(new Response('', { status: 302 })))
      .toEqual({ ok: false, status: 302, error: 'unreachable' });
    expect(await resultFor(new Response('', { status: 401 })))
      .toEqual({ ok: false, status: 401, error: 'invalid-key' });
  });

  test('vault lock aborts an in-flight read and a successor stays locked without fetching', async () => {
    let locked = false;
    let calls = 0;
    let entered!: () => void;
    const fetching = new Promise<void>((resolve) => { entered = resolve; });
    const client = createKernelOpenRouterModelsRoute({
      ready: Promise.resolve(),
      vault: { isLocked: () => locked, getSecret: async () => null },
      fetchFn: async (_url: string, init: RequestInit) => {
        calls += 1;
        entered();
        return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')), { once: true }));
      },
    });
    const pending = client.route();
    await fetching;
    locked = true;
    client.abortAll();
    expect(await pending).toEqual({ ok: false, status: null, error: 'locked' });
    expect(await client.route()).toEqual({ ok: false, status: null, error: 'locked' });
    expect(calls).toBe(1);
  });
});

describe('native provider verification custody', () => {
  const harness = (overrides: Record<string, any> = {}) => {
    const fetched: any[] = [];
    const audited: any[] = [];
    let locked = false;
    const deps = {
      ready: Promise.resolve(),
      vault: {
        isLocked: () => locked,
        getSecret: async (name: string) => `${name}-secret`,
      },
      settingsStore: { get: () => ({ ollamaHost: 'http://localhost:11434' }) },
      auditLog: { append: async (entry: any) => { audited.push(entry); } },
      fetchFn: async (url: string, init: RequestInit) => {
        fetched.push({ url, init });
        return new Response('ok', { status: 200 });
      },
      ...overrides,
    };
    const client = createKernelProviderTestRoute(deps);
    return { ...client, fetched, audited, lock: () => { locked = true; } };
  };

  test('uses only the fixed provider endpoint and keeps the secret out of the result', async () => {
    const h = harness();
    const result = await h.route({ provider: 'anthropic', endpoint: 'https://attacker.invalid' });
    expect(result).toEqual({ ok: true });
    expect(h.fetched).toHaveLength(1);
    expect(h.fetched[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(h.fetched[0].init.redirect).toBe('manual');
    expect(h.fetched[0].init.credentials).toBe('omit');
    expect(h.fetched[0].init.headers['x-api-key']).toBe('anthropic_api_key-secret');
    expect(JSON.parse(h.fetched[0].init.body)).toMatchObject({
      model: 'claude-sonnet-4-6', max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }], stream: true,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    await Promise.resolve();
    expect(h.audited).toEqual([{ type: 'provider_validated', details: { provider: 'anthropic' } }]);
  });

  test('classifies stable refusals without auditing a successful validation', async () => {
    const noKey = harness({ vault: { isLocked: () => false, getSecret: async () => null } });
    expect(await noKey.route({ provider: 'openai' })).toEqual({ ok: false, error: 'no-key' });
    const denied = harness({ fetchFn: async () => new Response('', { status: 401 }) });
    expect(await denied.route({ provider: 'openrouter' }))
      .toEqual({ ok: false, error: 'invalid-key' });
    expect(denied.audited).toEqual([]);
    expect(await denied.route({ provider: 'missing' }))
      .toEqual({ ok: false, error: 'unknown-provider' });
    expect(await denied.route({ provider: 'local-webgpu' }))
      .toEqual({ ok: false, error: 'no-live-test' });
  });

  test('bounds and parses the exact configured Ollama inventory endpoint', async () => {
    const h = harness({
      settingsStore: { get: () => ({ ollamaHost: 'http://box.local:11434' }) },
      fetchFn: async (url: string, init: RequestInit) => {
        h.fetched.push({ url, init });
        return new Response(JSON.stringify({ models: [{ name: 'a' }, {}, { name: 'b' }] }));
      },
    });
    expect(await h.route({ provider: 'ollama' }))
      .toEqual({ ok: true, reachable: true, models: 2 });
    expect(h.fetched[0].url).toBe('http://box.local:11434/api/tags');
    expect(h.fetched[0].init.method).toBe('GET');
  });

  test('coalesces an exact provider and never replays an ambiguous network loss', async () => {
    let release!: (response: Response) => void;
    let calls = 0;
    const h = harness({ fetchFn: async () => {
      calls += 1;
      return new Promise<Response>((resolve) => { release = resolve; });
    } });
    const first = h.route({ provider: 'glm' });
    const second = h.route({ provider: 'glm' });
    expect(second).toBe(first);
    for (let index = 0; index < 6 && calls === 0; index += 1) await Promise.resolve();
    expect(calls).toBe(1);
    release(new Response('ok'));
    expect(await first).toEqual({ ok: true });

    const lost = harness({ fetchFn: async () => { throw new TypeError('connection lost'); } });
    expect(await lost.route({ provider: 'glm' })).toEqual({
      ok: false, error: 'provider-test-unconfirmed', outcomeKnown: false,
      outcomeKind: 'unknown', retryable: false,
    });
    expect(lost.fetched).toHaveLength(0);
  });

  test('a vault lock aborts an in-flight credentialed probe', async () => {
    let started = 0;
    const h = harness({ fetchFn: async (_url: string, init: RequestInit) => {
      started += 1;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    } });
    const pending = h.route({ provider: 'openai' });
    for (let index = 0; index < 6 && started === 0; index += 1) await Promise.resolve();
    expect(started).toBe(1);
    h.lock();
    h.abortAll();
    expect(await pending).toEqual({
      ok: false, error: 'provider-test-unconfirmed', outcomeKnown: false,
      outcomeKind: 'unknown', retryable: false,
    });
  });
});

describe('native provider key custody', () => {
  const harness = (overrides: Record<string, any> = {}) => {
    const stored: any[] = [];
    const audited: any[] = [];
    const updated: any[] = [];
    let pushed = 0;
    const deps = {
      vault: {
        isLocked: () => false,
        getSecret: async () => null,
        setSecret: async (name: string, value: string) => { stored.push({ name, value }); },
      },
      settingsStore: {
        get: () => ({ providerName: 'openai', providerModel: 'old' }),
        update: async (patch: any) => { updated.push(patch); },
      },
      auditLog: { append: async (entry: any) => { audited.push(entry); } },
      pushState: async () => { pushed += 1; },
      ...overrides,
    };
    return {
      route: makeKernelProviderSetKeyRoute(deps), stored, audited, updated,
      pushed: () => pushed,
    };
  };

  test('trims, vaults, audits, activates an unusable selection, and pushes state', async () => {
    const h = harness();
    await expect(h.route({
      provider: 'anthropic', plaintext: '  sk-ant-valid-value  ',
    })).resolves.toEqual({ ok: true });
    expect(h.stored).toEqual([{
      name: 'anthropic_api_key', value: 'sk-ant-valid-value',
    }]);
    expect(h.audited).toEqual([{
      type: 'provider_added', details: { provider: 'anthropic' },
    }]);
    expect(h.updated).toEqual([{ providerName: 'anthropic', providerModel: '' }]);
    await Promise.resolve();
    expect(h.pushed()).toBe(1);
  });

  test('refuses unknown, keyless, and short inputs before secret storage', async () => {
    const h = harness();
    await expect(h.route({ provider: 'missing', plaintext: 'long-enough' }))
      .resolves.toEqual({ ok: false, error: 'unknown-provider' });
    await expect(h.route({ provider: 'ollama', plaintext: 'long-enough' }))
      .resolves.toEqual({ ok: false, error: 'keyless-provider' });
    await expect(h.route({ provider: 'openai', plaintext: ' short ' }))
      .resolves.toEqual({ ok: false, error: 'key-too-short' });
    expect(h.stored).toEqual([]);
  });

  test('does not switch an already usable or explicitly preserved selection', async () => {
    const usable = harness({
      vault: {
        isLocked: () => false,
        getSecret: async () => 'existing-key',
        setSecret: async () => {},
      },
    });
    await usable.route({ provider: 'anthropic', plaintext: 'new-valid-key' });
    expect(usable.updated).toEqual([]);
    const preserved = harness();
    await preserved.route({
      provider: 'anthropic', plaintext: 'new-valid-key', activate: false,
    });
    expect(preserved.updated).toEqual([]);
  });

  test('an exact replay does not rewrite or re-audit an already stored key', async () => {
    const stored: any[] = [];
    const audited: any[] = [];
    const route = makeKernelProviderSetKeyRoute({
      vault: {
        isLocked: () => false,
        getSecret: async () => 'same-provider-key',
        setSecret: async (...args: any[]) => { stored.push(args); },
      },
      settingsStore: { get: () => ({ providerName: 'anthropic' }), update: async () => {} },
      auditLog: { append: async (entry: any) => { audited.push(entry); } },
      pushState: async () => {},
    });
    expect(await route({ provider: 'anthropic', plaintext: 'same-provider-key' }))
      .toEqual({ ok: true });
    expect(stored).toEqual([]);
    expect(audited).toEqual([]);
  });

  test('classifies loss after secret commit as outcome unknown', async () => {
    const h = harness({
      settingsStore: {
        get: () => ({ providerName: 'openai' }),
        update: async () => { throw new Error('settings receipt lost'); },
      },
    });
    try {
      await h.route({ provider: 'anthropic', plaintext: 'sk-ant-valid' });
      throw new Error('expected provider effect to reject');
    } catch (cause: any) {
      expect(cause.message).toBe('settings receipt lost');
      expect(cause.outcomeKnown).toBe(false);
    }
    expect(h.stored).toHaveLength(1);
  });

  test('maps a pre-commit locked refusal without claiming an effect', async () => {
    const h = harness({
      vault: {
        isLocked: () => true,
        getSecret: async () => null,
        setSecret: async () => { throw new Error('locked'); },
      },
    });
    await expect(h.route({ provider: 'anthropic', plaintext: 'sk-ant-valid' }))
      .resolves.toEqual({ ok: false, error: 'locked' });
  });

  test('never calls an ambiguous secret failure safe to replay', async () => {
    const h = harness({
      vault: {
        isLocked: () => false,
        getSecret: async () => null,
        setSecret: async () => { throw new Error('secret receipt lost'); },
      },
    });
    try {
      await h.route({ provider: 'anthropic', plaintext: 'sk-ant-valid' });
      throw new Error('expected provider effect to reject');
    } catch (cause: any) {
      expect(cause.message).toBe('secret receipt lost');
      expect(cause.outcomeKnown).toBe(false);
    }
  });
});
