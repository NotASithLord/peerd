// fetchAnthropicContextWindow is the live model window lookup. Authority is
// injected as one exact operation, so this exercises the parse/guard logic
// without a network or a browser. Best-effort: every failure path is null,
// never a throw, so the trim trigger falls back to the static table.

import { describe, test, expect } from 'bun:test';
import { fetchAnthropicContextWindow } from '../../extension/peerd-provider/adapters/anthropic.js';
import { makeModelEgress } from './model-egress-fixture';

const jsonResponse = (obj: any, ok = true, status = 200) => ({
  ok,
  status,
  async json() { return obj; },
  async text() { return JSON.stringify(obj); },
});

describe('fetchAnthropicContextWindow', () => {
  test('returns max_input_tokens from an OK response', async () => {
    let request: any;
    const modelEgress = makeModelEgress({ readModelContext: async (args: any) => {
      request = args;
      return jsonResponse({ id: 'claude-opus-4-8', max_input_tokens: 1_000_000 }) as any;
    } });
    const w = await fetchAnthropicContextWindow({ model: 'claude-opus-4-8', modelEgress });
    expect(w).toBe(1_000_000);
    expect(request.providerId).toBe('anthropic');
    expect(request.modelId).toBe('claude-opus-4-8');
  });

  test('null when authority rejects the context read', async () => {
    const modelEgress = makeModelEgress({ readModelContext: async () => { throw new Error('credential unavailable'); } });
    expect(await fetchAnthropicContextWindow({ model: 'claude-opus-4-8', modelEgress })).toBe(null);
  });

  test('null on a non-OK response (404 unknown model)', async () => {
    const modelEgress = makeModelEgress({ readModelContext: async () => jsonResponse({ error: 'not_found' }, false, 404) as any });
    expect(await fetchAnthropicContextWindow({ model: 'nope', modelEgress })).toBe(null);
  });

  test('null on an unparseable body', async () => {
    const modelEgress = makeModelEgress({ readModelContext: async () => ({ ok: true, status: 200, async json() { throw new Error('bad json'); } }) as any });
    expect(await fetchAnthropicContextWindow({ model: 'claude-opus-4-8', modelEgress })).toBe(null);
  });

  test('null when the field is missing or not a positive number', async () => {
    for (const bad of [undefined, null, 0, -1, NaN, 'x']) {
      const modelEgress = makeModelEgress({ readModelContext: async () => jsonResponse({ max_input_tokens: bad }) as any });
      expect(await fetchAnthropicContextWindow({ model: 'm', modelEgress })).toBe(null);
    }
  });

  test('never throws when authority rejects', async () => {
    const modelEgress = makeModelEgress({ readModelContext: async () => { throw new TypeError('network down'); } });
    expect(await fetchAnthropicContextWindow({ model: 'claude-opus-4-8', modelEgress })).toBe(null);
  });

  test('null on a missing model id without touching the network', async () => {
    let fetched = false;
    const modelEgress = makeModelEgress({ readModelContext: async () => { fetched = true; return jsonResponse({}) as any; } });
    expect(await fetchAnthropicContextWindow({ model: '', modelEgress })).toBe(null);
    expect(fetched).toBe(false);
  });
});
