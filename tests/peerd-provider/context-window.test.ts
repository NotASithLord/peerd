// Per-model context-window resolution — override > live > table > unknown.

import { describe, test, expect } from 'bun:test';
import {
  resolveContextWindow,
  contextWindowFor,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_CONTEXT_WINDOWS,
} from '../../extension/peerd-provider/context-window.js';

describe('resolveContextWindow', () => {
  test('known table models resolve to their window', () => {
    // Current Opus/Sonnet (4.6+) are 1M by default; Haiku 4.5 is 200K.
    expect(resolveContextWindow('claude-opus-4-8')).toEqual({ window: 1_000_000, known: true });
    expect(resolveContextWindow('claude-sonnet-4-6')).toEqual({ window: 1_000_000, known: true });
    expect(resolveContextWindow('claude-haiku-4-5')).toEqual({ window: 200_000, known: true });
    expect(resolveContextWindow('openai/gpt-4o')).toEqual({ window: 128_000, known: true });
    expect(resolveContextWindow('google/gemini-2.0-flash')).toEqual({ window: 1_048_576, known: true });
  });

  test('unknown models are flagged not-known (caller skips the token trigger)', () => {
    const r = resolveContextWindow('some/unlisted-model');
    expect(r.known).toBe(false);
    expect(r.window).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor('some/unlisted-model')).toBe(null);
  });

  test('user override wins over the table', () => {
    expect(resolveContextWindow('claude-opus-4-8', { overrides: { 'claude-opus-4-8': 500_000 } }))
      .toEqual({ window: 500_000, known: true });
  });

  test('a live provider-reported window wins over the table but not an override', () => {
    // Live value for an otherwise-unknown local model → known.
    expect(resolveContextWindow('qwen3:0.6b', { live: 8192 })).toEqual({ window: 8192, known: true });
    // Override beats live.
    expect(resolveContextWindow('qwen3:8b', { live: 8192, overrides: { 'qwen3:8b': 4096 } }))
      .toEqual({ window: 4096, known: true });
  });

  test('garbage overrides / live values are ignored, falling through', () => {
    for (const bad of [0, -5, NaN, Infinity, 'x' as any, null as any]) {
      expect(resolveContextWindow('openai/gpt-4o', { overrides: { 'openai/gpt-4o': bad } }).window)
        .toBe(128_000);
      expect(resolveContextWindow('some/unlisted', { live: bad }).known).toBe(false);
    }
  });

  test('table values are positive integers', () => {
    for (const w of Object.values(DEFAULT_CONTEXT_WINDOWS)) {
      expect(Number.isInteger(w)).toBe(true);
      expect(w).toBeGreaterThan(0);
    }
  });
});
