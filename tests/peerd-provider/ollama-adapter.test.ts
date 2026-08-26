// Ollama adapter — terminal-runnable coverage.
//
// Pins the LOCAL-specific behaviors: keyless calling, connection-refused →
// the legible OllamaNotRunningError, 404 → the "ollama pull <model>" hint,
// and live inventory parsing. Full OpenAI-format streaming is from-openai's concern
// (openai-format.test.ts); the in-browser suite covers the adapter's
// end-to-end stream + tool_use path.

import { describe, test, expect } from 'bun:test';
import {
  callOllama,
  listOllamaModels,
  fetchOllamaContextWindow,
  ollamaAdapter,
} from '../../extension/peerd-provider/adapters/ollama.js';
import {
  OllamaNotRunningError,
  ProviderError,
  ProviderHttpError,
} from '../../extension/peerd-provider/errors.js';
import { makeModelEgress } from './model-egress-fixture';

const sseStream = (chunks: string[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
};

const okStreamingResponse = (chunks: string[]) => ({
  ok: true, status: 200, headers: new Headers(),
  body: sseStream(chunks), text: async () => '',
});

const drain = async (gen: AsyncGenerator<any>) => {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
};

const baseArgs = (overrides: Record<string, unknown> = {}) => ({
  messages: [{ role: 'user', content: 'hi', id: '1', when: 0 }],
  system: '',
  modelEgress: makeModelEgress(),
  ...overrides,
});

describe('ollamaAdapter descriptor', () => {
  test('is keyless with no authority metadata and a live model lister', () => {
    expect(ollamaAdapter.keyless).toBe(true);
    expect('vaultSecretName' in ollamaAdapter).toBe(false);
    expect('endpoint' in ollamaAdapter).toBe(false);
    expect(typeof ollamaAdapter.listModels).toBe('function');
  });
});

describe('callOllama', () => {
  test('streams through the keyless model authority', async () => {
    const openInference = async () => okStreamingResponse([
        'data: {"choices":[{"delta":{"content":"hey"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    const events = await drain(callOllama(baseArgs({ modelEgress: makeModelEgress({ openInference }) }) as any));
    expect(events).toContainEqual({ type: 'text-delta', text: 'hey' });
    expect(events.at(-1)).toEqual({ type: 'message-stop', stopReason: 'end_turn' });
  });

  test('connection refused → OllamaNotRunningError with the one-command fix', async () => {
    let calls = 0;
    const openInference = async () => { calls++; throw new TypeError('Failed to fetch'); };
    const gen = callOllama(baseArgs({
      modelEgress: makeModelEgress({ openInference }),
      _sleep: async () => {}, // skip the real connect-retry backoff
    }) as any);
    let err: any;
    try { await drain(gen); } catch (e) { err = e; }
    // Exactly ONE connect retry (2 total attempts) before the legible error —
    // a daemon that isn't running won't appear during a longer backoff.
    expect(calls).toBe(2);
    expect(err).toBeInstanceOf(OllamaNotRunningError);
    expect(err.message).toContain('ollama serve');
  });

  test('user abort passes through untouched (not mapped to not-running)', async () => {
    const abort = new DOMException('Aborted', 'AbortError');
    const modelEgress = makeModelEgress({ openInference: async () => { throw abort; } });
    const gen = callOllama(baseArgs({ modelEgress }) as any);
    let err: any;
    try { await drain(gen); } catch (e) { err = e; }
    expect(err).toBe(abort);
  });

  test('404 → "ollama pull <model>" hint, not a raw HTTP error', async () => {
    const openInference = async () => ({
      ok: false, status: 404, headers: new Headers(),
      body: undefined, text: async () => '{"error":{"message":"model not found"}}',
    });
    const gen = callOllama(baseArgs({
      model: 'qwen3:14b',
      modelEgress: makeModelEgress({ openInference }),
    }) as any);
    let err: any;
    try { await drain(gen); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderHttpError);
    expect(err.message).toContain('ollama pull qwen3:14b');
  });

  test('other non-2xx → ProviderHttpError with body excerpt', async () => {
    const modelEgress = makeModelEgress({ openInference: async () => ({
        ok: false, status: 500, headers: new Headers(),
        body: undefined, text: async () => 'boom',
      }) });
    const gen = callOllama(baseArgs({ modelEgress }) as any);
    let err: any;
    try { await drain(gen); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err.status).toBe(500);
    expect(err.bodyExcerpt).toBe('boom');
  });

  test('in-stream error events are labeled ollama, not openrouter', async () => {
    const openInference = async () => okStreamingResponse([
        'data: {"error":{"message":"out of memory"}}\n\n',
        'data: [DONE]\n\n',
      ]);
    const events = await drain(callOllama(baseArgs({ modelEgress: makeModelEgress({ openInference }) }) as any));
    const errEv = events.find((e) => e.type === 'error');
    expect(errEv?.error).toBe('ollama: out of memory');
  });
});

describe('listOllamaModels', () => {
  test('parses /api/tags into name-sorted picker entries', async () => {
    let request: any;
    const models = await listOllamaModels({ modelEgress: makeModelEgress({
      readModelInventory: async (args: any) => {
        request = args;
        return {
          ok: true, status: 200, headers: new Headers(),
          json: async () => ({
            models: [
              { name: 'qwen3:8b', size: 5_585_000_000 },
              { name: 'gemma3:4b', size: 3_338_000_000 },
              { name: '', size: 1 },          // malformed → dropped
              { size: 2 },                    // malformed → dropped
            ],
          }),
        };
      },
    }) } as any);
    expect(request.providerId).toBe('ollama');
    expect(models).toEqual([
      { model: 'gemma3:4b', label: 'gemma3:4b', sizeBytes: 3_338_000_000 },
      { model: 'qwen3:8b', label: 'qwen3:8b', sizeBytes: 5_585_000_000 },
    ]);
  });

  test('daemon down → OllamaNotRunningError', async () => {
    let err: any;
    try {
      const modelEgress = makeModelEgress({ readModelInventory: async () => { throw new TypeError('Failed to fetch'); } });
      await listOllamaModels({ modelEgress } as any);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(OllamaNotRunningError);
  });

  test('non-2xx → ProviderHttpError', async () => {
    let err: any;
    try {
      const modelEgress = makeModelEgress({ readModelInventory: async () => ({
          ok: false, status: 403, headers: new Headers(), text: async () => 'denied',
        }) });
      await listOllamaModels({ modelEgress } as any);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err.status).toBe(403);
  });
});

describe('Ollama authority boundary', () => {
  test('inference carries no host or transport options', async () => {
    let request: any;
    const openInference = async (args: any) => { request = args; return okStreamingResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]); };
    await drain(callOllama(baseArgs({ modelEgress: makeModelEgress({ openInference }) }) as any));
    expect(Object.keys(request).sort()).toEqual(['modelId', 'nativeBody', 'providerId', 'signal']);
    expect(request.providerId).toBe('ollama');
  });

  test('inventory carries only provider identity and cancellation', async () => {
    let request: any;
    const modelEgress = makeModelEgress({ readModelInventory: async (args: any) => {
      request = args;
      return /** @type {any} */ ({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ models: [{ name: 'qwen3:8b', size: 1 }] }),
      });
    } });
    const models = await listOllamaModels({ modelEgress } as any);
    expect(Object.keys(request).sort()).toEqual(['providerId', 'signal']);
    expect(models[0].model).toBe('qwen3:8b');
  });

  test('context lookup carries only provider, model, and cancellation', async () => {
    let request: any;
    const modelEgress = makeModelEgress({ readModelContext: async (args: any) => {
      request = args;
      return /** @type {any} */ ({
        ok: true, status: 200, headers: new Headers(), json: async () => ({ parameters: 'num_ctx 8192' }),
      });
    } });
    const w = await fetchOllamaContextWindow({
      model: 'qwen3:8b',
      modelEgress,
    } as any);
    expect(Object.keys(request).sort()).toEqual(['modelId', 'providerId', 'signal']);
    expect(w).toBe(8192);
  });
});
