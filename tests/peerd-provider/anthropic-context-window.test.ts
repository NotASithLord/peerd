// fetchAnthropicContextWindow — the live Models API window lookup. All IO is
// injected (getSecret + safeFetch), so this exercises the parse/guard logic
// without a network or a browser. Best-effort: every failure path is null,
// never a throw, so the trim trigger falls back to the static table.

import { describe, test, expect } from 'bun:test';
import { fetchAnthropicContextWindow } from '../../extension/peerd-provider/adapters/anthropic.js';

const jsonResponse = (obj: any, ok = true, status = 200) => ({
  ok,
  status,
  async json() { return obj; },
  async text() { return JSON.stringify(obj); },
});

const getSecret = async () => 'sk-ant-test';

describe('fetchAnthropicContextWindow', () => {
  test('returns max_input_tokens from an OK response', async () => {
    let calledUrl = '';
    const safeFetch = async (url: any) => { calledUrl = String(url); return jsonResponse({ id: 'claude-opus-4-8', max_input_tokens: 1_000_000 }) as any; };
    const w = await fetchAnthropicContextWindow({ model: 'claude-opus-4-8', getSecret, safeFetch });
    expect(w).toBe(1_000_000);
    expect(calledUrl).toContain('/v1/models/claude-opus-4-8');
  });

  test('null when no API key is present', async () => {
    let fetched = false;
    const safeFetch = async () => { fetched = true; return jsonResponse({ max_input_tokens: 200_000 }) as any; };
    const w = await fetchAnthropicContextWindow({ model: 'claude-opus-4-8', getSecret: async () => null, safeFetch });
    expect(w).toBe(null);
    expect(fetched).toBe(false); // no key → no request
  });

  test('null on a non-OK response (404 unknown model)', async () => {
    const safeFetch = async () => jsonResponse({ error: 'not_found' }, false, 404) as any;
    expect(await fetchAnthropicContextWindow({ model: 'nope', getSecret, safeFetch })).toBe(null);
  });

  test('null on an unparseable body', async () => {
    const safeFetch = async () => ({ ok: true, status: 200, async json() { throw new Error('bad json'); } }) as any;
    expect(await fetchAnthropicContextWindow({ model: 'claude-opus-4-8', getSecret, safeFetch })).toBe(null);
  });

  test('null when the field is missing or not a positive number', async () => {
    for (const bad of [undefined, null, 0, -1, NaN, 'x']) {
      const safeFetch = async () => jsonResponse({ max_input_tokens: bad }) as any;
      expect(await fetchAnthropicContextWindow({ model: 'm', getSecret, safeFetch })).toBe(null);
    }
  });

  test('never throws when safeFetch rejects', async () => {
    const safeFetch = async () => { throw new TypeError('network down'); };
    expect(await fetchAnthropicContextWindow({ model: 'claude-opus-4-8', getSecret, safeFetch })).toBe(null);
  });

  test('null on a missing model id without touching the network', async () => {
    let fetched = false;
    const safeFetch = async () => { fetched = true; return jsonResponse({}) as any; };
    expect(await fetchAnthropicContextWindow({ model: '', getSecret, safeFetch })).toBe(null);
    expect(fetched).toBe(false);
  });
});
