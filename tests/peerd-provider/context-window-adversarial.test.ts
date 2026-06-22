// Adversarial inputs to the live context-window path. Provider responses are
// semi-trusted JSON; the window feeds a token budget, so a bad value must
// never (a) pollute Object.prototype, (b) be accepted as a window when it
// isn't a positive finite integer, or (c) throw.

import { describe, test, expect } from 'bun:test';
import { asWindow } from '../../extension/peerd-provider/model-window.js';
import { fetchAnthropicContextWindow } from '../../extension/peerd-provider/adapters/anthropic.js';
import { fetchOllamaContextWindow } from '../../extension/peerd-provider/adapters/ollama.js';
import { resolveContextWindow } from '../../extension/peerd-provider/context-window.js';

describe('asWindow — the single guard', () => {
  test('accepts only positive finite numbers, floored', () => {
    expect(asWindow(200000)).toBe(200000);
    expect(asWindow(128000.9)).toBe(128000); // floored
  });
  test('rejects everything else', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity, '200000', '128k', null, undefined, {}, [], true, 1e400]) {
      expect(asWindow(bad as any)).toBe(null);
    }
  });
});

const ok = (obj: any) => ({ ok: true, status: 200, async json() { return obj; }, async text() { return ''; } });

describe('live fetchers resist adversarial JSON', () => {
  const getSecret = async () => 'k';

  test('a __proto__ payload does not pollute Object.prototype and is not read as a window', async () => {
    // JSON.parse sets an OWN "__proto__" property (no pollution), so body.max_input_tokens is undefined.
    const poison = JSON.parse('{"__proto__": {"max_input_tokens": 999999}, "id": "x"}');
    const w = await fetchAnthropicContextWindow({ model: 'm', getSecret, safeFetch: async () => ok(poison) as any });
    expect(w).toBe(null);                       // not mined from the prototype
    expect(({} as any).max_input_tokens).toBeUndefined(); // prototype intact
  });

  test('string / non-finite / negative windows are rejected (no NaN budget)', async () => {
    for (const bad of ['200000', Number.NaN, -200000, 0]) {
      const w = await fetchAnthropicContextWindow({ model: 'm', getSecret, safeFetch: async () => ok({ max_input_tokens: bad }) as any });
      expect(w).toBe(null);
    }
  });

  test('Ollama num_ctx regex is linear on a pathological params blob (no ReDoS hang)', async () => {
    // A 200k-char blob with many near-matches; must return promptly.
    const blob = ('num_ct\n'.repeat(20000)) + 'num_ctx 4096\n' + ('  num_ctx  \n'.repeat(20000));
    const t0 = Date.now();
    const w = await fetchOllamaContextWindow({ model: 'm', safeFetch: async () => ok({ parameters: blob }) as any });
    expect(Date.now() - t0).toBeLessThan(500); // linear, not catastrophic
    expect(w).toBe(4096);
  });

  test('a malicious override of -1 / huge string can never set a window (resolver guard)', () => {
    // The resolver applies asWindow-equivalent guards to overrides too.
    expect(resolveContextWindow('claude-opus-4-8', { overrides: { 'claude-opus-4-8': -1 as any } }).window).toBe(1_000_000);
    expect(resolveContextWindow('claude-opus-4-8', { overrides: { 'claude-opus-4-8': '999' as any } }).window).toBe(1_000_000);
  });
});
