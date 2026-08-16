import { describe, expect, test } from 'bun:test';
import { makeScriptModelCallRoute } from '../../extension/background/script-model-call.js';

const makeHarness = () => {
  const calls: string[] = [];
  const signal = new AbortController().signal;
  const deps: any = {
    isOffscreenSender: (sender: unknown) => sender === 'offscreen',
    sessions: { get: async () => ({ kind: 'chat', provider: 'cloud', model: 'model-a', cost: { cost: 0 } }) },
    scriptRuns: {
      ownerFor: () => 'chat', allows: () => true, providerUsageFor: () => ({}),
      signalFor: () => signal,
      recordProviderCall: () => calls.push('admit'),
      settleProviderCall: () => calls.push('settle'),
    },
    validateProviderCallArgs: () => ({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 12 }),
    providerQuotaError: () => null,
    settingsStore: { get: () => ({ spendLimitUsd: null, pricingOverrides: {}, ollamaHost: '' }) },
    limitExceeded: () => false,
    normalizeTally: (value: any) => value,
    listProviders: () => [{ name: 'cloud', keyless: false }],
    hasPricing: () => true,
    contextSnapshots: { record: () => calls.push('snapshot') },
    callModel: async function* () { calls.push('call'); yield { type: 'done' }; },
    getSecret: async () => null,
    safeFetch: async () => new Response(),
    foldProviderEvents: () => ({
      text: 'answer', stopReason: 'end_turn',
      usage: { inputTokens: 2, outputTokens: 3 },
    }),
    costOf: () => ({ cost: 0.01 }),
    foldSessionCost: async () => { calls.push('cost'); },
    auditLog: { append: async () => { calls.push('audit'); } },
  };
  return { route: makeScriptModelCallRoute(deps), deps, calls };
};

describe('script model-call route', () => {
  test('rejects a non-offscreen sender before reading session state', async () => {
    const { route, deps } = makeHarness();
    let reads = 0;
    deps.sessions.get = async () => { reads += 1; return null; };
    expect(await route({ ownerSessionId: 'chat', runId: 'run' }, 'engine-tab'))
      .toEqual({ ok: false, error: 'provider: unauthorized relay' });
    expect(reads).toBe(0);
  });

  test('refuses a dead run before validating worker-controlled arguments', async () => {
    const { route, deps } = makeHarness();
    deps.scriptRuns.ownerFor = () => null;
    let validations = 0;
    deps.validateProviderCallArgs = () => { validations += 1; return {}; };
    expect(await route({ ownerSessionId: 'chat', runId: 'dead' }, 'offscreen'))
      .toEqual({ ok: false, error: 'provider: unknown or finished run' });
    expect(validations).toBe(0);
  });

  test('preserves admission, stream, settlement, cost, and reply shape', async () => {
    const { route, calls } = makeHarness();
    const result = await route({ ownerSessionId: 'chat', runId: 'run', args: {} }, 'offscreen');
    expect(result).toEqual({
      ok: true,
      value: {
        text: 'answer', model: 'model-a', stopReason: 'end_turn',
        usage: { inputTokens: 2, outputTokens: 3 },
      },
    });
    expect(calls).toEqual(['admit', 'snapshot', 'call', 'settle', 'cost', 'audit']);
  });
});
