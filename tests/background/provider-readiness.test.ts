import { describe, expect, test } from 'bun:test';
import { pickUsableProvider, resolveComposerReadiness, resolveDisplayProvider } from '../../extension/background/provider-readiness.js';
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

// The provider SELECTION seam (issue #384). resolveComposerReadiness above is
// always handed a provider, so nothing here used to exercise which provider the
// projection picks - the half where an Ollama-only install deadlocked.
const selectable = [
  { name: 'anthropic', vaultSecretName: 'provider/anthropic' },
  { name: 'openai', vaultSecretName: 'provider/openai' },
  { name: 'ollama', keyless: true, liveModels: true },
  { name: 'local-webgpu', keyless: true },
];

const display = (opts: {
  chosenName?: string, keys?: Record<string, string>,
  localAvailable?: boolean, ollamaCount?: number | null,
  hydrateLocal?: () => Promise<unknown>,
} = {}) => resolveDisplayProvider({
  providers: selectable,
  chosenName: opts.chosenName ?? '',
  getSecret: async (name) => opts.keys?.[name] ?? null,
  localAvailable: () => opts.localAvailable ?? false,
  liveModelCount: async () => (opts.ollamaCount === undefined ? null : opts.ollamaCount),
  hydrateLocal: opts.hydrateLocal,
});

describe('active provider selection for the projection', () => {
  test('an unchosen provider resolves to a reachable Ollama, not unkeyed Anthropic', async () => {
    // The exact #384 report: Ollama connected with 7 models, no key anywhere.
    expect(await display({ ollamaCount: 7 })).toBe('ollama');
  });

  test('an unchosen provider resolves to a resident local model with no daemon', async () => {
    expect(await display({ ollamaCount: 0, localAvailable: true })).toBe('local-webgpu');
  });

  test('a keyless provider that is merely present is not usable', async () => {
    // Presence is not readiness: no daemon models and no downloaded weights.
    expect(await display({ ollamaCount: 0, localAvailable: false })).toBe('');
    expect(await display({ ollamaCount: null, localAvailable: false })).toBe('');
  });

  test('a keyed provider still wins by registry order when it has a key', async () => {
    expect(await display({ keys: { 'provider/anthropic': 'k' }, ollamaCount: 7 })).toBe('anthropic');
    expect(await display({ keys: { 'provider/openai': 'k' }, ollamaCount: 7 })).toBe('openai');
  });

  test("an explicit choice is never second-guessed, so its own model survives", async () => {
    // '' means "no override" - the caller reads settings, keeping providerModel.
    expect(await display({ chosenName: 'openai', ollamaCount: 7 })).toBe('');
  });

  test('an unregistered stored provider is re-picked rather than honoured', async () => {
    expect(await display({ chosenName: 'removed-adapter', ollamaCount: 7 })).toBe('ollama');
  });

  test('local availability is hydrated BEFORE it is read, only when unchosen', async () => {
    let available = false;
    let hydrated = 0;
    const hydrateLocal = async () => { hydrated += 1; available = true; };
    const resolved = await resolveDisplayProvider({
      providers: selectable,
      chosenName: '',
      getSecret: async () => null,
      localAvailable: () => available,
      liveModelCount: async () => 0,
      hydrateLocal,
    });
    expect(resolved).toBe('local-webgpu');
    expect(hydrated).toBe(1);
    // An explicit choice must not pay for the probe at all.
    await display({ chosenName: 'ollama', hydrateLocal });
    expect(hydrated).toBe(1);
  });

  test('a vault that throws leaves the provider unusable rather than selected', async () => {
    expect(await resolveDisplayProvider({
      providers: selectable,
      chosenName: '',
      getSecret: async () => { throw new Error('locked'); },
      localAvailable: () => false,
      liveModelCount: async () => 0,
    })).toBe('');
  });

  test('the binder and the projection share one ordering rule', async () => {
    // pickUsableProvider is what ensureActiveProvider persists from; if these
    // two ever diverge, the composer gates on a provider the binder rejects.
    const shared = await pickUsableProvider({
      providers: selectable,
      getSecret: async () => null,
      localModelAvailable: false,
      liveModelCount: async () => 7,
    });
    expect(shared).toBe('ollama');
    expect(await display({ ollamaCount: 7 })).toBe(shared ?? '');
  });
});
