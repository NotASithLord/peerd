import { describe, test, expect } from 'bun:test';
// @ts-ignore — JS module with JSDoc types
import { MODEL_SPECS, judgeModelCapability } from '../../extension/peerd-provider/local-model-capability.js';

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
