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
 * Per-model minimum hardware + the engine's load recipe. One entry per shipped
 * on-device model; the offscreen engine, the Settings cards, the chat picker and
 * the runner all read THIS table rather than hard-coding a model.
 *
 * Gemma-4-E2B: the load-bearing tensor is the 1.59 GB embed table (Per-Layer
 * Embeddings), so a single WebGPU storage binding must hold it - hence ~1.8 GB
 * (with headroom for intermediate activations). Apple Silicon + discrete GPUs
 * pass; many integrated GPUs cap storage bindings far below this.
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
 *
 * `repo` / `modelClass` / `dtype` are the LOAD RECIPE: the HF repo the weights
 * stream from, the Transformers.js class the engine instantiates, and the
 * quantization. why `modelClass` is a NAME, not a value: it doubles as the
 * runtime-support probe - the engine looks the class up on the vendored
 * Transformers.js module, so a model whose architecture that build doesn't
 * carry is detected as unrunnable BEFORE a multi-GB download starts, and
 * unlocks itself with no code edit once the vendor pin catches up
 * (scripts/vendor-transformers.sh). See engineSupportsSpec in
 * offscreen/local-model.js.
 *
 * `cachePattern` matches the weight URLs Transformers.js writes into the Cache
 * API, so a model downloaded by a PREVIOUS install is detected as resident
 * without a re-download.
 *
 * `specVerified` is false while the hardware figures are derived from the
 * model card rather than a real on-device load. why it's a field and not a
 * comment: the Settings card renders the caveat, so an unverified number can
 * never quietly read as a measured one.
 *
 * @typedef {{ id: string, label: string, url: string, repo: string, modelClass: string,
 *   dtype: string, cachePattern: string, sizeGB: number, minStorageBufferBindingSizeGB: number,
 *   minBufferSizeGB: number, requiresShaderF16: boolean, contextWindow: number,
 *   specVerified: boolean, note?: string }} ModelSpec
 */
export const MODEL_SPECS = Object.freeze({
  'gemma-4-e2b': Object.freeze({
    id: 'gemma-4-e2b',
    label: 'Gemma 4 E2B',
    url: 'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX',
    repo: 'onnx-community/gemma-4-E2B-it-ONNX',
    // TEXT-ONLY path: Gemma4ForCausalLM (not Gemma4ForConditionalGeneration) loads
    // embed_tokens + decoder and skips the vision/audio encoders the runner never uses.
    modelClass: 'Gemma4ForCausalLM',
    dtype: 'q4f16',
    cachePattern: 'gemma-4-e2b',
    sizeGB: 3.1,
    minStorageBufferBindingSizeGB: 1.8,
    minBufferSizeGB: 3.2,
    requiresShaderF16: true,
    contextWindow: 32_768,
    specVerified: true,
  }),
  // Muse Glimmer 30B (Meta, Apache-2.0) - the agentic on-device model behind
  // webml-community/muse-glimmer-webgpu-kernels. Listed so the option exists the
  // moment it can run, but it is NOT loadable on the currently vendored
  // Transformers.js (4.2.0 - the latest published, and its `main` branch too -
  // ships no `muse_glimmer` architecture, so `MuseGlimmerForCausalLM` is absent
  // and the engine's support probe locks the card). Two things must land before
  // this unlocks, and BOTH are upstream, not here:
  //   1. a Transformers.js build carrying the architecture (re-run
  //      scripts/vendor-transformers.sh - the probe flips on its own), and
  //   2. a browser-loadable ONNX export; `repo` below is the conventional
  //      onnx-community name for it and is UNCONFIRMED.
  // The hardware figures are model-card arithmetic (30B ≈ 2B ViT + 28B decoder,
  // ~17 GB at 4-bit), hence specVerified:false - and note that a tensor that size
  // exceeds what WebGPU can bind on today's consumer hardware, which is exactly
  // what judgeModelCapability will tell a user who runs the test.
  'muse-glimmer-30b': Object.freeze({
    id: 'muse-glimmer-30b',
    label: 'Muse Glimmer 30B',
    url: 'https://huggingface.co/spaces/webml-community/muse-glimmer-webgpu-kernels',
    repo: 'onnx-community/Muse-Glimmer-30B-ONNX',
    modelClass: 'MuseGlimmerForCausalLM',
    dtype: 'q4f16',
    cachePattern: 'muse-glimmer',
    // ~29.6B params including the ~1.8B ViT-G/14 perception encoder; the model
    // card puts the 4-bit language model "under 20 GB" and ships a 17 GB K-quant
    // targeting 24 GB VRAM. We load the TEXT-ONLY causal path (the runner never
    // sends images), so 17 is the figure to beat.
    sizeGB: 17,
    minStorageBufferBindingSizeGB: 4,
    minBufferSizeGB: 18,
    requiresShaderF16: true,
    contextWindow: 131_072,
    specVerified: false,
    note: 'Sizes are from the model card, not a measured on-device load.',
  }),
});

/** The model the runner/picker defaults to - the one that actually runs today. */
export const DEFAULT_LOCAL_MODEL_ID = 'gemma-4-e2b';

/** Every shipped on-device model, in display order. @returns {ModelSpec[]} */
export const listLocalModelSpecs = () => Object.values(MODEL_SPECS);

/**
 * Look up one spec by model id (undefined for an unknown id - callers decide
 * whether that's a refusal or a fall-back to the default).
 * @param {string} id
 * @returns {ModelSpec | undefined}
 */
export const localModelSpec = (id) =>
  /** @type {Record<string, ModelSpec | undefined>} */ (MODEL_SPECS)[id];

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
