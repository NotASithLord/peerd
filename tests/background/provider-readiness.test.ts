import { describe, expect, test } from 'bun:test';
import { resolveComposerReadiness } from '../../extension/background/provider-readiness.js';
import { composerUnavailableCopy } from '../../extension/sidepanel/provider-readiness.js';

const providers = [
  { name: 'anthropic', vaultSecretName: 'provider/anthropic' },
  { name: 'openai', vaultSecretName: 'provider/openai' },
  { name: 'ollama', keyless: true },
  { name: 'local-webgpu', keyless: true },
];

const readiness = (provider: string, opts: {
  keys?: Record<string, string>, localModelAvailable?: boolean, settingsAvailable?: boolean,
  model?: string,
  ollamaModels?: { known?: boolean, reachable?: boolean|null, count?: number|null, models?: string[]|null },
} = {}) => resolveComposerReadiness({
  provider,
  model: opts.model ?? 'model',
  providers,
  getSecret: async (name) => opts.keys?.[name] ?? null,
  localModelAvailable: opts.localModelAvailable ?? false,
  ollamaModels: opts.ollamaModels,
  settingsAvailable: opts.settingsAvailable,
});

describe('composer provider readiness', () => {
  test('a keyed provider is ready only when its own credential exists', async () => {
    expect((await readiness('anthropic', {
      keys: { 'provider/anthropic': 'secret' },
    })).canSend).toBe(true);
    expect(await readiness('anthropic')).toMatchObject({
      canSend: false,
      credentialReady: false,
      reason: 'missing-key',
    });
  });

  test('Ollama is structurally sendable without treating network reachability as sticky state', async () => {
    expect(await readiness('ollama')).toMatchObject({
      keyless: true,
      credentialReady: true,
      canSend: true,
      reason: null,
    });
  });

  test('a confirmed zero-model Ollama is blocked with a recovery-specific reason', async () => {
    expect(await readiness('ollama', {
      ollamaModels: { known: true, reachable: true, count: 0 },
    })).toMatchObject({
      ollamaReady: false,
      canSend: false,
      reason: 'ollama-no-models',
    });
  });

  test('a selected Ollama model must exist, with untagged names matching latest', async () => {
    expect(await readiness('ollama', {
      model: 'missing',
      ollamaModels: { known: true, reachable: true, count: 1, models: ['installed:latest'] },
    })).toMatchObject({ canSend: false, reason: 'ollama-model-missing' });
    expect(await readiness('ollama', {
      model: 'installed',
      ollamaModels: { known: true, reachable: true, count: 1, models: ['installed:latest'] },
    })).toMatchObject({ canSend: true, reason: null });
  });

  test('an unreachable Ollama remains retryable but carries an honest warning', async () => {
    expect(await readiness('ollama', {
      ollamaModels: { known: true, reachable: false, count: null, models: null },
    })).toMatchObject({ canSend: true, reason: null, warning: 'ollama-unreachable' });
  });

  test('Local WebGPU requires an installed or cached model', async () => {
    expect(await readiness('local-webgpu')).toMatchObject({
      canSend: false,
      localReady: false,
      reason: 'local-model-not-installed',
    });
    expect((await readiness('local-webgpu', { localModelAvailable: true })).canSend).toBe(true);
  });

  test('unconfirmed settings never masquerade as a missing API key', async () => {
    expect(await readiness('anthropic', { settingsAvailable: false })).toMatchObject({
      canSend: false,
      reason: 'settings-unavailable',
    });
  });

  test('a locked vault asks for unlock instead of an API key', () => {
    const composer = { provider: 'ollama', reason: 'vault-locked' };
    expect(composerUnavailableCopy(composer, { compact: true }))
      .toBe('Vault is locked. Unlock it to send.');
    expect(composerUnavailableCopy(composer))
      .toBe('Vault is locked. Unlock it to start chatting.');
  });
});
