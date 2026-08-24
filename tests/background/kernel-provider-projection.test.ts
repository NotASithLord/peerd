import { describe, expect, test } from 'bun:test';
import {
  createKernelProviderProjection,
} from '../../extension/background/kernel-provider-projection.js';

const makeProjection = (overrides: Record<string, any> = {}) => {
  let settings = overrides.settings ?? {
    providerName: 'anthropic', providerModel: '', ollamaHost: 'http://localhost:11434',
  };
  const reads: string[] = [];
  const pushes: string[] = [];
  const projection = createKernelProviderProjection({
    settingsStore: { get: () => settings },
    vault: {
      getSecret: async (name: string) => {
        reads.push(name);
        return overrides.secrets?.[name] ?? null;
      },
    },
    browser: { storage: { local: { get: async () => overrides.local ?? {} } } },
    localModels: overrides.localModels ?? true,
    pushState: () => { pushes.push('state'); },
  });
  return {
    projection,
    pushes,
    reads,
    setSettings: (next: Record<string, any>) => { settings = next; },
  };
};

describe('cold kernel provider/composer projection', () => {
  test('cloud readiness is bound to the selected provider credential', async () => {
    const missing = makeProjection();
    expect(await missing.projection.view()).toMatchObject({
      providers: { current: 'anthropic', hasKey: false },
      composer: {
        provider: 'anthropic', credentialReady: false,
        canSend: false, reason: 'missing-key',
      },
    });

    const keyed = makeProjection({ secrets: { anthropic_api_key: 'secret' } });
    expect(await keyed.projection.view()).toMatchObject({
      providers: { current: 'anthropic', hasKey: true },
      composer: {
        provider: 'anthropic', credentialReady: true,
        canSend: true, reason: null,
      },
    });
  });

  test('session provider and model remain independent from future defaults', async () => {
    const { projection } = makeProjection({
      secrets: { openrouter_api_key: 'secret' },
    });
    expect(await projection.view({ provider: 'openrouter', model: 'bound/model' })).toMatchObject({
      providers: { current: 'anthropic', hasKey: false },
      composer: {
        provider: 'openrouter', model: 'bound/model',
        credentialReady: true, canSend: true, reason: null,
      },
    });
  });

  test('Ollama inventory distinguishes zero, missing, ready, stale, and unreachable', async () => {
    const lane = makeProjection({
      settings: {
        providerName: 'ollama', providerModel: 'wanted:latest',
        ollamaHost: 'http://one.local:11434',
      },
    });
    expect((await lane.projection.view()).composer).toMatchObject({
      canSend: true, reason: null, warning: null,
    });

    lane.projection.observeOllamaStatus({
      known: true, reachable: true, count: 0, models: [],
    });
    expect((await lane.projection.view()).composer).toMatchObject({
      ollamaReady: false, canSend: false, reason: 'ollama-no-models',
    });

    lane.projection.observeOllamaStatus({
      known: true, reachable: true, count: 1, models: ['other:latest'],
    });
    expect((await lane.projection.view()).composer).toMatchObject({
      ollamaReady: false, canSend: false, reason: 'ollama-model-missing',
    });

    lane.projection.observeOllamaStatus({
      known: true, reachable: true, count: 1, models: ['wanted:latest'],
    });
    expect((await lane.projection.view()).composer).toMatchObject({
      ollamaReady: true, canSend: true, reason: null, warning: null,
    });

    lane.setSettings({
      providerName: 'ollama', providerModel: 'wanted:latest',
      ollamaHost: 'http://two.local:11434',
    });
    expect((await lane.projection.view()).composer).toMatchObject({
      canSend: true, reason: null, warning: null,
    });

    lane.projection.observeOllamaStatus({
      known: true, reachable: false, count: null, models: null,
    });
    expect((await lane.projection.view()).composer).toMatchObject({
      ollamaReady: true, canSend: true, reason: null, warning: 'ollama-unreachable',
    });
    expect(lane.pushes).toHaveLength(4);
    expect((await lane.projection.view()).providers.configRevision).toBe(4);
  });

  test('locked posture wins without reading a provider secret', async () => {
    const lane = makeProjection({ secrets: { anthropic_api_key: 'secret' } });
    expect(await lane.projection.view(null, true)).toMatchObject({
      providers: { current: 'anthropic', hasKey: false },
      composer: {
        credentialReady: false, canSend: false, reason: 'vault-locked',
      },
    });
    expect(lane.reads).toEqual([]);
  });
});
