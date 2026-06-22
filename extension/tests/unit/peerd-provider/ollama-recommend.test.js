// @ts-check
// GPU capability probe — in-browser coverage.
//
// The pure recommendation logic is bun-tested
// (tests/peerd-provider/ollama-recommend.test.ts); what NEEDS a browser
// is probeGpuCapability: the navigator.gpu / deviceMemory /
// hardwareConcurrency reads and their degradation paths. Fake navigators
// pin the mapping; one smoke test runs against the REAL navigator (the
// runner is a document context, same as the side panel) and only asserts
// shape — headless Chrome may or may not expose WebGPU.

import { describe, it, expect } from '../../framework.js';
import {
  probeGpuCapability,
  recommendOllamaModel,
} from '/peerd-provider/ollama-recommend.js';

const GIB = 2 ** 30;

// The probe reads only a few experimental Navigator surfaces. These
// deliberately-minimal fakes stand in for the full Navigator the param
// declares — cast to that type so TS treats the partial as the real one.
/** @typedef {Navigator & { deviceMemory?: number, gpu?: GPU }} ProbeNavigator */

describe('probeGpuCapability — injected navigator', () => {
  it('reads adapter limits + secondary signals', async () => {
    const cap = await probeGpuCapability({
      nav: /** @type {ProbeNavigator} */ ({
        deviceMemory: 8,
        hardwareConcurrency: 12,
        gpu: {
          requestAdapter: async () => /** @type {GPUAdapter} */ ({
            limits: { maxBufferSize: 16 * GIB, maxStorageBufferBindingSize: 4 * GIB },
          }),
        },
      }),
    });
    // gpu is non-null on this fake; narrow for the field reads below.
    const gpu = /** @type {NonNullable<typeof cap.gpu>} */ (cap.gpu);
    expect(gpu.maxBufferSizeGB).toBe(16);
    expect(gpu.maxStorageBufferBindingSizeGB).toBe(4);
    expect(cap.deviceMemoryGB).toBe(8);
    expect(cap.hardwareConcurrency).toBe(12);
  });

  it('degrades to gpu:null when WebGPU is absent', async () => {
    const cap = await probeGpuCapability({
      nav: /** @type {ProbeNavigator} */ ({ deviceMemory: 4, hardwareConcurrency: 4 }),
    });
    expect(cap.gpu).toBe(null);
    expect(cap.deviceMemoryGB).toBe(4);
  });

  it('degrades to gpu:null when requestAdapter rejects (GPU blocklisted)', async () => {
    const cap = await probeGpuCapability({
      // via unknown: this fake GPU only stubs requestAdapter (returning a
      // rejection), so it doesn't structurally overlap the full GPU type.
      nav: /** @type {ProbeNavigator} */ (/** @type {unknown} */ ({
        deviceMemory: 8,
        hardwareConcurrency: 8,
        gpu: { requestAdapter: async () => { throw new Error('denied'); } },
      })),
    });
    expect(cap.gpu).toBe(null);
  });

  it('degrades to all-null on a navigator that reveals nothing', async () => {
    const cap = await probeGpuCapability({ nav: /** @type {ProbeNavigator} */ ({}) });
    expect(cap).toEqual({ gpu: null, deviceMemoryGB: null, hardwareConcurrency: null });
    // …and the pure half turns that into a graceful "none", not a throw.
    expect(recommendOllamaModel(cap).confidence).toBe('none');
    expect(recommendOllamaModel(cap).model).toBe(null);
  });
});

describe('probeGpuCapability — real navigator (smoke)', () => {
  it('returns the capability shape without throwing', async () => {
    const cap = await probeGpuCapability();
    expect('gpu' in cap).toBe(true);
    expect('deviceMemoryGB' in cap).toBe(true);
    expect('hardwareConcurrency' in cap).toBe(true);
    if (cap.gpu !== null) {
      expect(typeof cap.gpu.maxBufferSizeGB).toBe('number');
    }
    // Whatever the machine reveals, the recommendation is well-formed.
    const rec = recommendOllamaModel(cap);
    expect(['high', 'low', 'none'].includes(rec.confidence)).toBe(true);
  });
});
