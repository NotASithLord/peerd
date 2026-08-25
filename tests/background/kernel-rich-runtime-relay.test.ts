import { describe, expect, test } from 'bun:test';

import { createKernelRichEffectAuthority } from '../../extension/background/kernel-rich-effect-authority.js';
import { createScriptRunRegistry } from '../../extension/background/script-runs.js';
import { dispatchKernelRichRelay } from '../../extension/offscreen/kernel-rich-relay-host.js';

const effects = (call: (operation: string, payload: any) => Promise<any>) => ({
  effects: {
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 30_000,
    call,
  },
});

const admitProjection = {
  token: 'reservation-token-1234',
  owner: { provider: 'anthropic', model: 'claude-test', cost: { cost: 0 } },
  settings: { spendLimitUsd: null, pricingOverrides: {}, ollamaHost: '' },
};

describe('sealed rich relay host', () => {
  test('owns provider call validation, selection, and legacy result shaping', async () => {
    const calls: Array<[string, any]> = [];
    const result = await dispatchKernelRichRelay({
      route: 'script/model-call',
      message: {
        type: 'script/model-call', ownerSessionId: 'session:1', runId: 'run:1',
        args: { prompt: 'hello', maxTokens: 12 }, deadlineAt: Date.now() + 30_000,
      },
    }, effects(async (operation, payload) => {
      calls.push([operation, payload]);
      if (operation === 'rich.script.admit') {
        return { ok: true, outcomeKnown: true, value: admitProjection };
      }
      return {
        ok: true, outcomeKnown: true,
        value: {
          text: 'world', stopReason: 'end_turn',
          usage: { inputTokens: 2, outputTokens: 3 }, cost: 0.01,
        },
      };
    }));
    expect(result).toEqual({
      ok: true, outcomeKnown: true,
      value: {
        ok: true,
        value: {
          text: 'world', model: 'claude-test', stopReason: 'end_turn',
          usage: { inputTokens: 2, outputTokens: 3 },
        },
      },
    });
    expect(calls.map(([operation]) => operation)).toEqual([
      'rich.script.admit', 'rich.model.call',
    ]);
    expect(calls[1]?.[1]).toMatchObject({
      token: admitProjection.token,
      provider: 'anthropic', model: 'claude-test',
      system: '', messages: [{ role: 'user', content: 'hello' }], maxTokens: 12,
    });
  });

  test('refuses malformed and unknown calls before any effect', async () => {
    let called = 0;
    const context = effects(async () => { called += 1; return {}; });
    await expect(dispatchKernelRichRelay({
      route: 'script/model-call',
      message: {
        ownerSessionId: 'session:1', runId: 'run:1',
        args: { prompt: 'x', tools: [] },
      },
    }, context)).resolves.toMatchObject({
      ok: true,
      value: { ok: false, error: expect.stringContaining('unsupported arg') },
    });
    await expect(dispatchKernelRichRelay({ route: 'page/call', message: {} }, context))
      .resolves.toMatchObject({ ok: false, code: 'runtime-rich-relay-invalid' });
    expect(called).toBe(0);
  });

  test('propagates an unknown post-admission outcome and rejects forged effect values', async () => {
    let calls = 0;
    const result = await dispatchKernelRichRelay({
      route: 'script/model-call',
      message: { ownerSessionId: 'session:1', runId: 'run:1', args: { prompt: 'x' } },
    }, effects(async () => {
      calls += 1;
      if (calls === 1) return { ok: true, outcomeKnown: true, value: admitProjection };
      return { ok: true, outcomeKnown: true, value: { text: 'forged', usage: null, cost: NaN } };
    }));
    expect(result).toMatchObject({
      ok: false, code: 'runtime-rich-model-result-invalid', outcomeKnown: false,
    });
  });

  test('routes abort through the kernel-owned Stop signal', async () => {
    const calls: any[] = [];
    const result = await dispatchKernelRichRelay({
      route: 'script-run/abort',
      message: { ownerSessionId: 'session:1', runId: 'run:1' },
    }, effects(async (operation, payload) => {
      calls.push([operation, payload]);
      return { ok: true, outcomeKnown: true };
    }));
    expect(result).toEqual({ ok: true, outcomeKnown: true, value: { ok: true } });
    expect(calls).toEqual([[
      'rich.script.abort', { ownerSessionId: 'session:1', runId: 'run:1' },
    ]]);
  });

  test('preserves provider-error usage in the model-facing result', async () => {
    const result = await dispatchKernelRichRelay({
      route: 'script/model-call',
      message: {
        ownerSessionId: 'session:1', runId: 'run:1',
        args: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 32 },
      },
    }, effects(async (operation) => operation === 'rich.script.admit' ? {
      ok: true, outcomeKnown: true,
      value: {
        token: 'reservation-token-1234',
        owner: { provider: 'anthropic', model: 'claude-test', cost: { cost: 0 } },
        settings: { spendLimitUsd: null, pricingOverrides: {}, ollamaHost: '' },
      },
    } : {
      ok: true, outcomeKnown: true,
      value: {
        text: '', usage: { inputTokens: 4, outputTokens: 5 }, cost: 0.25,
        error: 'provider refused',
      },
    }));
    expect(result).toEqual({
      ok: true, outcomeKnown: true,
      value: {
        ok: false, error: 'provider refused',
        usage: { inputTokens: 4, outputTokens: 5 },
      },
    });
  });
});

describe('kernel rich effect authority', () => {
  const harness = (overrides: Record<string, unknown> = {}) => {
    const scriptRuns = createScriptRunRegistry();
    const outer = new AbortController();
    scriptRuns.register('run:1', outer.signal, 'session:1', { provider: true });
    let session: any = {
      sessionId: 'session:1', kind: 'chat', provider: 'anthropic',
      model: 'claude-test', cost: { cost: 0 },
    };
    const audit: any[] = [];
    const snapshots: any[] = [];
    let providerCalls = 0;
    const authority = createKernelRichEffectAuthority({
      scriptRuns,
      sessions: {
        getMetadata: async () => session,
        updateMetadata: async (_id: string, patch: any) => {
          session = { ...session, ...patch };
          return session;
        },
      },
      settingsStore: { get: () => ({ spendLimitUsd: null, pricingOverrides: {}, ollamaHost: '' }) },
      vault: { getSecret: async () => 'secret' },
      auditLog: { append: async (entry: any) => { audit.push(entry); } },
      contextSnapshots: { record: (entry: any) => { snapshots.push(entry); } },
      kv: { get: async () => null },
      fetchFn: async () => new Response('', { status: 200 }),
      listProviders: () => [{ name: 'anthropic', keyless: false }],
      hasPricing: () => true,
      callModel: async function* () { providerCalls += 1; yield { type: 'ignored' }; },
      foldProviderEvents: () => ({
        text: 'answer', stopReason: 'end_turn',
        usage: {
          inputTokens: 4, outputTokens: 5,
          cacheReadTokens: 0, cacheWriteTokens: 0,
        },
      }),
      costOf: () => ({ cost: 0.25 }),
      randomId: () => 'reservation-token-1234',
      ...overrides,
    });
    const contextAbort = new AbortController();
    const context = {
      capability: 'runtime.dispatch',
      authority: { target: 'kernel-runtime-rich-relay', replayClass: 'E' },
      signal: contextAbort.signal,
    };
    return {
      authority, scriptRuns, outer, audit, snapshots, context, contextAbort,
      providerCalls: () => providerCalls, session: () => session,
    };
  };

  test('binds a one-shot reservation to the live run and persists cost/audit', async () => {
    const state = harness();
    const admitted: any = await state.authority.handle('rich.script.admit', {
      ownerSessionId: 'session:1', runId: 'run:1', maxTokens: 32, requestedModel: null,
    }, state.context);
    expect(admitted).toMatchObject({ ok: true, outcomeKnown: true });
    const token = admitted.value.token;
    const payload = {
      token, ownerSessionId: 'session:1', runId: 'run:1',
      provider: 'anthropic', model: 'claude-test', system: '',
      messages: [{ role: 'user', content: 'hello' }], maxTokens: 32,
      ollamaHost: '', pricingOverrides: {}, localProvider: false,
    };
    const modeled: any = await state.authority.handle(
      'rich.model.call', payload, state.context,
    );
    expect(modeled).toEqual({
        ok: true, outcomeKnown: true,
        value: {
          text: 'answer', stopReason: 'end_turn',
          usage: { inputTokens: 4, outputTokens: 5 }, cost: 0.25,
        },
      });
    await expect(state.authority.handle('rich.model.call', payload, state.context))
      .resolves.toMatchObject({ ok: false, code: 'rich-model-reservation-invalid' });
    expect(state.scriptRuns.providerUsageFor('run:1')).toEqual({ calls: 1, outputTokens: 5 });
    expect(state.session().cost).toMatchObject({ inputTokens: 4, outputTokens: 5, cost: 0.25 });
    expect(state.audit).toHaveLength(1);
    expect(state.snapshots).toEqual([{
      provider: 'anthropic', model: 'claude-test', system: '',
      messages: [{ role: 'user', content: 'hello' }], maxTokens: 32,
      sessionId: 'session:1', label: 'script:sub-call',
    }]);
  });

  test('accounts and returns provider errors with usage', async () => {
    const state = harness({
      foldProviderEvents: () => ({
        text: '', error: 'provider refused',
        usage: {
          inputTokens: 4, outputTokens: 5,
          cacheReadTokens: 0, cacheWriteTokens: 0,
        },
      }),
    });
    const admitted: any = await state.authority.handle('rich.script.admit', {
      ownerSessionId: 'session:1', runId: 'run:1', maxTokens: 32, requestedModel: null,
    }, state.context);
    const modeled: any = await state.authority.handle('rich.model.call', {
      token: admitted.value.token,
      ownerSessionId: 'session:1', runId: 'run:1', provider: 'anthropic',
      model: 'claude-test', system: '',
      messages: [{ role: 'user', content: 'hello' }], maxTokens: 32,
      ollamaHost: '', pricingOverrides: {}, localProvider: false,
    }, state.context);
    expect(modeled).toEqual({
      ok: true, outcomeKnown: true,
      value: {
        text: '', usage: { inputTokens: 4, outputTokens: 5 }, cost: 0.25,
        error: 'provider refused',
      },
    });
    expect(state.session().cost).toMatchObject({ cost: 0.25 });
    expect(state.audit).toHaveLength(1);
  });

  test('refuses forged authority and aborts only the exact owned run', async () => {
    const state = harness();
    await expect(state.authority.handle('rich.script.abort', {
      ownerSessionId: 'session:1', runId: 'run:1',
    }, { ...state.context, authority: { target: 'turn', replayClass: 'E' } }))
      .resolves.toMatchObject({ ok: false, code: 'kernel-operation-denied' });
    await expect(state.authority.handle('rich.script.abort', {
      ownerSessionId: 'session:other', runId: 'run:1',
    }, {
      ...state.context,
      authority: { target: 'kernel-runtime-rich-abort', replayClass: 'E' },
    })).resolves.toMatchObject({ ok: false, code: 'rich-script-abort-invalid' });
    await expect(state.authority.handle('rich.script.abort', {
      ownerSessionId: 'session:1', runId: 'run:1',
    }, {
      ...state.context,
      authority: { target: 'kernel-runtime-rich-abort', replayClass: 'E' },
    })).resolves.toEqual({ ok: true, outcomeKnown: true });
    expect(state.scriptRuns.signalFor('run:1')?.aborted).toBe(true);
  });

  test('releases admission quota when the dispatch lifetime ends before model call', async () => {
    const state = harness();
    for (let index = 0; index < 20; index += 1) {
      const lifetime = new AbortController();
      await expect(state.authority.handle('rich.script.admit', {
        ownerSessionId: 'session:1', runId: 'run:1', maxTokens: 32,
        requestedModel: null,
      }, { ...state.context, signal: lifetime.signal })).resolves.toMatchObject({ ok: true });
      lifetime.abort();
      expect(state.scriptRuns.providerUsageFor('run:1'))
        .toEqual({ calls: 0, outputTokens: 0 });
    }
    await expect(state.authority.handle('rich.script.admit', {
      ownerSessionId: 'session:1', runId: 'run:1', maxTokens: 32,
      requestedModel: null,
    }, state.context)).resolves.toMatchObject({ ok: true });
    expect(state.scriptRuns.providerUsageFor('run:1'))
      .toEqual({ calls: 1, outputTokens: 32 });
    expect(state.providerCalls()).toBe(0);
    state.contextAbort.abort();
  });

  test('releases admission quota after a mismatched token redemption', async () => {
    const state = harness();
    const admitted: any = await state.authority.handle('rich.script.admit', {
      ownerSessionId: 'session:1', runId: 'run:1', maxTokens: 32,
      requestedModel: null,
    }, state.context);
    await expect(state.authority.handle('rich.model.call', {
      token: admitted.value.token,
      ownerSessionId: 'session:1', runId: 'run:1', provider: 'anthropic',
      model: 'forged-model', system: '',
      messages: [{ role: 'user', content: 'hello' }], maxTokens: 32,
      ollamaHost: '', pricingOverrides: {}, localProvider: false,
    }, state.context)).resolves.toMatchObject({
      ok: false, code: 'rich-model-reservation-invalid', outcomeKnown: true,
    });
    expect(state.scriptRuns.providerUsageFor('run:1'))
      .toEqual({ calls: 0, outputTokens: 0 });
    await expect(state.authority.handle('rich.script.admit', {
      ownerSessionId: 'session:1', runId: 'run:1', maxTokens: 32,
      requestedModel: null,
    }, state.context)).resolves.toMatchObject({ ok: true });
    state.contextAbort.abort();
  });
});
