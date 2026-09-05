import { describe, expect, test } from 'bun:test';
import { makeKernelProviderSetKeyRoute } from '../../extension/background/kernel-provider-key-route.js';
import { PROVIDER_EGRESS_MANIFEST } from '../../extension/background/provider-egress-manifest.js';
import {
  PROVIDER_METADATA,
  listProviderMetadata,
} from '../../extension/peerd-provider/metadata.js';
import { listProviders } from '../../extension/peerd-provider/registry.js';

describe('provider authority manifest', () => {
  test('keeps document UI metadata identical to the executable provider registry', () => {
    expect(JSON.stringify(listProviderMetadata())).toBe(JSON.stringify(listProviders()));
  });

  test('pins every semantic provider to one compact authority entry', () => {
    expect(Object.keys(PROVIDER_EGRESS_MANIFEST)).toEqual(
      listProviderMetadata().map((provider) => provider.name),
    );
    expect(Object.fromEntries(Object.entries(PROVIDER_EGRESS_MANIFEST)
      .map(([name, policy]) => [name, policy.credential]))).toEqual({
      anthropic: 'anthropic_api_key',
      openrouter: 'openrouter_api_key',
      openai: 'openai_api_key',
      glm: 'glm_api_key',
      ollama: null,
      'local-webgpu': null,
    });
  });

  test('keeps controller metadata free of endpoints and credential authority', () => {
    expect(JSON.stringify(PROVIDER_METADATA)).not.toMatch(
      /https?:|secret|credential|authorization|api[_-]?key/i,
    );
    expect(Object.values(PROVIDER_EGRESS_MANIFEST)
      .map((policy) => policy.inferenceUrl)).toEqual([
      'https://api.anthropic.com/v1/messages',
      'https://openrouter.ai/api/v1/chat/completions',
      'https://api.openai.com/v1/chat/completions',
      'https://api.z.ai/api/paas/v4/chat/completions',
      null,
      null,
    ]);
  });
});

describe('provider key custody', () => {
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
    expect(h.pushed()).toBe(1);
  });

  test('refuses unknown, keyless, and short inputs before storage', async () => {
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

  test('an exact replay does not rewrite or re-audit an existing key', async () => {
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

  test('marks failures after a possible secret mutation as outcome unknown', async () => {
    const afterCommit = harness({
      settingsStore: {
        get: () => ({ providerName: 'openai' }),
        update: async () => { throw new Error('settings receipt lost'); },
      },
    });
    await expect(afterCommit.route({ provider: 'anthropic', plaintext: 'sk-ant-valid' }))
      .rejects.toMatchObject({ message: 'settings receipt lost', outcomeKnown: false });
    expect(afterCommit.stored).toHaveLength(1);

    const ambiguousSecret = harness({
      vault: {
        isLocked: () => false,
        getSecret: async () => null,
        setSecret: async () => { throw new Error('secret receipt lost'); },
      },
    });
    await expect(ambiguousSecret.route({ provider: 'anthropic', plaintext: 'sk-ant-valid' }))
      .rejects.toMatchObject({ message: 'secret receipt lost', outcomeKnown: false });
  });

  test('maps a known pre-commit vault refusal without claiming mutation', async () => {
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
});
