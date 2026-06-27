// Local WebGPU context window — unified with the API providers' seam.
// fetchLocalContextWindow prefers a live engine-reported window (when the
// bridge is wired via setLocalModelInfo) and falls back to the canonical
// MODEL_SPECS value. A parity test pins MODEL_SPECS ↔ the cold-start table
// so the two can't drift.

import { describe, test, expect, afterEach } from 'bun:test';
import {
  fetchLocalContextWindow, setLocalModelInfo, LOCAL_MODEL_ID,
} from '../../extension/peerd-provider/adapters/local-webgpu.js';
import { MODEL_SPECS } from '../../extension/peerd-provider/local-model-capability.js';
import { DEFAULT_CONTEXT_WINDOWS } from '../../extension/peerd-provider/context-window.js';

afterEach(() => setLocalModelInfo(null)); // never leak a wired bridge across tests

describe('fetchLocalContextWindow', () => {
  test('falls back to the static MODEL_SPECS window when no engine bridge is wired', async () => {
    expect(await fetchLocalContextWindow({ model: LOCAL_MODEL_ID }))
      .toBe(MODEL_SPECS[LOCAL_MODEL_ID].contextWindow);
  });

  test('defaults the model to the actor id', async () => {
    expect(await fetchLocalContextWindow()).toBe(MODEL_SPECS[LOCAL_MODEL_ID].contextWindow);
  });

  test('a wired engine value overrides the static spec', async () => {
    setLocalModelInfo(() => 65_536);
    expect(await fetchLocalContextWindow({ model: LOCAL_MODEL_ID })).toBe(65_536);
  });

  test('an async engine value is awaited', async () => {
    setLocalModelInfo(async () => 8192);
    expect(await fetchLocalContextWindow({ model: LOCAL_MODEL_ID })).toBe(8192);
  });

  test('a bad/throwing engine value falls back to the spec, never throws', async () => {
    for (const bad of [0, -1, NaN, null, 'x' as any]) {
      setLocalModelInfo(() => bad as any);
      expect(await fetchLocalContextWindow({ model: LOCAL_MODEL_ID }))
        .toBe(MODEL_SPECS[LOCAL_MODEL_ID].contextWindow);
    }
    setLocalModelInfo(() => { throw new Error('engine not ready'); });
    expect(await fetchLocalContextWindow({ model: LOCAL_MODEL_ID }))
      .toBe(MODEL_SPECS[LOCAL_MODEL_ID].contextWindow);
  });

  test('null for an unknown local model with no spec and no live value', async () => {
    expect(await fetchLocalContextWindow({ model: 'no-such-local-model' })).toBe(null);
  });
});

describe('local-model schema parity', () => {
  test('every MODEL_SPECS contextWindow matches the cold-start table entry', () => {
    for (const [id, spec] of Object.entries(MODEL_SPECS)) {
      expect(typeof spec.contextWindow).toBe('number');
      expect(spec.contextWindow).toBeGreaterThan(0);
      // The static table is the cold-start fallback; it must agree with the
      // canonical spec so the first turn (live cache cold) isn't wrong.
      expect(DEFAULT_CONTEXT_WINDOWS[id]).toBe(spec.contextWindow);
    }
  });
});
