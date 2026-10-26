import { describe, expect, test } from 'bun:test';
import {
  configureOm2wProvider, launchOm2wBrowser, resolveOm2wProviderConfig,
} from '../../scripts/cdp/om2w/provider-config.mjs';

describe('Online-Mind2Web provider setup', () => {
  test('a real local run configures its endpoint without registering any cloud key', async () => {
    const config = resolveOm2wProviderConfig({
      provider: 'ollama', model: 'local-browser-policy', ollamaHost: 'http://127.0.0.1:11435/',
      env: { PEERD_BENCH_KEY: 'must-not-leave-env', ANTHROPIC_API_KEY: 'also-private' },
    });
    const sent: any[] = [];
    await configureOm2wProvider(async (message) => { sent.push(message); return { ok: true }; }, config, 'tools');
    expect(config.key).toBe('');
    expect(sent).toEqual([{
      type: 'settings/update', patch: {
        providerName: 'ollama', providerModel: 'local-browser-policy',
        ollamaHost: 'http://127.0.0.1:11435', webActorActionSurface: 'tools',
      },
    }]);
    expect(JSON.stringify(sent)).not.toContain('private');
  });

  test('provider keys do not cross provider boundaries', async () => {
    expect(() => resolveOm2wProviderConfig({
      provider: 'openrouter', env: { ANTHROPIC_API_KEY: 'wrong-provider-key' },
    })).toThrow('no openrouter key');
    const config = resolveOm2wProviderConfig({
      provider: 'openrouter', env: { ANTHROPIC_API_KEY: 'wrong-provider-key', OPENROUTER_API_KEY: 'right-key' },
    });
    const sent: any[] = [];
    await configureOm2wProvider(async (message) => { sent.push(message); return { ok: true }; }, config);
    expect(sent[0]).toEqual({ type: 'provider/setKey', provider: 'openrouter', plaintext: 'right-key' });
    expect(sent[1]).toEqual({ type: 'settings/update', patch: { providerName: 'openrouter' } });
  });

  test('chat and web actor models are configured independently for a local comparison', async () => {
    const config = resolveOm2wProviderConfig({
      provider: 'ollama', model: 'qwen3.5:2b-q4_K_M', runnerModel: ' peerd-local-browser ',
    });
    const sent: any[] = [];
    await configureOm2wProvider(async (message) => { sent.push(message); return { ok: true }; }, config, 'tools');
    expect(sent).toEqual([{
      type: 'settings/update', patch: {
        providerName: 'ollama', providerModel: 'qwen3.5:2b-q4_K_M',
        runnerModel: 'peerd-local-browser', webActorActionSurface: 'tools',
      },
    }]);
    expect(resolveOm2wProviderConfig({ provider: 'ollama', runnerModel: ' ' }).settingsPatch)
      .not.toHaveProperty('runnerModel');
  });

  test('local inference requires no credentials, but unsupported WebGPU initialization is explicit', () => {
    expect(resolveOm2wProviderConfig({ provider: 'ollama' }).keyless).toBe(true);
    expect(resolveOm2wProviderConfig({ provider: 'ollama', smoke: true }).keyless).toBe(true);
    expect(() => resolveOm2wProviderConfig({ provider: 'anthropic' })).toThrow('no anthropic key');
    expect(() => resolveOm2wProviderConfig({ provider: 'local-webgpu' })).toThrow('fresh-profile driver does not initialize');
    expect(() => resolveOm2wProviderConfig({ provider: 'anthropic', smoke: true })).toThrow('--smoke uses');
  });

  test('endpoint errors fail before Chrome launches, rather than silently selecting a different origin', () => {
    for (const ollamaHost of [
      'file:///tmp/weights', 'http://user:secret@localhost:11434',
      'http://localhost:11434/v1', 'http://localhost:11434/?x=1', 'http://localhost:11434/#x',
      'not a url',
    ]) {
      expect(() => resolveOm2wProviderConfig({ provider: 'ollama', ollamaHost })).toThrow('--ollama-host');
    }
    expect(() => resolveOm2wProviderConfig({ provider: 'anthropic', ollamaHost: 'http://localhost:11434' })).toThrow('requires --provider=ollama');
  });

  test('a refused settings update cannot be mislabeled as a configured benchmark run', async () => {
    await expect(configureOm2wProvider(async () => ({ ok: false, error: 'refused' }),
      resolveOm2wProviderConfig({ provider: 'ollama' }))).rejects.toThrow('settings/update failed');
  });

  test('real runs explicitly disable the harness wire fixture and smoke runs require it', async () => {
    const calls: any[] = [];
    const launch = async (options: any) => { calls.push(options); return 'browser'; };
    expect(await launchOm2wBrowser(launch, {})).toBe('browser');
    expect(calls[0]).toEqual({ interceptModel: false });
    const modelResponder = () => ({ sse: 'scripted smoke' });
    expect(await launchOm2wBrowser(launch, { smoke: true, modelResponder })).toBe('browser');
    expect(calls[1]).toEqual({ interceptModel: true, modelResponder });
    expect(() => launchOm2wBrowser(launch, { smoke: true })).toThrow('requires an explicit');
    expect(() => launchOm2wBrowser(launch, { modelResponder })).toThrow('real benchmark runs');
    expect(calls).toHaveLength(2);
  });
});
