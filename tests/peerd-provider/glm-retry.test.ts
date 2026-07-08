// callGlm retry-set coverage, terminal-runnable.
//
// Mirrors openrouter-retry.test.ts. Z.ai is an OpenAI-compatible direct API,
// so it reuses the same connect/retry plumbing as the OpenRouter adapter.
// GLM-5.2 tool-calling rides the same /chat/completions wire; the retry
// semantics (transient 429/5xx recover, hard 4xx fail fast) must match.

import { describe, test, expect } from 'bun:test';
import { callGlm } from '../../extension/peerd-provider/adapters/glm.js';
import { ProviderHttpError } from '../../extension/peerd-provider/errors.js';

const stubResponse = (status: number, headers: Record<string, string> = {}, bodyText = '') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  body: undefined,
  text: async () => bodyText,
});

const okStreamingResponse = () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, headers: new Headers(), body, text: async () => '' };
};

const baseArgs = (overrides: Record<string, unknown> = {}) => ({
  messages: [{ role: 'user', content: 'hi', id: 'u', when: 0 }],
  system: 'sys',
  getSecret: async () => 'fake-glm-key',
  safeFetch: async () => { throw new Error('safeFetch not set'); },
  _sleep: async () => {},
  ...overrides,
});

const drain = async (gen: AsyncGenerator<any>) => {
  const out: any[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};

describe('callGlm — retryable status set', () => {
  // Same retry set as OpenRouter/Anthropic: a transient upstream blip must
  // retry, not kill the turn.
  test.each([429, 500, 503, 529])('retries %i and recovers on the next attempt', async (status) => {
    let calls = 0;
    const safeFetch = async () => {
      calls++;
      if (calls === 1) return stubResponse(status, {}, '{"error":{"message":"transient upstream error"}}');
      return okStreamingResponse();
    };
    const events = await drain(callGlm(baseArgs({ safeFetch }) as any));
    expect(calls).toBe(2);
    expect(events[0].type).toBe('rate-limit-pause');
  });

  test.each([400, 401, 403, 404])('throws immediately on non-retryable %i', async (status) => {
    let calls = 0;
    const safeFetch = async () => {
      calls++;
      return stubResponse(status, {}, 'bad');
    };
    let thrown: any;
    try { await drain(callGlm(baseArgs({ safeFetch }) as any)); }
    catch (e) { thrown = e; }
    expect(calls).toBe(1);
    expect(thrown).toBeInstanceOf(ProviderHttpError);
    expect(thrown.status).toBe(status);
    expect(thrown.provider).toBe('glm');
  });

  test('uses the Z.ai paas/v4 endpoint and Bearer auth', async () => {
    let url = '';
    let init: any;
    const safeFetch = async (u: any, i: any) => { url = String(u); init = i; return okStreamingResponse(); };
    await drain(callGlm(baseArgs({ safeFetch }) as any));
    expect(url).toBe('https://api.z.ai/api/paas/v4/chat/completions');
    expect(init.headers.authorization).toBe('Bearer fake-glm-key');
    // The body carries the default model glm-5.2 unless overridden.
    const body = JSON.parse(init.body);
    expect(body.model).toBe('glm-5.2');
    expect(body.stream).toBe(true);
  });

  test('defaults model to glm-5.2 and surfaces usage+stop from the stream', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n'));
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const safeFetch = async () => ({ ok: true, status: 200, headers: new Headers(), body, text: async () => '' });
    const events = await drain(callGlm(baseArgs({ safeFetch }) as any));
    expect(events.find((e) => e.type === 'text-delta').text).toBe('hi');
    expect(events.find((e) => e.type === 'usage').usage).toMatchObject({ inputTokens: 5, outputTokens: 2 });
    expect(events[events.length - 1]).toMatchObject({ type: 'message-stop', stopReason: 'end_turn' });
  });
});
