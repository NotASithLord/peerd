// @ts-check
// peerd-provider/local-model-capability.js — the hardware gate for local WebGPU
// models. A document/offscreen-context PROBE gathers GPU + system signals; a PURE
// judge turns those signals + a model's min-spec into a capable/not verdict. The
// Settings "Test" button runs the probe; the verdict unlocks (or explains) download.
//
// why a pure judge: the thresholds are policy, and policy wants a Bun test. The
// probe touches navigator.gpu/WebGL (browser-only); the judge is values-in/out.

const GB = 2 ** 30;

/**
 * Per-model minimum hardware. Gemma-4-E2B: the load-bearing tensor is the 1.59 GB
 * embed table (Per-Layer Embeddings), so a single WebGPU storage binding must hold
 * it — hence ~1.8 GB (with headroom for intermediate activations). Apple Silicon +
 * discrete GPUs pass; many integrated GPUs cap storage bindings far below this.
 *
 * `contextWindow` is the model's nominal context length (config
 * `max_position_embeddings`) — the canonical home for local-model metadata,
 * and the value the local-webgpu adapter reports through the SAME
 * provider context-window seam the API providers use (context-window.js).
 * It's a NOMINAL maximum: the on-device usable window is further bounded by
 * device memory (the KV cache grows with context), the same caveat as
 * Ollama's num_ctx — when the offscreen engine can report the resident
 * model's effective window, that LIVE value overrides this (see
 * setLocalModelInfo in local-webgpu.js).
 * @typedef {{ id: string, label: string, url: string, sizeGB: number, minStorageBufferBindingSizeGB: number, minBufferSizeGB: number, requiresShaderF16: boolean, contextWindow: number }} ModelSpec
 */
export const MODEL_SPECS = Object.freeze({
  'gemma-4-e2b': Object.freeze({
    id: 'gemma-4-e2b',
    label: 'Gemma 4 E2B',
    url: 'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX',
    sizeGB: 3.1,
    minStorageBufferBindingSizeGB: 1.8,
    minBufferSizeGB: 3.2,
    requiresShaderF16: true,
    contextWindow: 32_768,
  }),
});

/**
 * @typedef {Object} LocalModelCapability
 * @property {boolean} webgpu
 * @property {boolean} shaderF16
 * @property {number|null} maxStorageBufferBindingSizeGB
 * @property {number|null} maxBufferSizeGB
 * @property {string|null} gpuVendor
 * @property {string|null} gpuArchitecture
 * @property {string|null} webglRenderer
 * @property {number|null} deviceMemoryGB
 * @property {number|null} hardwareConcurrency
 */

/**
 * Probe the machine's GPU + system signals. Runs in a document/offscreen context
 * (needs navigator.gpu / WebGL). Never throws — a blocked/absent GPU just yields
 * `webgpu:false` and whatever coarse signals exist.
 * @param {{ nav?: any, OffscreenCanvasCtor?: any, doc?: any }} [deps]
 * @returns {Promise<LocalModelCapability>}
 */
export const probeLocalModelCapability = async ({
  nav = globalThis.navigator,
  OffscreenCanvasCtor = globalThis.OffscreenCanvas,
  doc = globalThis.document,
} = {}) => {
  /** @type {LocalModelCapability} */
  const out = {
    webgpu: false,
    shaderF16: false,
    maxStorageBufferBindingSizeGB: null,
    maxBufferSizeGB: null,
    gpuVendor: null,
    gpuArchitecture: null,
    webglRenderer: null,
    deviceMemoryGB: typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null,
    hardwareConcurrency: typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
  };
  try {
    const adapter = nav?.gpu ? await nav.gpu.requestAdapter() : null;
    if (adapter) {
      out.webgpu = true;
      out.shaderF16 = !!adapter.features?.has?.('shader-f16');
      if (adapter.limits) {
        out.maxBufferSizeGB = Number(adapter.limits.maxBufferSize) / GB || null;
        out.maxStorageBufferBindingSizeGB = Number(adapter.limits.maxStorageBufferBindingSize) / GB || null;
      }
      // adapter.info is a property in current Chrome; older builds expose
      // requestAdapterInfo(). Either is best-effort — vendor/arch are display-only.
      const info = adapter.info ?? (typeof adapter.requestAdapterInfo === 'function' ? await adapter.requestAdapterInfo() : null);
      if (info) { out.gpuVendor = info.vendor ?? null; out.gpuArchitecture = info.architecture ?? null; }
    }
  } catch { /* requestAdapter rejected (blocklisted/denied) → treat as absent */ }

  // WebGL renderer string is a coarse fallback signal when WebGPU is unavailable.
  if (!out.webgpu) {
    try {
      const canvas = OffscreenCanvasCtor ? new OffscreenCanvasCtor(1, 1)
        : (doc?.createElement ? doc.createElement('canvas') : null);
      const gl = canvas?.getContext?.('webgl2') ?? canvas?.getContext?.('webgl') ?? null;
      const dbg = gl?.getExtension?.('WEBGL_debug_renderer_info');
      if (gl && dbg) out.webglRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    } catch { /* no WebGL either */ }
  }
  return out;
};

/**
 * PURE: judge whether a model can run on the probed hardware. Tolerates a
 * partial capability object (missing signals → treated as unknown).
 * @param {Partial<LocalModelCapability>} cap
 * @param {ModelSpec} spec
 * @returns {{ capable: boolean, reason: string, confidence: 'high'|'low'|'none' }}
 */
export const judgeModelCapability = (cap, spec) => {
  if (!cap || !spec) return { capable: false, reason: 'no probe data', confidence: 'none' };

  if (cap.webgpu) {
    if (spec.requiresShaderF16 && !cap.shaderF16) {
      return { capable: false, reason: `GPU lacks shader-f16 (${spec.label} needs it for q4f16).`, confidence: 'high' };
    }
    // The decisive limit: can one storage binding hold the big embed tensor?
    if (typeof cap.maxStorageBufferBindingSizeGB === 'number') {
      const have = cap.maxStorageBufferBindingSizeGB;
      const need = spec.minStorageBufferBindingSizeGB;
      if (have >= need) {
        return { capable: true, reason: `WebGPU + shader-f16, ${have.toFixed(1)} GB storage binding ≥ ${need} GB needed.`, confidence: 'high' };
      }
      return { capable: false, reason: `WebGPU storage binding too small: ${have.toFixed(1)} GB < ${need} GB needed (the ${spec.label} embed tensor won't fit).`, confidence: 'high' };
    }
    // WebGPU + f16 present but limits unreadable — likely fine, but say so.
    return { capable: true, reason: `WebGPU + shader-f16 present (buffer limits unreported — likely OK).`, confidence: 'low' };
  }

  // No WebGPU → coarse RAM estimate only. WebGL/deviceMemory can't confirm the
  // storage-binding limit, so this is a low-confidence guess at best.
  if (typeof cap.deviceMemoryGB === 'number') {
    const usable = (cap.hardwareConcurrency ?? 0) >= 12 && cap.deviceMemoryGB >= 8
      ? cap.deviceMemoryGB
      : cap.deviceMemoryGB / 2;
    if (usable >= spec.minBufferSizeGB) {
      return { capable: false, reason: `No WebGPU on this browser — ${spec.label} needs it. (~${usable.toFixed(0)} GB RAM looks sufficient, but WebGPU is required.)`, confidence: 'low' };
    }
    return { capable: false, reason: `No WebGPU, and ~${usable.toFixed(0)} GB usable RAM < ${spec.minBufferSizeGB} GB.`, confidence: 'low' };
  }
  return { capable: false, reason: 'No WebGPU and no hardware signals available.', confidence: 'none' };
};
