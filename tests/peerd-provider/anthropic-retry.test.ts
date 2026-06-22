// callAnthropic retry-set coverage, terminal-runnable.
//
// The full backoff/header-parsing suite lives in-browser
// (extension/tests/unit/peerd-provider/anthropic-adapter.test.js); this
// file pins the RETRYABLE STATUS SET — 429/529 plus the transient
// server faults 500 (api_error) and 503 — where `bun test` can catch a
// regression without a browser.

import { describe, test, expect } from 'bun:test';
import { callAnthropic } from '../../extension/peerd-provider/adapters/anthropic.js';
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
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, headers: new Headers(), body, text: async () => '' };
};

const baseArgs = (overrides: Record<string, unknown> = {}) => ({
  messages: [{ role: 'user', content: 'hi', id: 'u', when: 0 }],
  system: 'sys',
  getSecret: async () => 'sk-test',
  safeFetch: async () => { throw new Error('safeFetch not set'); },
  _sleep: async () => {},
  ...overrides,
});

const drain = async (gen: AsyncGenerator<any>) => {
  const out: any[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};

describe('callAnthropic — retryable status set', () => {
  test.each([429, 529, 500, 503])('retries %i and recovers on the next attempt', async (status) => {
    let calls = 0;
    const safeFetch = async () => {
      calls++;
      if (calls === 1) return stubResponse(status, {}, '{"error":{"type":"transient"}}');
      return okStreamingResponse();
    };
    const events = await drain(callAnthropic(baseArgs({ safeFetch }) as any));
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
    try { await drain(callAnthropic(baseArgs({ safeFetch }) as any)); }
    catch (e) { thrown = e; }
    expect(calls).toBe(1);
    expect(thrown).toBeInstanceOf(ProviderHttpError);
    expect(thrown.status).toBe(status);
  });

  test('a dropped connection (TypeError) is retried and the call recovers', async () => {
    let calls = 0;
    const safeFetch = async () => {
      calls++;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return okStreamingResponse();
    };
    const events = await drain(callAnthropic(baseArgs({ safeFetch }) as any));
    expect(calls).toBe(2);
    // why no pause event: connect retries are silent-fast (500/1500ms);
    // 'rate-limit-pause' would mislabel a network drop as throttling.
    expect(events.at(-1).type).toBe('message-stop');
  });

  test('a dead connection gives up after 3 total attempts ("just 3 times max")', async () => {
    let calls = 0;
    const safeFetch = async () => { calls++; throw new TypeError('Failed to fetch'); };
    let thrown: any;
    try { await drain(callAnthropic(baseArgs({ safeFetch }) as any)); }
    catch (e) { thrown = e; }
    expect(calls).toBe(3);
    expect(thrown).toBeInstanceOf(TypeError);
  });

  test('persistent 500 exhausts retries then surfaces ProviderHttpError', async () => {
    let calls = 0;
    const safeFetch = async () => {
      calls++;
      return stubResponse(500, {}, '{"error":{"type":"api_error"}}');
    };
    let thrown: any;
    const events: any[] = [];
    try {
      for await (const ev of callAnthropic(baseArgs({ safeFetch }) as any)) events.push(ev);
    } catch (e) { thrown = e; }
    // 1 initial attempt + 3 retries.
    expect(calls).toBe(4);
    expect(events.filter((e) => e.type === 'rate-limit-pause').length).toBe(3);
    expect(thrown).toBeInstanceOf(ProviderHttpError);
    expect(thrown.status).toBe(500);
  });
});
