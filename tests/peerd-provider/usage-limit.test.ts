// Adapters fail FAST and explicit on a hard account limit — no retries.
//
// This is the behavioral half of the "usage limit fails silently" fix: a hard
// limit (out of credit / over a spend cap / HTTP 402) must NOT be retried as a
// transient throttle (which burned the budget then surfaced a misleading "rate
// limited"). It throws ProviderUsageLimitError on the FIRST attempt instead.

import { describe, test, expect } from 'bun:test';
import { callAnthropic } from '../../extension/peerd-provider/adapters/anthropic.js';
import { callOpenRouter } from '../../extension/peerd-provider/adapters/openrouter.js';
import { ProviderUsageLimitError } from '../../extension/peerd-provider/errors.js';

const stubResponse = (status: number, bodyText = '', headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  body: undefined,
  text: async () => bodyText,
});

const baseArgs = (safeFetch: () => Promise<any>) => ({
  messages: [{ role: 'user', content: 'hi', id: 'u', when: 0 }],
  system: 'sys',
  getSecret: async () => 'sk-test',
  safeFetch,
  _sleep: async () => {},
});

const drain = async (gen: AsyncGenerator<any>) => {
  const out: any[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};

describe('callAnthropic — hard usage/credit limit', () => {
  test('a credit-balance 429 throws ProviderUsageLimitError on the FIRST attempt (no retries)', async () => {
    let calls = 0;
    const safeFetch = async () => {
      calls++;
      return stubResponse(429, '{"error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}');
    };
    let thrown: any;
    try { await drain(callAnthropic(baseArgs(safeFetch) as any)); }
    catch (e) { thrown = e; }
    expect(calls).toBe(1);                       // NOT retried
    expect(thrown).toBeInstanceOf(ProviderUsageLimitError);
    expect(thrown.detail).toContain('credit balance');
  });

  test('a transient per-minute 429 still retries (regression guard)', async () => {
    let calls = 0;
    const safeFetch = async () => {
      calls++;
      if (calls === 1) {
        return stubResponse(429, '{"error":{"type":"rate_limit_error","message":"per-minute rate limit"}}', { 'retry-after': '0' });
      }
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode('event: message_stop\ndata: {"type":"message_stop"}\n\n')); c.close(); },
      });
      return { ok: true, status: 200, headers: new Headers(), body, text: async () => '' };
    };
    const events = await drain(callAnthropic(baseArgs(safeFetch) as any));
    expect(calls).toBe(2);
    expect(events[0].type).toBe('rate-limit-pause');
  });
});

describe('callOpenRouter — hard usage/credit limit', () => {
  test('a 402 (insufficient credits) throws ProviderUsageLimitError on the FIRST attempt', async () => {
    let calls = 0;
    const safeFetch = async () => {
      calls++;
      return stubResponse(402, '{"error":{"message":"Insufficient credits"}}');
    };
    let thrown: any;
    try { await drain(callOpenRouter(baseArgs(safeFetch) as any)); }
    catch (e) { thrown = e; }
    expect(calls).toBe(1);
    expect(thrown).toBeInstanceOf(ProviderUsageLimitError);
    expect(thrown.status).toBe(402);
  });
});
