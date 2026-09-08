import { describe, expect, test } from 'bun:test';
import {
  createKernelProviderProjection,
} from '../../extension/background/kernel-provider-projection.js';
import { routes as controllerLocalRoutes } from '../../extension/offscreen/kernel-local-host.js';

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
    projectSemantic: overrides.projectSemantic ?? (async (snapshot: any) =>
      controllerLocalRoutes['models/state-projection'](snapshot)),
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

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
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

  test('coalesces identical first-paint projections during unlock', async () => {
    let projectCalls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lane = makeProjection({
      projectSemantic: async (snapshot: any) => {
        projectCalls += 1;
        await held;
        return controllerLocalRoutes['models/state-projection'](snapshot);
      },
    });
    const first = lane.projection.view();
    const second = lane.projection.view();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(projectCalls).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      await first, await first,
    ]);
  });

  test('cold reads share one async refresh and reuse only its exact settled view', async () => {
    let projectCalls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lane = makeProjection({
      projectSemantic: async (snapshot: any) => {
        projectCalls += 1;
        await held;
        return controllerLocalRoutes['models/state-projection'](snapshot);
      },
    });
    lane.projection.observeLocked(false);
    expect(await lane.projection.peek({ provider: 'anthropic', model: 'one' })).toBeNull();
    expect(await lane.projection.peek({ provider: 'anthropic', model: 'one' })).toBeNull();
    await flush();
    expect(projectCalls).toBe(1);
    release();
    await flush();
    expect(lane.pushes).toEqual(['state']);
    expect(await lane.projection.peek({ provider: 'anthropic', model: 'one' })).toMatchObject({
      composer: { provider: 'anthropic', model: 'one' },
    });
    expect(projectCalls).toBe(1);
  });

  test('locked reads never start semantic refresh and stale unlock work never publishes', async () => {
    let projectCalls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lane = makeProjection({
      projectSemantic: async (snapshot: any) => {
        projectCalls += 1;
        await held;
        return controllerLocalRoutes['models/state-projection'](snapshot);
      },
    });
    expect(await lane.projection.peek(null, true)).toBeNull();
    expect(await lane.projection.peek()).toBeNull();
    expect(projectCalls).toBe(0);

    lane.projection.observeLocked(false);
    expect(await lane.projection.peek()).toBeNull();
    await flush();
    expect(projectCalls).toBe(1);
    lane.projection.observeLocked(true);
    release();
    await flush();
    expect(lane.pushes).toEqual([]);
    expect(await lane.projection.peek(null, true)).toBeNull();
    expect(projectCalls).toBe(1);
  });

  test('lock and unlock while the same snapshot is in flight starts fresh authority work', async () => {
    const releases: Array<() => void> = [];
    let projectCalls = 0;
    const lane = makeProjection({
      projectSemantic: async (snapshot: any) => {
        projectCalls += 1;
        await new Promise<void>((resolve) => { releases.push(resolve); });
        return controllerLocalRoutes['models/state-projection'](snapshot);
      },
    });
    lane.projection.observeLocked(false);
    expect(await lane.projection.peek()).toBeNull();
    await flush();
    expect(projectCalls).toBe(1);

    lane.projection.observeLocked(true);
    lane.projection.observeLocked(false);
    expect(await lane.projection.peek()).toBeNull();
    releases[0]();
    await flush();
    expect(projectCalls).toBe(2);
    expect(lane.pushes).toEqual([]);
    releases[1]();
    await flush();
    expect(lane.pushes).toEqual(['state']);
    expect(await lane.projection.peek()).toMatchObject({
      providers: { current: 'anthropic' },
    });
  });

  test('config changes reject stale completion and refresh the new exact snapshot', async () => {
    const releases: Array<() => void> = [];
    let projectCalls = 0;
    const lane = makeProjection({
      projectSemantic: async (snapshot: any) => {
        projectCalls += 1;
        await new Promise<void>((resolve) => { releases.push(resolve); });
        return controllerLocalRoutes['models/state-projection'](snapshot);
      },
    });
    lane.projection.observeLocked(false);
    expect(await lane.projection.peek()).toBeNull();
    await flush();
    lane.setSettings({
      providerName: 'openrouter', providerModel: 'new/model',
      ollamaHost: 'http://localhost:11434',
    });
    lane.projection.bumpRevision();
    releases[0]();
    await flush();
    expect(lane.pushes).toEqual([]);

    expect(await lane.projection.peek()).toBeNull();
    await flush();
    expect(projectCalls).toBe(2);
    releases[1]();
    await flush();
    expect(lane.pushes).toEqual(['state']);
    expect(await lane.projection.peek()).toMatchObject({
      providers: { current: 'openrouter', model: 'new/model' },
    });
  });

  test('failed async refresh is not cached and retries on the next state read', async () => {
    let projectCalls = 0;
    const lane = makeProjection({
      projectSemantic: async (snapshot: any) => {
        projectCalls += 1;
        if (projectCalls === 1) throw new Error('controller-lost');
        return controllerLocalRoutes['models/state-projection'](snapshot);
      },
    });
    lane.projection.observeLocked(false);
    expect(await lane.projection.peek()).toBeNull();
    await flush();
    expect(projectCalls).toBe(1);
    expect(lane.pushes).toEqual([]);
    expect(await lane.projection.peek()).toBeNull();
    await flush();
    expect(projectCalls).toBe(2);
    expect(lane.pushes).toEqual(['state']);
    expect(await lane.projection.peek()).toMatchObject({
      providers: { current: 'anthropic' },
    });
  });

  test('resolved controller refusals are not cached or published and a valid retry succeeds', async () => {
    let projectCalls = 0;
    const lane = makeProjection({
      projectSemantic: async (snapshot: any) => {
        projectCalls += 1;
        if (projectCalls === 1) return {
          ok: false,
          code: 'kernel-feature-local-owner-unavailable',
          outcomeKnown: true,
        };
        return controllerLocalRoutes['models/state-projection'](snapshot);
      },
    });
    lane.projection.observeLocked(false);
    expect(await lane.projection.peek()).toBeNull();
    await flush();
    expect(projectCalls).toBe(1);
    expect(lane.pushes).toEqual([]);
    expect(await lane.projection.peek()).toBeNull();
    await flush();
    expect(projectCalls).toBe(2);
    expect(lane.pushes).toEqual(['state']);
    expect(await lane.projection.peek()).toMatchObject({
      providers: { current: 'anthropic' },
    });
  });

  test('direct projections reject a resolved refusal', async () => {
    const lane = makeProjection({
      projectSemantic: async () => ({
        ok: false,
        code: 'kernel-feature-local-owner-unavailable',
        outcomeKnown: true,
      }),
    });
    await expect(lane.projection.view()).rejects
      .toThrow('kernel-provider-semantic-projection-invalid');
  });

  test('settled projection cache stays bounded and does not reuse another session snapshot', async () => {
    let projectCalls = 0;
    const lane = makeProjection({
      projectSemantic: async (snapshot: any) => {
        projectCalls += 1;
        return controllerLocalRoutes['models/state-projection'](snapshot);
      },
    });
    lane.projection.observeLocked(false);
    for (let index = 0; index < 9; index += 1) {
      await lane.projection.view({ provider: 'anthropic', model: `model-${index}` });
    }
    expect(projectCalls).toBe(9);
    await lane.projection.view({ provider: 'anthropic', model: 'model-0' });
    expect(projectCalls).toBe(10);
    await lane.projection.view({ provider: 'anthropic', model: 'model-8' });
    expect(projectCalls).toBe(10);
  });
});
