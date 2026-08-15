import { describe, expect, test } from 'bun:test';
import { makeModelCatalog } from '../../extension/background/model-catalog.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const makeDeps = (overrides: Record<string, any> = {}) => {
  const settings = { ollamaHost: 'http://a:11434', providerName: 'ollama', providerModel: 'qwen3:8b' };
  return {
    settings,
    deps: {
      listProviders: () => [{
        name: 'ollama', label: 'Ollama', defaultModel: 'qwen3:8b',
        keyless: true, liveModels: true,
      }],
      listProviderModels: async () => [],
      providerModelContextWindow: async () => null,
      localModelIds: () => [],
      localModelLabel: (id: string) => id,
      settingsStore: { get: () => settings },
      vault: { getSecret: async () => null },
      sessions: { get: async () => null },
      resolveActiveProvider: () => ({ name: settings.providerName, model: settings.providerModel }),
      getSecret: async () => null,
      safeFetch: () => {},
      ...overrides,
    },
  };
};

describe('model catalog host-scoped live caches', () => {
  test('changing Ollama host fetches the new inventory while same-host calls hit cache', async () => {
    const seen: string[] = [];
    const { settings, deps } = makeDeps({
      listProviderModels: async (_name: string, opts: any) => {
        seen.push(opts.ollamaHost);
        return [{ model: opts.ollamaHost, label: opts.ollamaHost }];
      },
    });
    const catalog = makeModelCatalog(deps);

    expect((await catalog.liveProviderModels('ollama'))?.[0]?.model).toBe('http://a:11434');
    expect((await catalog.liveProviderModels('ollama'))?.[0]?.model).toBe('http://a:11434');
    settings.ollamaHost = 'http://b:11434';
    expect((await catalog.liveProviderModels('ollama'))?.[0]?.model).toBe('http://b:11434');
    expect(seen).toEqual(['http://a:11434', 'http://b:11434']);
  });

  test('changing Ollama host does not reuse a context window learned from another daemon', async () => {
    const seen: string[] = [];
    const { settings, deps } = makeDeps({
      providerModelContextWindow: async (_provider: string, _model: string, opts: any) => {
        seen.push(opts.ollamaHost);
        return opts.ollamaHost.includes('a:') ? 8192 : 32768;
      },
    });
    const catalog = makeModelCatalog(deps);

    expect(catalog.liveContextWindow('ollama', 'same-model')).toBeUndefined();
    await tick();
    expect(catalog.liveContextWindow('ollama', 'same-model')).toBe(8192);
    settings.ollamaHost = 'http://b:11434';
    expect(catalog.liveContextWindow('ollama', 'same-model')).toBeUndefined();
    await tick();
    expect(catalog.liveContextWindow('ollama', 'same-model')).toBe(32768);
    expect(seen).toEqual(['http://a:11434', 'http://b:11434']);
  });

  test('an older same-host inventory response cannot overwrite a forced refresh', async () => {
    const oldRequest = deferred<Array<{ model: string, label: string }>>();
    const freshRequest = deferred<Array<{ model: string, label: string }>>();
    let calls = 0;
    const { deps } = makeDeps({
      listProviderModels: async () => (++calls === 1 ? oldRequest.promise : freshRequest.promise),
    });
    const catalog = makeModelCatalog(deps);

    const oldResult = catalog.liveProviderModels('ollama');
    const refreshed = catalog.liveProviderModels('ollama', { force: true });
    freshRequest.resolve([{ model: 'fresh', label: 'Fresh' }]);
    expect((await refreshed)?.[0]?.model).toBe('fresh');
    oldRequest.resolve([{ model: 'stale', label: 'Stale' }]);
    expect((await oldResult)?.[0]?.model).toBe('stale');

    expect((await catalog.liveProviderModels('ollama'))?.[0]?.model).toBe('fresh');
    expect(calls).toBe(2);
  });

  test('an unavailable explicit provider stays selected instead of displaying another provider', async () => {
    const { deps } = makeDeps({
      listProviders: () => [
        { name: 'ollama', label: 'Ollama', defaultModel: 'qwen3:8b', keyless: true, liveModels: true },
        { name: 'anthropic', label: 'Anthropic', defaultModel: 'claude', vaultSecretName: 'provider:anthropic' },
      ],
      listProviderModels: async () => null,
      vault: { getSecret: async (name: string) => name === 'provider:anthropic' ? 'key' : null },
    });
    const result = await makeModelCatalog(deps).buildModelOptions();

    expect(result.selected).toBe('ollama::qwen3:8b');
    expect(result.options[0]).toMatchObject({
      value: 'ollama::qwen3:8b',
      unavailable: true,
    });
    expect(result.options.some((option: any) => option.provider === 'anthropic')).toBe(true);
  });
});

describe('local WebGPU models in the chat picker', () => {
  const localDeps = (localModelIds: () => string[]) => makeDeps({
    listProviders: () => [{ name: 'local-webgpu', label: 'Local (WebGPU)', defaultModel: 'gemma-4-e2b', keyless: true }],
    localModelIds,
    localModelLabel: (id: string) => (id === 'gemma-4-e2b' ? 'Gemma 4 E2B' : 'Muse Glimmer 30B'),
    settingsStore: { get: () => ({ providerName: 'local-webgpu', providerModel: '' }) },
    resolveActiveProvider: () => ({ name: 'local-webgpu', model: 'gemma-4-e2b' }),
  }).deps;

  test('offers nothing while no model is downloaded - an un-resident model would fail on the first turn', async () => {
    const { options } = await makeModelCatalog(localDeps(() => [])).buildModelOptions();
    expect(options.filter((o: any) => o.provider === 'local-webgpu' && !o.unavailable)).toEqual([]);
  });

  test('offers exactly the models this machine has downloaded, labelled from the registry', async () => {
    const { options } = await makeModelCatalog(localDeps(() => ['gemma-4-e2b', 'muse-glimmer-30b'])).buildModelOptions();
    expect(options.map((o: any) => o.value)).toEqual(['local-webgpu::gemma-4-e2b', 'local-webgpu::muse-glimmer-30b']);
    expect(options.map((o: any) => o.label)).toEqual(['Gemma 4 E2B', 'Muse Glimmer 30B']);
  });

  test('a non-default model is offered on its own; the uninstalled default survives only as the flagged selection', async () => {
    // The active provider still points at gemma here. It must NOT become a
    // silent catalog entry (it isn't downloaded), but the existing rule stands:
    // an explicit selection stays visible, marked unavailable, because the first
    // send binds to it regardless of what the dropdown shows.
    const { options } = await makeModelCatalog(localDeps(() => ['muse-glimmer-30b'])).buildModelOptions();
    const selectable = options.filter((o: any) => !o.unavailable).map((o: any) => o.value);
    expect(selectable).toEqual(['local-webgpu::muse-glimmer-30b']);
    expect(options.find((o: any) => o.value === 'local-webgpu::gemma-4-e2b')).toMatchObject({ unavailable: true });
  });
});
