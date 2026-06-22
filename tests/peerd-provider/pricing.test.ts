// Pricing ↔ catalog parity guard.
//
// DEFAULT_PRICING (peerd-provider/pricing.js) and the SW's MODEL_CATALOG
// drifted once already: catalog models with no rate card silently priced
// at $0, and a rate card existed for a model that doesn't. The catalog
// lives in background/service-worker.js, which can't be imported under
// Bun (chrome.* at module scope) — so this test reads the SW SOURCE and
// extracts the Anthropic catalog ids textually. If either table changes
// without the other, this fails in the terminal.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PRICING, costOf, resolvePricing } from '../../extension/peerd-provider/pricing.js';

const swPath = join(import.meta.dir, '../../extension/background/service-worker.js');

/** Extract the Anthropic model ids out of the SW's MODEL_CATALOG literal. */
const anthropicCatalogIds = (): string[] => {
  const src = readFileSync(swPath, 'utf8');
  const catalog = src.match(/const MODEL_CATALOG = Object\.freeze\(\{([\s\S]*?)\}\);/);
  if (!catalog) throw new Error('MODEL_CATALOG literal not found in service-worker.js');
  const anthropic = catalog[1].match(/anthropic:\s*\[([\s\S]*?)\]/);
  if (!anthropic) throw new Error('anthropic entry not found in MODEL_CATALOG');
  return [...anthropic[1].matchAll(/model:\s*'([^']+)'/g)].map((m) => m[1]);
};

describe('DEFAULT_PRICING ↔ MODEL_CATALOG parity', () => {
  test('every Anthropic catalog id has a rate card', () => {
    const ids = anthropicCatalogIds();
    // Guard the extractor itself — an empty list would vacuously pass.
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
});
