import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { createKernelRichEffectAuthority } from '../../extension/background/kernel-rich-effect-authority.js';
import { createScriptRunRegistry } from '../../extension/background/script-runs.js';
import { dispatchKernelRichRelay } from '../../extension/offscreen/kernel-rich-relay-host.js';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';

const encoder = new TextEncoder();
const streamBytes = encoder.encode([
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":0}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join(''));
const effects = (call: (operation: string, payload: any) => Promise<any>) => ({
  effects: { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000, call },
});
const admitProjection = {
  token: 'reservation-token-1234',
  providerId: 'anthropic',
  modelId: 'claude-test',
};

describe('sealed rich relay host', () => {
  test('links only the narrow pure runtime surface', async () => {
    const extensionRoot = join(import.meta.dir, '../../extension');
    const graph = new Set([...await collectStaticModuleGraph(
      extensionRoot,
      join(extensionRoot, 'offscreen/kernel-rich-relay-host.js'),
    )].map((file) => relative(extensionRoot, file).replaceAll('\\', '/')));
    expect(graph.has('peerd-runtime/controller-model.js')).toBe(true);
    expect(graph.has('peerd-runtime/actor/provider-call-api.js')).toBe(true);
    for (const module of [
      'peerd-runtime/background.js',
      'peerd-runtime/tools/registry.js',
      'peerd-runtime/tools/metadata-registry.js',
      'peerd-runtime/controller-turn-semantics.js',
      'peerd-runtime/semantic.js',
    ]) expect(graph.has(module), `rich relay imports ${module}`).toBe(false);
    expect([...graph].filter((module) =>
      module.startsWith('peerd-runtime/tools/defs/')
        || module.startsWith('peerd-runtime/tools/metadata/'))).toEqual([]);
  });

  test('keeps provider semantics controller-side and privileged transport worker-side', async () => {
    const [relay, authority] = await Promise.all([
      readFile(new URL('../../extension/offscreen/kernel-rich-relay-host.js', import.meta.url), 'utf8'),
      readFile(new URL('../../extension/background/kernel-rich-effect-authority.js', import.meta.url), 'utf8'),
    ]);
    expect(relay).toContain("from '/peerd-provider/controller.js'");
    expect(relay).toContain("from '/peerd-runtime/controller-model.js'");
    expect(relay).not.toContain("from '/peerd-runtime/background.js'");
    for (const forbidden of [
      '/peerd-provider/kernel.js', '/peerd-provider/background.js',
      'getSecret', 'safeFetch', 'rich.model.call',
    ]) expect(authority).not.toContain(forbidden);
    expect(authority).not.toContain('callModel');
  });

  test('owns provider encoding, stream decoding, and result shaping', async () => {
    const calls: Array<[string, any]> = [];
    let read = 0;
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
      if (operation === 'rich.model.open-inference') return {
        ok: true, outcomeKnown: true,
        value: { streamId: 'stream:1', status: 200, statusText: 'OK', headers: {}, hasBody: true },
      };
      if (operation === 'rich.model.read-inference') return {
        ok: true, outcomeKnown: true,
        value: read++ === 0 ? { done: false, chunk: streamBytes } : { done: true },
      };
      return { ok: true, outcomeKnown: true };
    }));
    expect(result).toEqual({
      ok: true, outcomeKnown: true,
      value: { ok: true, value: {
        text: 'world', model: 'claude-test', stopReason: 'end_turn',
        usage: { inputTokens: 2, outputTokens: 3 },
      } },
    });
    expect(calls.map(([operation]) => operation)).toEqual([
      'rich.script.admit', 'rich.model.open-inference',
      'rich.model.read-inference', 'rich.model.read-inference', 'rich.model.observe-usage',
    ]);
    expect(calls[1]?.[1]).toMatchObject({
      token: admitProjection.token, providerId: 'anthropic', modelId: 'claude-test',
      nativeBody: { model: 'claude-test', max_tokens: 12, stream: true },
    });
    expect(calls.at(-1)?.[1].usage).toEqual({
      inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
  });

  test('refuses malformed calls and forged stream projections', async () => {
    let called = 0;
    const context = effects(async () => { called += 1; return {}; });
    await expect(dispatchKernelRichRelay({
      route: 'script/model-call', message: {
        ownerSessionId: 'session:1', runId: 'run:1', args: { prompt: 'x', tools: [] },
      },
    }, context)).resolves.toMatchObject({ value: { ok: false, error: expect.stringContaining('unsupported arg') } });
    expect(called).toBe(0);
    const forged = await dispatchKernelRichRelay({
      route: 'script/model-call', message: {
        ownerSessionId: 'session:1', runId: 'run:1', args: { prompt: 'x' },
      },
    }, effects(async (operation) => operation === 'rich.script.admit'
      ? { ok: true, outcomeKnown: true, value: admitProjection }
      : { ok: true, outcomeKnown: true, value: { streamId: 'forged' } }));
    expect(forged).toMatchObject({
      ok: false, code: 'runtime-rich-open-result-invalid', outcomeKnown: false,
    });
  });

  test('routes abort through the kernel-owned Stop signal', async () => {
    const calls: any[] = [];
    const result = await dispatchKernelRichRelay({
      route: 'script-run/abort', message: { ownerSessionId: 'session:1', runId: 'run:1' },
    }, effects(async (operation, payload) => {
      calls.push([operation, payload]);
      return { ok: true, outcomeKnown: true };
    }));
    expect(result).toEqual({ ok: true, outcomeKnown: true, value: { ok: true } });
    expect(calls).toEqual([['rich.script.abort', {
      ownerSessionId: 'session:1', runId: 'run:1',
    }]]);
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
    const providerCalls: any[] = [];
    const providerEgress = {
      openInference: async (input: any, grant: any) => {
        providerCalls.push(['open', input, grant]);
        return { ok: true, outcomeKnown: true, value: {
          streamId: 'stream:1', status: 200, statusText: 'OK', headers: {}, hasBody: true,
        } };
      },
      readInferenceChunk: async (input: any, grant: any) => {
        providerCalls.push(['read', input, grant]);
        return { ok: true, outcomeKnown: true, value: { done: true } };
      },
      cancelInference: async (input: any, grant: any) => {
        providerCalls.push(['cancel', input, grant]);
        return { ok: true, outcomeKnown: true, value: null };
      },
      openLocalGeneration: async () => ({
        ok: false, outcomeKnown: true, code: 'local-model-authority-unavailable',
      }),
      readLocalGeneration: async () => ({
        ok: false, outcomeKnown: true, code: 'local-model-authority-unavailable',
      }),
      cancelLocalGeneration: async () => ({
        ok: false, outcomeKnown: true, code: 'local-model-authority-unavailable',
      }),
      closeOwner: async (owner: any) => { providerCalls.push(['close', owner]); },
    };
    const authority = createKernelRichEffectAuthority({
      scriptRuns,
      sessions: {
        getMetadata: async () => session,
        updateMetadata: async (_id: string, patch: any) => {
          session = { ...session, ...patch }; return session;
        },
      },
      settingsStore: { get: () => ({ spendLimitUsd: null, pricingOverrides: {}, ollamaHost: '' }) },
      auditLog: { append: async (entry: any) => { audit.push(entry); } },
      providerEgress,
      hasPricing: () => true,
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
    return { authority, scriptRuns, outer, audit, providerCalls, context, contextAbort, session: () => session };
  };

  test('pins provider/model/stream ownership and settles bounded usage in the worker', async () => {
    const state = harness();
    const admitted: any = await state.authority.handle('rich.script.admit', {
      ownerSessionId: 'session:1', runId: 'run:1', maxTokens: 32, requestedModel: null,
    }, state.context);
    const binding = {
      token: admitted.value.token, ownerSessionId: 'session:1', runId: 'run:1',
    };
    await expect(state.authority.handle('rich.model.open-inference', {
      ...binding, providerId: 'anthropic', modelId: 'claude-test',
      nativeBody: { model: 'claude-test', stream: true, messages: [], max_tokens: 32, system: '' },
    }, state.context)).resolves.toMatchObject({ ok: true });
    await expect(state.authority.handle('rich.model.read-inference', {
      ...binding, streamId: 'stream:1',
    }, state.context)).resolves.toMatchObject({ ok: true });
    await expect(state.authority.handle('rich.model.observe-usage', {
      ...binding, providerId: 'anthropic', modelId: 'claude-test',
      usage: { inputTokens: 4, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 },
    }, state.context)).resolves.toEqual({ ok: true, outcomeKnown: true });
    expect(state.scriptRuns.providerUsageFor('run:1')).toEqual({ calls: 1, outputTokens: 5 });
    expect(state.session().cost).toMatchObject({
      inputTokens: 4, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2, cost: 0.25,
    });
    expect(state.audit).toHaveLength(1);
    expect(state.providerCalls.map(([kind]) => kind)).toEqual(['open', 'read', 'close']);
  });

  test('rejects a forged model and releases the reserved quota', async () => {
    const state = harness();
    const admitted: any = await state.authority.handle('rich.script.admit', {
      ownerSessionId: 'session:1', runId: 'run:1', maxTokens: 32, requestedModel: null,
    }, state.context);
    await expect(state.authority.handle('rich.model.open-inference', {
      token: admitted.value.token, ownerSessionId: 'session:1', runId: 'run:1',
      providerId: 'anthropic', modelId: 'forged', nativeBody: {},
    }, state.context)).resolves.toMatchObject({
      ok: false, code: 'rich-model-reservation-invalid', outcomeKnown: true,
    });
    expect(state.scriptRuns.providerUsageFor('run:1')).toEqual({ calls: 0, outputTokens: 0 });
  });

  test('releases admission quota when the dispatch lifetime ends', async () => {
    const state = harness();
    await state.authority.handle('rich.script.admit', {
      ownerSessionId: 'session:1', runId: 'run:1', maxTokens: 32, requestedModel: null,
    }, state.context);
    state.contextAbort.abort();
    expect(state.scriptRuns.providerUsageFor('run:1')).toEqual({ calls: 0, outputTokens: 0 });
  });
});
