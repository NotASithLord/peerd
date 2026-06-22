// callOpenRouter retry-set coverage, terminal-runnable.
//
// Mirrors anthropic-retry.test.ts. OpenRouter is a gateway proxying upstream
// providers, so a transient upstream blip commonly surfaces as a one-off 500
// (api_error) — it must retry like the Anthropic adapter, not kill the turn.
// 500 is the regression target here.

import { describe, test, expect } from 'bun:test';
import { callOpenRouter } from '../../extension/peerd-provider/adapters/openrouter.js';
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
  getSecret: async () => 'sk-or-test',
  safeFetch: async () => { throw new Error('safeFetch not set'); },
  _sleep: async () => {},
  ...overrides,
});

const drain = async (gen: AsyncGenerator<any>) => {
  const out: any[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};

describe('callOpenRouter — retryable status set', () => {
  // 500 joins 429/503/529 — the regression target (a transient upstream
  // api_error must retry, matching the Anthropic adapter).
  test.each([429, 500, 503, 529])('retries %i and recovers on the next attempt', async (status) => {
    let calls = 0;
    const safeFetch = async () => {
      calls++;
      if (calls === 1) return stubResponse(status, {}, '{"error":{"message":"transient upstream error"}}');
      return okStreamingResponse();
    };
    const events = await drain(callOpenRouter(baseArgs({ safeFetch }) as any));
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
    try { await drain(callOpenRouter(baseArgs({ safeFetch }) as any)); }
    catch (e) { thrown = e; }
    expect(calls).toBe(1);
    expect(thrown).toBeInstanceOf(ProviderHttpError);
    expect(thrown.status).toBe(status);
  });
});
