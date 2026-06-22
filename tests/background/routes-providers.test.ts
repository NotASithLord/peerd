import { describe, test, expect } from 'bun:test';
import { makeProviderRoutes } from '../../extension/background/routes/providers.js';

class ProviderHttpError extends Error { status: number; constructor(s: number) { super(`http ${s}`); this.status = s; } }
class ProviderKeyMissingError extends Error {}
class VaultLockedError extends Error {}

const baseDeps = (over: Record<string, any> = {}) => ({
  vault: {
    getSecret: async (_n: string) => 'sk-abc',
    setSecret: async () => {},
  },
  auditLog: { append: async () => {} },
  pushState: () => {},
  listProviders: () => [
    { name: 'anthropic', label: 'Anthropic', defaultModel: 'claude', vaultSecretName: 'anthropic.key' },
    { name: 'ollama', label: 'Ollama', defaultModel: 'llama', keyless: true, liveModels: true },
  ],
  listProviderModels: async () => [{ model: 'a' }, { model: 'b' }],
  listOpenRouterModels: async () => [{ model: 'x' }],
  OPENROUTER_POPULAR: ['p'],
  callModel: async function* () { yield { type: 'delta', text: 'hi' }; },
  getSecret: async () => 'sk-abc',
  safeFetch: async () => new Response('{}'),
  secretNameForProvider: (n: string) => `${n}.key`,
  maskKey: (k: string) => `masked(${k.length})`,
  buildModelOptions: async () => ({ options: [{ value: 'anthropic::claude' }], selected: 'anthropic::claude', sessionProvider: null }),
  ProviderHttpError, ProviderKeyMissingError, VaultLockedError,
  ...over,
});

describe('provider/test', () => {
  test('keyless live provider: counts models from the daemon', async () => {
    const r = makeProviderRoutes(baseDeps());
    expect(await r['provider/test']({ provider: 'ollama' })).toEqual({ ok: true, models: 2 });
  });
  test('keyless daemon unreachable → error message', async () => {
    const r = makeProviderRoutes(baseDeps({ listProviderModels: async () => { throw new Error('ECONNREFUSED'); } }));
    expect(await r['provider/test']({ provider: 'ollama' })).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });
  test('keyed provider: vault locked → locked', async () => {
    const r = makeProviderRoutes(baseDeps({ vault: { getSecret: async () => { throw new Error('locked'); } } }));
    expect(await r['provider/test']({ provider: 'anthropic' })).toEqual({ ok: false, error: 'locked' });
  });
  test('keyed provider: no key → no-key', async () => {
    const r = makeProviderRoutes(baseDeps({ vault: { getSecret: async () => null } }));
    expect(await r['provider/test']({ provider: 'anthropic' })).toEqual({ ok: false, error: 'no-key' });
  });
  test('successful 1-token ping → ok', async () => {
    const r = makeProviderRoutes(baseDeps());
    expect(await r['provider/test']({ provider: 'anthropic' })).toEqual({ ok: true });
  });
  test('401 from model → invalid-key', async () => {
    const r = makeProviderRoutes(baseDeps({ callModel: async function* () { throw new ProviderHttpError(401); } }));
    expect(await r['provider/test']({ provider: 'anthropic' })).toEqual({ ok: false, error: 'invalid-key' });
  });
  test('non-401 http → http-<status>', async () => {
    const r = makeProviderRoutes(baseDeps({ callModel: async function* () { throw new ProviderHttpError(500); } }));
    expect(await r['provider/test']({ provider: 'anthropic' })).toEqual({ ok: false, error: 'http-500' });
  });
  test('stream error event → test-failed message', async () => {
    const r = makeProviderRoutes(baseDeps({ callModel: async function* () { yield { type: 'error', error: 'bad' }; } }));
    expect(await r['provider/test']({ provider: 'anthropic' })).toEqual({ ok: false, error: 'bad' });
  });
});

describe('provider/status', () => {
  test('keyless provider always ready, keyed shows masked preview', async () => {
    const r = makeProviderRoutes(baseDeps());
    const res = await r['provider/status']();
    expect(res.ok).toBe(true);
    const anthropic = res.providers.find((p: any) => p.name === 'anthropic');
    const ollama = res.providers.find((p: any) => p.name === 'ollama');
    expect(anthropic).toMatchObject({ hasKey: true, keyless: false, keyPreview: 'masked(6)' });
    expect(ollama).toMatchObject({ hasKey: true, keyless: true, keyPreview: null });
  });
  test('keyed provider with no key → hasKey false, null preview', async () => {
    const r = makeProviderRoutes(baseDeps({ vault: { getSecret: async () => null } }));
    const res = await r['provider/status']();
    expect(res.providers.find((p: any) => p.name === 'anthropic')).toMatchObject({ hasKey: false, keyPreview: null });
  });
});

describe('provider/setKey', () => {
  test('unknown provider rejected', async () => {
    const r = makeProviderRoutes(baseDeps());
    expect(await r['provider/setKey']({ provider: 'nope', plaintext: 'longenough' })).toEqual({ ok: false, error: 'unknown-provider' });
  });
  test('keyless provider rejected', async () => {
    const r = makeProviderRoutes(baseDeps());
    expect(await r['provider/setKey']({ provider: 'ollama', plaintext: 'longenough' })).toEqual({ ok: false, error: 'keyless-provider' });
  });
  test('short key rejected (after trim)', async () => {
    const r = makeProviderRoutes(baseDeps());
    expect(await r['provider/setKey']({ provider: 'anthropic', plaintext: '  ab  ' })).toEqual({ ok: false, error: 'key-too-short' });
  });
  test('valid key stored (trimmed) + state pushed', async () => {
    let stored: any; let pushed = false;
    const r = makeProviderRoutes(baseDeps({
      vault: { setSecret: async (name: string, key: string) => { stored = { name, key }; } },
      pushState: () => { pushed = true; },
    }));
    expect(await r['provider/setKey']({ provider: 'anthropic', plaintext: '  sk-abcdefgh  ' })).toEqual({ ok: true });
    expect(stored).toEqual({ name: 'anthropic.key', key: 'sk-abcdefgh' });
    expect(pushed).toBe(true);
  });
  test('vault locked → locked', async () => {
    const r = makeProviderRoutes(baseDeps({ vault: { setSecret: async () => { throw new VaultLockedError(); } } }));
    expect(await r['provider/setKey']({ provider: 'anthropic', plaintext: 'sk-abcdefgh' })).toEqual({ ok: false, error: 'locked' });
  });
});

describe('models/options + openrouter/models', () => {
  test('models/options passes through buildModelOptions', async () => {
    const r = makeProviderRoutes(baseDeps());
    expect(await r['models/options']({})).toEqual({ ok: true, options: [{ value: 'anthropic::claude' }], selected: 'anthropic::claude', sessionProvider: null });
  });
  test('openrouter/models 401 → invalid-key', async () => {
    const r = makeProviderRoutes(baseDeps({ listOpenRouterModels: async () => { throw new ProviderHttpError(401); } }));
    expect(await r['openrouter/models']()).toEqual({ ok: false, status: 401, error: 'invalid-key' });
  });
});
