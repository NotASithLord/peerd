// Ollama model recommendation — pure logic, terminal-runnable.
//
// The PROBE (navigator.gpu) is in-browser-only and covered by
// extension/tests/unit/peerd-provider/ollama-recommend.test.js; this
// file pins the pure half: the tier table's shape, the memory-estimate
// heuristics, and the tier pick for representative machine profiles.

import { describe, test, expect } from 'bun:test';
import {
  OLLAMA_MODEL_TIERS,
  estimateUsableMemGB,
  recommendOllamaModel,
} from '../../extension/peerd-provider/ollama-recommend.js';
import type { GpuCapability } from '../../extension/peerd-provider/ollama-recommend.js';
import { DEFAULT_PRICING } from '../../extension/peerd-provider/pricing.js';

describe('OLLAMA_MODEL_TIERS table sanity', () => {
  test('is non-empty and ordered largest-first (the pick depends on it)', () => {
    expect(OLLAMA_MODEL_TIERS.length).toBeGreaterThan(0);
    for (let i = 1; i < OLLAMA_MODEL_TIERS.length; i++) {
      expect(OLLAMA_MODEL_TIERS[i - 1].needsGB).toBeGreaterThan(OLLAMA_MODEL_TIERS[i].needsGB);
    }
  });

  test('every tier carries the fields the UI renders', () => {
    for (const t of OLLAMA_MODEL_TIERS) {
      expect(typeof t.model).toBe('string');
      expect(t.model.length).toBeGreaterThan(0);
      expect(typeof t.label).toBe('string');
      expect(typeof t.sizeClass).toBe('string');
      expect(t.q4SizeGB).toBeGreaterThan(0);
      // a model needs at least its own weights in memory
      expect(t.needsGB).toBeGreaterThan(t.q4SizeGB);
    }
  });

  test('every tier model has a ZERO rate card in DEFAULT_PRICING (CostChip honesty)', () => {
    for (const t of OLLAMA_MODEL_TIERS) {
      expect(DEFAULT_PRICING[t.model]).toEqual(
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  });
});

describe('estimateUsableMemGB', () => {
  test('WebGPU maxBufferSize is the primary signal', () => {
    const { usableMemGB, signals } = estimateUsableMemGB({
      gpu: { maxBufferSizeGB: 21, maxStorageBufferBindingSizeGB: 4 },
      deviceMemoryGB: 8,
      hardwareConcurrency: 10,
    });
    expect(usableMemGB).toBe(21);
    expect(signals).toContain('webgpu');
  });

  test('deviceMemory alone is halved (model shares RAM with everything)', () => {
    const { usableMemGB, signals } = estimateUsableMemGB({
      gpu: null, deviceMemoryGB: 4, hardwareConcurrency: 4,
    });
    expect(usableMemGB).toBe(2);
    expect(signals).toEqual(['device-memory']);
  });

  test('clamped deviceMemory (8) + many cores is credited in full', () => {
    // navigator.deviceMemory caps at 8 — a 12+-core machine reporting 8
    // is almost certainly 16GB+, so the halving would under-recommend.
    const { usableMemGB } = estimateUsableMemGB({
      gpu: null, deviceMemoryGB: 8, hardwareConcurrency: 16,
    });
    expect(usableMemGB).toBe(8);
  });

  test('no signals → null', () => {
    const { usableMemGB, signals } = estimateUsableMemGB({
      gpu: null, deviceMemoryGB: null, hardwareConcurrency: null,
    });
    expect(usableMemGB).toBeNull();
    expect(signals).toEqual([]);
  });
});

describe('recommendOllamaModel', () => {
  const profiles: Array<[string, GpuCapability, string | null, 'high' | 'low' | 'none']> = [
    // [name, capability, expected model, expected confidence]
    ['32GB unified-memory laptop (big GPU heap)',
      { gpu: { maxBufferSizeGB: 24, maxStorageBufferBindingSizeGB: 4 }, deviceMemoryGB: 8, hardwareConcurrency: 12 },
      'qwen3:32b', 'high'],
    ['16GB machine with mid GPU heap',
      { gpu: { maxBufferSizeGB: 12, maxStorageBufferBindingSizeGB: 4 }, deviceMemoryGB: 8, hardwareConcurrency: 8 },
      'qwen3:14b', 'high'],
    ['small discrete GPU (8GB heap)',
      { gpu: { maxBufferSizeGB: 8, maxStorageBufferBindingSizeGB: 2 }, deviceMemoryGB: 8, hardwareConcurrency: 8 },
      'qwen3:8b', 'high'],
    ['no WebGPU, 8GB RAM, few cores → conservative small tier',
      { gpu: null, deviceMemoryGB: 8, hardwareConcurrency: 8 },
      'qwen3:4b', 'low'],
    ['no WebGPU, clamped 8GB + 16 cores → mid tier on full credit',
      { gpu: null, deviceMemoryGB: 8, hardwareConcurrency: 16 },
      'qwen3:8b', 'low'],
    ['tiny machine — nothing fits',
      { gpu: null, deviceMemoryGB: 2, hardwareConcurrency: 2 },
      null, 'low'],
    ['no signals at all',
      { gpu: null, deviceMemoryGB: null, hardwareConcurrency: null },
      null, 'none'],
  ];

  for (const [name, cap, model, confidence] of profiles) {
    test(name, () => {
      const rec = recommendOllamaModel(cap);
      expect(rec.model).toBe(model);
      expect(rec.confidence).toBe(confidence);
    });
  }

  test('result carries the pull-hint fields when a tier fits', () => {
    const rec = recommendOllamaModel({
      gpu: { maxBufferSizeGB: 12, maxStorageBufferBindingSizeGB: 4 },
      deviceMemoryGB: 8, hardwareConcurrency: 8,
    });
    expect(rec.label).toBeTruthy();
    expect(rec.sizeClass).toBeTruthy();
    expect(rec.q4SizeGB).toBeGreaterThan(0);
    expect(rec.usableMemGB).toBe(12);
  });
});
