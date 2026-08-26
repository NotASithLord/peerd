// callOpenAi — the direct-OpenAI adapter. Mirrors openrouter-retry.test.ts
// (same OpenAI /chat/completions wire format), plus the key-missing throw,
// the Authorization header (never the body), and the hard-limit fast-fail.

import { describe, test, expect } from 'bun:test';
import { callOpenAi, openaiAdapter, DEFAULT_MODEL } from '../../extension/peerd-provider/adapters/openai.js';
import { ProviderHttpError, ProviderKeyMissingError, ProviderUsageLimitError } from '../../extension/peerd-provider/errors.js';
import { makeModelEgress } from './model-egress-fixture';

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
  modelEgress: makeModelEgress(),
  _sleep: async () => {},
  ...overrides,
});

const drain = async (gen: AsyncGenerator<any>) => {
  const out: any[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};

describe('the adapter descriptor', () => {
  test('contains semantic metadata but no authority policy', () => {
    expect(openaiAdapter.name).toBe('openai');
    expect('vaultSecretName' in openaiAdapter).toBe(false);
    expect('endpoint' in openaiAdapter).toBe(false);
    expect(openaiAdapter.defaultModel).toBe(DEFAULT_MODEL);
    expect(typeof openaiAdapter.call).toBe('function');
  });
});

describe('callOpenAi exact authority boundary', () => {
  test('propagates a credential error from model authority', async () => {
    let thrown: any;
    const modelEgress = makeModelEgress({
      openInference: async () => { throw new ProviderKeyMissingError('openai'); },
    });
    try { await drain(callOpenAi(baseArgs({ modelEgress }) as any)); }
    catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ProviderKeyMissingError);
  });

  test('passes only provider, model, native body, and signal', async () => {
    let request: any = null;
    const modelEgress = makeModelEgress({
      openInference: async (args: any) => { request = args; return okStreamingResponse(); },
    });
    await drain(callOpenAi(baseArgs({ modelEgress }) as any));
    expect(Object.keys(request).sort()).toEqual(['modelId', 'nativeBody', 'providerId', 'signal']);
    expect(request.providerId).toBe('openai');
    expect(request.modelId).toBe(DEFAULT_MODEL);
    expect(request.nativeBody.model).toBe(DEFAULT_MODEL);
    expect(request.nativeBody.stream).toBe(true);
  });
});

describe('callOpenAi — retryable status set', () => {
  test.each([429, 500, 503, 529])('retries %i and recovers on the next attempt', async (status) => {
    let calls = 0;
    const openInference = async () => {
      calls++;
      if (calls === 1) return stubResponse(status, {}, '{"error":{"message":"transient error"}}');
      return okStreamingResponse();
    };
    const events = await drain(callOpenAi(baseArgs({ modelEgress: makeModelEgress({ openInference }) }) as any));
    expect(calls).toBe(2);
    expect(events[0].type).toBe('rate-limit-pause');
  });

  test.each([400, 401, 403, 404])('throws immediately on non-retryable %i', async (status) => {
    let calls = 0;
    const openInference = async () => { calls++; return stubResponse(status, {}, 'bad'); };
    let thrown: any;
    try { await drain(callOpenAi(baseArgs({ modelEgress: makeModelEgress({ openInference }) }) as any)); }
    catch (e) { thrown = e; }
    expect(calls).toBe(1);
    expect(thrown).toBeInstanceOf(ProviderHttpError);
    expect(thrown.status).toBe(status);
  });

  test('a spent account (429 insufficient_quota) fails FAST as a usage limit, no retry', async () => {
    let calls = 0;
    const openInference = async () => {
      calls++;
      return stubResponse(429, {}, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}');
    };
    let thrown: any;
    try { await drain(callOpenAi(baseArgs({ modelEgress: makeModelEgress({ openInference }) }) as any)); }
    catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(ProviderUsageLimitError);
    expect(calls).toBe(1); // hard limit → no retry
  });
});
