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
      localModelId: 'local-model',
      localModelAvailable: () => false,
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
