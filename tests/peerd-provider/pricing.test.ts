// Pricing ↔ catalog parity guard.
//
// DEFAULT_PRICING and the controller-owned provider catalog drifted once
// already: catalog models with no rate card silently priced at $0, and a rate
// card existed for a model that doesn't. Both tables are pure controller data,
// so this test compares them directly.

import { describe, test, expect } from 'bun:test';
import { DEFAULT_PRICING, costOf, resolvePricing } from '../../extension/peerd-provider/pricing.js';
import { PROVIDER_MODEL_CATALOG } from '../../extension/peerd-provider/metadata.js';

describe('DEFAULT_PRICING ↔ MODEL_CATALOG parity', () => {
  test('every Anthropic catalog id has a rate card', () => {
    const ids = PROVIDER_MODEL_CATALOG.anthropic.map((row) => row.model);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(DEFAULT_PRICING[id]).toBeDefined();
    }
  });

  test('no rate card exists for the nonexistent claude-haiku-4-6', () => {
    expect(DEFAULT_PRICING['claude-haiku-4-6']).toBeUndefined();
  });

  test('local (keyless) providers price unknown models as a KNOWN $0', () => {
    // why: an Ollama model the user pulled yesterday isn't in any table,
    // but it still genuinely costs $0 — the CostChip should say so
    // instead of "estimate unavailable".
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costOf('some-random:7b', usage, undefined, { localProvider: true }))
      .toEqual({ cost: 0, estimated: true });
    // Cloud path unchanged: unknown id stays unknown.
    expect(costOf('some-random:7b', usage)).toEqual({ cost: 0, estimated: false });
    // A user override still wins even on a local provider.
    const ovr = { 'some-random:7b': { output: 1 } };
    expect(resolvePricing('some-random:7b', ovr, { localProvider: true }).rates.output).toBe(1);
  });

  test('current Anthropic rates match the published table (USD / MTok)', () => {
    // Snapshot of platform pricing (2026-06): Opus tier $5/$25,
    // Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5. cacheRead = 0.1x input,
    // cacheWrite = 1.25x input (5-minute ephemeral TTL).
    expect(DEFAULT_PRICING['claude-opus-4-8']).toEqual(
      { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(DEFAULT_PRICING['claude-opus-4-6']).toEqual(
      { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
    expect(DEFAULT_PRICING['claude-sonnet-4-6']).toEqual(
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    expect(DEFAULT_PRICING['claude-haiku-4-5-20251001']).toEqual(
      { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });
  });

  test('Z.ai GLM rates are per-tier, not the flagship copied down', () => {
    // Regression guard: glm-4.6 shipped priced identically to the glm-5.2
    // flagship ($1.4/$4.4), a ~3x overestimate that inflated the CostChip and
    // tripped spend limits early. GLM-4.6 is a distinctly cheaper tier.
    // Source: docs.z.ai/guides/overview/pricing (2026-07, USD / MTok).
    expect(DEFAULT_PRICING['glm-5.2']).toEqual(
      { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
    expect(DEFAULT_PRICING['glm-4.6']).toEqual(
      { input: 0.43, output: 1.74, cacheRead: 0.08, cacheWrite: 0 });
    // the two tiers must NOT share a rate card
    expect(DEFAULT_PRICING['glm-4.6'].input).not.toBe(DEFAULT_PRICING['glm-5.2'].input);
  });
});
