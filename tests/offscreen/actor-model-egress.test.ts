import { describe, expect, test } from 'bun:test';
import { createActorModelEgress } from '../../extension/offscreen/actor-model-egress.js';
import { makeOffscreenActorClient } from '../../extension/background/offscreen-actor-client.js';
import { fromOpenAiStream } from '../../extension/peerd-provider/format/from-openai.js';

describe('isolated actor model egress', () => {
  test('pulls inference chunks without buffering provider events', async () => {
    const reads: string[] = [];
    const egress = createActorModelEgress({
      openInference: async () => ({
        ok: true,
        value: {
          streamId: 'stream-1', status: 200, statusText: 'OK',
          headers: { 'content-type': 'text/event-stream' }, hasBody: true,
        },
      }),
      readInferenceChunk: async ({ streamId }) => {
        reads.push(streamId);
        return reads.length === 1
          ? { ok: true, value: { done: false, chunk: new TextEncoder().encode('data: one\n\n') } }
          : { ok: true, value: { done: true } };
      },
      cancelInference: async () => ({ ok: true, value: null }),
    });

    const response = await egress.openInference({
      providerId: 'anthropic', modelId: 'model',
      nativeBody: { model: 'model', stream: true },
    });
    expect(await response.text()).toBe('data: one\n\n');
    expect(reads).toEqual(['stream-1', 'stream-1']);
  });

  test('cancels the exact stream when provider consumption stops', async () => {
    const cancelled: string[] = [];
    const egress = createActorModelEgress({
      openInference: async () => ({
        ok: true,
        value: { streamId: 'stream-cancel', status: 200, headers: {}, hasBody: true },
      }),
      readInferenceChunk: async () => new Promise(() => {}),
      cancelInference: async ({ streamId }) => {
        cancelled.push(streamId);
        return { ok: true, value: null };
      },
    });
    const response = await egress.openInference({
      providerId: 'openai', modelId: 'model', nativeBody: {},
    });
    await response.body?.cancel();
    expect(cancelled).toEqual(['stream-cancel']);
  });

  test('reports local WebGPU as an exact unavailable authority', async () => {
    const egress = createActorModelEgress({
      openInference: async () => ({ ok: false }),
      readInferenceChunk: async () => ({ ok: false }),
      cancelInference: async () => ({ ok: false }),
    });
    let failure: any = null;
    try { await egress.generateLocal({})[Symbol.asyncIterator]().next(); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'local-model-authority-unavailable' });
  });
});

const SSE_TOOL_CALL = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function',
    function: { name: 'app_read_file', arguments: '{}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  '[DONE]',
].map((record) => `data: ${typeof record === 'string' ? record : JSON.stringify(record)}\n\n`).join('');

// Real SW slot routes, real Worker egress, real OpenAI parser. Only the network is a
// fixture: one chunk that ends with [DONE], then EOF after `eof` settles.
const twoModelSteps = async (eof: () => Promise<void>, drainMs?: number) => {
  const log: string[] = [];
  const sent = new Set<string>();
  let streams = 0;
  let outcome: { first: string[], second: string[] | { code?: string } } | null = null;
  const reply = (value: unknown) => ({ ok: true, outcomeKnown: true, value });
  const client = makeOffscreenActorClient({
    ensureHost: async () => {},
    isRelaySender: () => false,
    sendMessage: async () => ({ ok: true, started: true, finalText: '' }),
    spendRefusalFor: async () => null,
    sessions: { get: async () => ({
      kind: 'actor', sessionId: 'actor-1', actorType: 'webvm', instanceId: 'vm-1',
    }) },
    buildToolContext: async () => ({ session: { sessionId: 'actor-1', kind: 'actor' } }),
    providerEgress: {
      openInference: async () => {
        const streamId = `s${++streams}`;
        log.push(`open ${streamId}`);
        return reply({ streamId, status: 200, headers: {}, hasBody: true });
      },
      readInferenceChunk: async (input: unknown) => {
        const { streamId } = input as { streamId: string };
        if (!sent.has(streamId)) {
          sent.add(streamId);
          return reply({ done: false, chunk: new TextEncoder().encode(SSE_TOOL_CALL) });
        }
        await eof();
        log.push(`eof ${streamId}`);
        return reply({ done: true });
      },
      cancelInference: async (input: unknown) => {
        log.push(`cancel ${(input as { streamId: string }).streamId}`);
        return reply(null);
      },
      readModelContext: async () => reply(null),
      openLocalGeneration: async () => ({ ok: false, outcomeKnown: true }),
      readLocalGeneration: async () => ({ ok: false, outcomeKnown: true }),
      cancelLocalGeneration: async () => reply(null),
      closeOwner: async () => {},
    },
    runOnChannel: async (_job, { relay }) => {
      const egress = createActorModelEgress({
        openInference: (request) => relay('actor/model-open-inference', request),
        readInferenceChunk: (request) => relay('actor/model-read-inference-chunk', request),
        cancelInference: (request) => relay('actor/model-cancel-inference', request),
        ...(drainMs === undefined ? {} : { drainMs }),
      });
      const step = async () => {
        const response = await egress.openInference({
          providerId: 'openai', modelId: 'gpt-5.4', nativeBody: {},
        });
        const events: string[] = [];
        for await (const event of fromOpenAiStream(response.body!, { provider: 'openai' })) {
          events.push(event.type);
        }
        return events;
      };
      const first = await step();
      const second = await step().catch((error: { code?: string }) => ({ code: error.code }));
      outcome = { first, second };
      return { ok: true, started: true, finalText: '', newMessages: [] };
    },
  });
  await client.run({
    actorSessionId: 'actor-1', actorType: 'webvm', message: 'm', systemPrompt: 's',
    provider: 'openai', model: 'gpt-5.4', maxOutputTokens: 4096,
  });
  return { ...outcome!, log };
};

describe('isolated actor inference slot after a terminal [DONE]', () => {
  test('the next open waits for the previous stream EOF instead of meeting a busy slot', async () => {
    const result = await twoModelSteps(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(result.first.at(-1)).toBe('message-stop');
    expect(result.second).toEqual(result.first);
    expect(result.log).toEqual(['open s1', 'eof s1', 'open s2']);
  });

  test('a provider that never sends EOF meets the busy refusal after the bound', async () => {
    const result = await twoModelSteps(() => new Promise(() => {}), 20);
    expect(result.second).toEqual({ code: 'actor_model_relay_busy' });
    expect(result.log).toEqual(['open s1']);
  });
});
