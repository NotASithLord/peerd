// Local WebGPU context window — unified with the API providers' seam.
// fetchLocalContextWindow prefers a live authority-reported engine window and
// falls back to the canonical
// MODEL_SPECS value. A parity test pins MODEL_SPECS ↔ the cold-start table
// so the two can't drift.

import { describe, test, expect } from 'bun:test';
import { fetchLocalContextWindow, LOCAL_MODEL_ID } from '../../extension/peerd-provider/adapters/local-webgpu.js';
import { MODEL_SPECS } from '../../extension/peerd-provider/local-model-capability.js';
import { DEFAULT_CONTEXT_WINDOWS } from '../../extension/peerd-provider/context-window.js';
import { makeModelEgress } from './model-egress-fixture';

describe('fetchLocalContextWindow', () => {
  test('falls back to the static MODEL_SPECS window when no engine bridge is wired', async () => {
    expect(await fetchLocalContextWindow({ model: LOCAL_MODEL_ID }))
      .toBe(MODEL_SPECS[LOCAL_MODEL_ID].contextWindow);
  });

  test('defaults the model to the actor id', async () => {
    expect(await fetchLocalContextWindow()).toBe(MODEL_SPECS[LOCAL_MODEL_ID].contextWindow);
  });

  test('an authority-reported engine value overrides the static spec', async () => {
    const modelEgress = makeModelEgress({ readModelContext: async () => new Response(JSON.stringify({ contextWindow: 65_536 })) });
    expect(await fetchLocalContextWindow({ model: LOCAL_MODEL_ID, modelEgress })).toBe(65_536);
  });

  test('an async engine value is awaited', async () => {
    const modelEgress = makeModelEgress({ readModelContext: async () => new Response(JSON.stringify({ contextWindow: 8192 })) });
    expect(await fetchLocalContextWindow({ model: LOCAL_MODEL_ID, modelEgress })).toBe(8192);
  });

  test('a WIRED bridge that fails or answers badly yields null - never the static value', async () => {
    // why: the caller caches a returned number for the SW's lifetime as if it
    // were live. Handing it the static value on a transient bridge failure
    // would freeze the nominal in place of the engine's enforced window; null
    // leaves the miss uncached so the next turn retries.
    for (const bad of [0, -1, NaN, null, 'x' as any]) {
      const modelEgress = makeModelEgress({ readModelContext: async () => new Response(JSON.stringify({ contextWindow: bad })) });
      expect(await fetchLocalContextWindow({ model: LOCAL_MODEL_ID, modelEgress })).toBe(null);
    }
    const modelEgress = makeModelEgress({ readModelContext: async () => { throw new Error('engine not ready'); } });
    expect(await fetchLocalContextWindow({ model: LOCAL_MODEL_ID, modelEgress })).toBe(null);
  });

  test('the unwired fallback for a capped engine is the ENFORCED window, not the nominal', async () => {
    expect(await fetchLocalContextWindow({ model: 'muse-glimmer-30b' }))
      .toBe(MODEL_SPECS['muse-glimmer-30b'].enforcedContextWindow);
  });

  test('null for an unknown local model with no spec and no live value', async () => {
    expect(await fetchLocalContextWindow({ model: 'no-such-local-model' })).toBe(null);
  });
});

describe('local-model schema parity', () => {
  test('every cold-start table entry matches the spec\'s ENFORCED window', () => {
    for (const [id, spec] of Object.entries(MODEL_SPECS) as [string, { contextWindow: number, enforcedContextWindow?: number }][]) {
      expect(typeof spec.contextWindow).toBe('number');
      expect(spec.contextWindow).toBeGreaterThan(0);
      if (spec.enforcedContextWindow !== undefined) {
        // A declared engine cap must be a real cap, not an accidental raise.
        expect(spec.enforcedContextWindow).toBeGreaterThan(0);
        expect(spec.enforcedContextWindow).toBeLessThanOrEqual(spec.contextWindow);
      }
      // The static table is the cold-start fallback; it must agree with the
      // bound the engine will actually enforce, so the first turn (live cache
      // cold) budgets against reality.
      expect(DEFAULT_CONTEXT_WINDOWS[id]).toBe(spec.enforcedContextWindow ?? spec.contextWindow);
    }
  });
});
