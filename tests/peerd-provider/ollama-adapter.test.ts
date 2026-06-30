// Ollama adapter — terminal-runnable coverage.
//
// Pins the LOCAL-specific behaviors: keyless calling (getSecret never
// consulted), connection-refused → the legible OllamaNotRunningError,
// 404 → the "ollama pull <model>" hint, and the /api/tags inventory
// parse. Full OpenAI-format streaming is from-openai's concern
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

const baseArgs = {
  messages: [{ role: 'user', content: 'hi', id: '1', when: 0 }],
  system: '',
};

describe('ollamaAdapter descriptor', () => {
  test('is keyless with no vault secret and a live model lister', () => {
    expect(ollamaAdapter.keyless).toBe(true);
    expect(ollamaAdapter.vaultSecretName).toBeNull();
    expect(typeof ollamaAdapter.listModels).toBe('function');
    expect(ollamaAdapter.endpoint).toBe('http://localhost:11434/v1/chat/completions');
  });
});

describe('callOllama', () => {
  test('streams without ever consulting getSecret (keyless)', async () => {
    let secretAsked = false;
    const events = await drain(callOllama({
      ...baseArgs,
      getSecret: async () => { secretAsked = true; return null; },
      safeFetch: async () => okStreamingResponse([
        'data: {"choices":[{"delta":{"content":"hey"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    } as any));
    expect(secretAsked).toBe(false);
    expect(events).toContainEqual({ type: 'text-delta', text: 'hey' });
    expect(events.at(-1)).toEqual({ type: 'message-stop', stopReason: 'end_turn' });
  });

  test('connection refused → OllamaNotRunningError with the one-command fix', async () => {
    let calls = 0;
    const gen = callOllama({
      ...baseArgs,
      safeFetch: async () => { calls++; throw new TypeError('Failed to fetch'); },
      _sleep: async () => {}, // skip the real connect-retry backoff
    } as any);
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
    const gen = callOllama({
      ...baseArgs,
      safeFetch: async () => { throw abort; },
    } as any);
    let err: any;
    try { await drain(gen); } catch (e) { err = e; }
    expect(err).toBe(abort);
  });

  test('404 → "ollama pull <model>" hint, not a raw HTTP error', async () => {
    const gen = callOllama({
      ...baseArgs,
      model: 'qwen3:14b',
      safeFetch: async () => ({
        ok: false, status: 404, headers: new Headers(),
        body: undefined, text: async () => '{"error":{"message":"model not found"}}',
      }),
    } as any);
    let err: any;
    try { await drain(gen); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(ProviderHttpError);
    expect(err.message).toContain('ollama pull qwen3:14b');
  });

  test('other non-2xx → ProviderHttpError with body excerpt', async () => {
    const gen = callOllama({
      ...baseArgs,
      safeFetch: async () => ({
        ok: false, status: 500, headers: new Headers(),
        body: undefined, text: async () => 'boom',
      }),
    } as any);
    let err: any;
    try { await drain(gen); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err.status).toBe(500);
    expect(err.bodyExcerpt).toBe('boom');
  });

  test('in-stream error events are labeled ollama, not openrouter', async () => {
    const events = await drain(callOllama({
      ...baseArgs,
      safeFetch: async () => okStreamingResponse([
        'data: {"error":{"message":"out of memory"}}\n\n',
        'data: [DONE]\n\n',
      ]),
    } as any));
    const errEv = events.find((e) => e.type === 'error');
    expect(errEv?.error).toBe('ollama: out of memory');
  });
});

describe('listOllamaModels', () => {
  test('parses /api/tags into name-sorted picker entries', async () => {
    const models = await listOllamaModels({
      safeFetch: async (url: string) => {
        expect(String(url)).toBe('http://localhost:11434/api/tags');
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
    } as any);
    expect(models).toEqual([
      { model: 'gemma3:4b', label: 'gemma3:4b', sizeBytes: 3_338_000_000 },
      { model: 'qwen3:8b', label: 'qwen3:8b', sizeBytes: 5_585_000_000 },
    ]);
  });

  test('daemon down → OllamaNotRunningError', async () => {
    let err: any;
    try {
      await listOllamaModels({
        safeFetch: async () => { throw new TypeError('Failed to fetch'); },
      } as any);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(OllamaNotRunningError);
  });

  test('non-2xx → ProviderHttpError', async () => {
    let err: any;
    try {
      await listOllamaModels({
        safeFetch: async () => ({
          ok: false, status: 403, headers: new Headers(), text: async () => 'denied',
        }),
      } as any);
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err.status).toBe(403);
  });
});

describe('remote host — ollamaHost (issue #104)', () => {
  test('callOllama posts to the CONFIGURED host, not localhost', async () => {
    let url = '';
    await drain(callOllama({
      ...baseArgs,
      ollamaHost: 'http://192.168.1.4:11434',
      safeFetch: async (u: any) => { url = String(u); return okStreamingResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]); },
    } as any));
    expect(url).toBe('http://192.168.1.4:11434/v1/chat/completions');
  });

  test('listOllamaModels reads /api/tags on the configured host', async () => {
    let url = '';
    const models = await listOllamaModels({
      ollamaHost: 'http://192.168.1.4:11434',
      safeFetch: async (u: any) => { url = String(u); return /** @type {any} */ ({
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ models: [{ name: 'qwen3:8b', size: 1 }] }),
      }); },
    } as any);
    expect(url).toBe('http://192.168.1.4:11434/api/tags');
    expect(models[0].model).toBe('qwen3:8b');
  });

  test('defaults to the local loopback when no host is given (back-compat)', async () => {
    let url = '';
    await listOllamaModels({
      safeFetch: async (u: any) => { url = String(u); return /** @type {any} */ ({
        ok: true, status: 200, headers: new Headers(), json: async () => ({ models: [] }),
      }); },
    } as any);
    expect(url).toBe('http://localhost:11434/api/tags');
  });

  test('a trailing slash on the host is stripped, not doubled', async () => {
    let url = '';
    await listOllamaModels({
      ollamaHost: 'http://192.168.1.4:11434/',
      safeFetch: async (u: any) => { url = String(u); return /** @type {any} */ ({
        ok: true, status: 200, headers: new Headers(), json: async () => ({ models: [] }),
      }); },
    } as any);
    expect(url).toBe('http://192.168.1.4:11434/api/tags');
  });

  test('fetchOllamaContextWindow queries /api/show on the configured host', async () => {
    let url = '';
    const w = await fetchOllamaContextWindow({
      model: 'qwen3:8b',
      ollamaHost: 'http://192.168.1.4:11434',
      safeFetch: async (u: any) => { url = String(u); return /** @type {any} */ ({
        ok: true, status: 200, headers: new Headers(), json: async () => ({ parameters: 'num_ctx 8192' }),
      }); },
    } as any);
    expect(url).toBe('http://192.168.1.4:11434/api/show');
    expect(w).toBe(8192);
  });
});
