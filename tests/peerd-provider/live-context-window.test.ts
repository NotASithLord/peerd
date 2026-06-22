// Live context-window lookups for OpenRouter (/api/v1/models context_length)
// and Ollama (/api/show num_ctx → model_info context_length). All IO is
// injected; every failure path returns null (never throws) so the trim
// trigger falls back to the static table.

import { describe, test, expect } from 'bun:test';
import { fetchOpenRouterContextWindow } from '../../extension/peerd-provider/adapters/openrouter.js';
import { fetchOllamaContextWindow } from '../../extension/peerd-provider/adapters/ollama.js';

const ok = (obj: any) => ({ ok: true, status: 200, async json() { return obj; }, async text() { return JSON.stringify(obj); } });
const notOk = (status = 404) => ({ ok: false, status, async json() { return {}; }, async text() { return 'err'; } });

describe('fetchOpenRouterContextWindow', () => {
  const getSecret = async () => 'or-key';
  const models = { data: [
    { id: 'openai/gpt-4o', context_length: 128_000 },
    { id: 'x/y', top_provider: { context_length: 65_536 } }, // only top_provider
  ] };

  test('returns context_length for the matching model', async () => {
    let url = '';
    const safeFetch = async (u: any) => { url = String(u); return ok(models) as any; };
    expect(await fetchOpenRouterContextWindow({ model: 'openai/gpt-4o', getSecret, safeFetch })).toBe(128_000);
    expect(url).toContain('/api/v1/models');
  });

  test('falls back to top_provider.context_length', async () => {
    const safeFetch = async () => ok(models) as any;
    expect(await fetchOpenRouterContextWindow({ model: 'x/y', getSecret, safeFetch })).toBe(65_536);
  });

  test('takes the SMALLER (served) of context_length and top_provider.context_length', async () => {
    // top-level is the nominal max across providers; top_provider is what the
    // routed provider actually serves — the conservative value avoids overflow.
    const served = { data: [{ id: 'm/big', context_length: 131_072, top_provider: { context_length: 32_768 } }] };
    expect(await fetchOpenRouterContextWindow({ model: 'm/big', getSecret, safeFetch: async () => ok(served) as any })).toBe(32_768);
  });

  test('null when the model is not in the list', async () => {
    const safeFetch = async () => ok(models) as any;
    expect(await fetchOpenRouterContextWindow({ model: 'unknown/model', getSecret, safeFetch })).toBe(null);
  });

  test('works without a key (public endpoint) and tolerates non-OK / bad json / reject', async () => {
    expect(await fetchOpenRouterContextWindow({ model: 'openai/gpt-4o', safeFetch: async () => ok(models) as any })).toBe(128_000);
    expect(await fetchOpenRouterContextWindow({ model: 'openai/gpt-4o', getSecret, safeFetch: async () => notOk() as any })).toBe(null);
    expect(await fetchOpenRouterContextWindow({ model: 'openai/gpt-4o', getSecret, safeFetch: async () => ({ ok: true, async json() { throw new Error('x'); } }) as any })).toBe(null);
    expect(await fetchOpenRouterContextWindow({ model: 'openai/gpt-4o', getSecret, safeFetch: async () => { throw new TypeError('down'); } })).toBe(null);
  });
});

describe('fetchOllamaContextWindow', () => {
  test('prefers a configured num_ctx from parameters', async () => {
    const safeFetch = async () => ok({
      parameters: 'stop "<|im_end|>"\nnum_ctx 8192\ntemperature 0.7',
      model_info: { 'qwen3.context_length': 40_960 },
    }) as any;
    expect(await fetchOllamaContextWindow({ model: 'qwen3:8b', safeFetch })).toBe(8192);
  });

  test('parses a quoted num_ctx value', async () => {
    const safeFetch = async () => ok({ parameters: 'num_ctx "16384"' }) as any;
    expect(await fetchOllamaContextWindow({ model: 'm', safeFetch })).toBe(16384);
  });

  test('takes the LAST num_ctx when the params blob has overrides (last-wins)', async () => {
    const safeFetch = async () => ok({ parameters: 'num_ctx 8192\ntemperature 0.7\nnum_ctx 32768' }) as any;
    expect(await fetchOllamaContextWindow({ model: 'm', safeFetch })).toBe(32768);
  });

  test('falls back to the architecture context_length when num_ctx is unset', async () => {
    const safeFetch = async () => ok({ model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40_960 } }) as any;
    expect(await fetchOllamaContextWindow({ model: 'qwen3:8b', safeFetch })).toBe(40_960);
  });

  test('null when neither signal is present, and on non-OK / bad json / reject', async () => {
    expect(await fetchOllamaContextWindow({ model: 'm', safeFetch: async () => ok({ model_info: {} }) as any })).toBe(null);
    expect(await fetchOllamaContextWindow({ model: 'm', safeFetch: async () => notOk(500) as any })).toBe(null);
    expect(await fetchOllamaContextWindow({ model: 'm', safeFetch: async () => ({ ok: true, async json() { throw new Error('x'); } }) as any })).toBe(null);
    expect(await fetchOllamaContextWindow({ model: 'm', safeFetch: async () => { throw new TypeError('daemon down'); } })).toBe(null);
  });

  test('null on a missing model id without a request', async () => {
    let fetched = false;
    await fetchOllamaContextWindow({ model: '', safeFetch: async () => { fetched = true; return ok({}) as any; } });
    expect(fetched).toBe(false);
  });
});
