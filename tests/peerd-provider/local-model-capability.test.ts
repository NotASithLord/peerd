import { describe, test, expect } from 'bun:test';
// @ts-ignore — JS module with JSDoc types
import {
  MODEL_SPECS, DEFAULT_LOCAL_MODEL_ID, listLocalModelSpecs, localModelSpec, judgeModelCapability,
} from '../../extension/peerd-provider/local-model-capability.js';

const SPEC = MODEL_SPECS['gemma-4-e2b'];

describe('judgeModelCapability (gemma-4-e2b)', () => {
  test('capable: WebGPU + shader-f16 + a big storage binding (Apple Silicon / discrete)', () => {
    const v = judgeModelCapability({ webgpu: true, shaderF16: true, maxStorageBufferBindingSizeGB: 4, maxBufferSizeGB: 16 }, SPEC);
    expect(v.capable).toBe(true);
    expect(v.confidence).toBe('high');
  });

  test('not capable: GPU lacks shader-f16 (q4f16 needs it)', () => {
    const v = judgeModelCapability({ webgpu: true, shaderF16: false, maxStorageBufferBindingSizeGB: 8 }, SPEC);
    expect(v.capable).toBe(false);
    expect(v.confidence).toBe('high');
    expect(v.reason).toContain('shader-f16');
  });

  test('not capable: storage binding too small for the 1.59GB embed tensor (integrated GPU)', () => {
    // 128 MB default storage-binding limit — common on weak/integrated GPUs.
    const v = judgeModelCapability({ webgpu: true, shaderF16: true, maxStorageBufferBindingSizeGB: 0.125 }, SPEC);
    expect(v.capable).toBe(false);
    expect(v.confidence).toBe('high');
    expect(v.reason).toContain('too small');
  });

  test('exactly at the threshold passes', () => {
    expect(judgeModelCapability({ webgpu: true, shaderF16: true, maxStorageBufferBindingSizeGB: SPEC.minStorageBufferBindingSizeGB }, SPEC).capable).toBe(true);
  });

  test('low confidence: WebGPU + f16 but limits unreadable → optimistic but flagged', () => {
    const v = judgeModelCapability({ webgpu: true, shaderF16: true, maxStorageBufferBindingSizeGB: null }, SPEC);
    expect(v.capable).toBe(true);
    expect(v.confidence).toBe('low');
  });

  test('not capable: no WebGPU at all (it is required), even with plenty of RAM', () => {
    const v = judgeModelCapability({ webgpu: false, deviceMemoryGB: 16, hardwareConcurrency: 16 }, SPEC);
    expect(v.capable).toBe(false);
    expect(v.reason).toMatch(/WebGPU/i);
  });

  test('none: no probe data', () => {
    expect(judgeModelCapability(null as any, SPEC).confidence).toBe('none');
    expect(judgeModelCapability({ webgpu: false } as any, SPEC).confidence).toBe('none');
  });
});

describe('the on-device model registry', () => {
  test('every spec carries a complete load recipe - a half-declared model would fail deep inside the load', () => {
    for (const spec of listLocalModelSpecs()) {
      expect(spec.id).toBeTruthy();
      expect(spec.label).toBeTruthy();
      expect(['transformers', 'muse-glimmer']).toContain(spec.engine); // a runtime the engine table dispatches
      expect(spec.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);   // an HF repo id, not a URL
      // modelClass pins a narrower transformers path; null = the Auto path (or a
      // non-transformers engine, which ignores it).
      if (spec.modelClass !== null) expect(spec.modelClass).toMatch(/^[A-Z]\w+$/);
      // A GGUF engine must pin its exact weight file: the repo ships several
      // quants and "whichever the runtime defaults to" could silently change.
      if (spec.engine === 'muse-glimmer') expect(spec.file).toMatch(/\.gguf$/);
      else expect(spec.file).toBeNull();
      expect(spec.dtype).toBeTruthy();
      expect(spec.cachePattern).toBeTruthy();
      expect(spec.sizeGB).toBeGreaterThan(0);
      expect(spec.contextWindow).toBeGreaterThan(0);
      expect(typeof spec.requiresShaderF16).toBe('boolean');
      expect(typeof spec.specVerified).toBe('boolean');
      // The cache probe pairs cachePattern with the weight-file suffix; a pattern
      // that cannot match its own repo would re-download an installed model.
      expect(new RegExp(spec.cachePattern, 'i').test(spec.repo)).toBe(true);
    }
  });

  test('ids are unique and the default resolves to a real spec', () => {
    const ids = listLocalModelSpecs().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(localModelSpec(DEFAULT_LOCAL_MODEL_ID)?.id).toBe(DEFAULT_LOCAL_MODEL_ID);
  });

  test('the key and the id agree - the table is looked up both ways', () => {
    for (const [key, spec] of Object.entries(MODEL_SPECS)) expect(spec.id as string).toBe(key);
  });

  test('an unknown id is undefined, never a silent fallback to another model', () => {
    expect(localModelSpec('gemma-9-xxl')).toBeUndefined();
    expect(localModelSpec('')).toBeUndefined();
  });

  test('the judge is spec-driven: each verdict comes from the model\'s own floor, not a shared constant', () => {
    // A binding limit between the two floors (Gemma 1.8 GB, Muse 2 GB): the
    // same probe passes one model and refuses the other, named.
    const laptop = { webgpu: true, shaderF16: true, maxStorageBufferBindingSizeGB: 1.9, maxBufferSizeGB: 8 };
    expect(judgeModelCapability(laptop, MODEL_SPECS['gemma-4-e2b']).capable).toBe(true);
    const big = judgeModelCapability(laptop, MODEL_SPECS['muse-glimmer-30b']);
    expect(big.capable).toBe(false);
    expect(big.reason).toContain('Muse Glimmer 30B');
  });

  test('the muse spec does not demand shader-f16 (its kernels carry f32 fallbacks)', () => {
    // A no-f16 device must not be spec-refused: the vendored runtime's own
    // checkSupport is the authoritative per-device gate for this engine.
    const noF16 = { webgpu: true, shaderF16: false, maxStorageBufferBindingSizeGB: 4, maxBufferSizeGB: 16 };
    expect(judgeModelCapability(noF16, MODEL_SPECS['muse-glimmer-30b']).capable).toBe(true);
  });
});
