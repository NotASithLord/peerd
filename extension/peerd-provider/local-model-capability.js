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
 * `engine` names WHICH vendored runtime loads this model - the engine table in
 * offscreen/local-model.js dispatches on it:
 *   - 'transformers'  → Transformers.js + ONNX-Runtime-Web (ONNX exports).
 *   - 'muse-glimmer'  → the vendored Muse Glimmer WebGPU GGUF runtime
 *     (vendor/muse-glimmer/ - custom WGSL kernels, its own GGUF loader).
 * why a field and not a heuristic: the runtimes have disjoint formats (ONNX vs
 * GGUF), caches and APIs; which one a model needs is a fact about the model,
 * so it lives on the spec.
 *
 * `repo` / `file` / `modelClass` / `dtype` are the LOAD RECIPE: the HF repo the
 * weights stream from, the specific weight file inside it (GGUF engines only;
 * null where the runtime resolves files itself), the Transformers.js class the
 * engine instantiates ('transformers' only), and the quantization.
 *
 * `modelClass` is OPTIONAL and means "load through THIS exact class" - use it
 * only to pin a narrower path than the architecture's default, the way Gemma
 * pins the text-only causal LM to skip its vision and audio encoders. Leave it
 * NULL for a model that should load through AutoModelForCausalLM: the engine
 * then reads the repo's own config and asks the runtime whether it dispatches
 * that architecture. why null is the better default: a class name is a guess
 * about how someone published an export, and a wrong guess locks a model that
 * would have run - the repo's config cannot be wrong about what it is. Either
 * way the check happens BEFORE a multi-GB download and re-answers itself when
 * the vendor pin moves (scripts/vendor-transformers.sh). See engineSupportsSpec
 * in offscreen/local-model.js. (Non-transformers engines ignore it.)
 *
 * `cachePattern` matches the weight URLs Transformers.js writes into the Cache
 * API, so a model downloaded by a PREVIOUS install is detected as resident
 * without a re-download. (Cache-probe is a 'transformers' retrofit; the
 * muse-glimmer engine postdates the persisted download record and relies on it.)
 *
 * `specVerified` is false while the hardware figures are derived from the
 * model card rather than a real on-device load. why it's a field and not a
 * comment: the Settings card renders the caveat, so an unverified number can
 * never quietly read as a measured one.
 *
 * @typedef {{ id: string, label: string, url: string, engine: 'transformers' | 'muse-glimmer',
 *   repo: string, file: string | null, modelClass: string | null,
 *   dtype: string, cachePattern: string, sizeGB: number, minStorageBufferBindingSizeGB: number,
 *   minBufferSizeGB: number, requiresShaderF16: boolean, contextWindow: number,
 *   specVerified: boolean, note?: string }} ModelSpec
 */
export const MODEL_SPECS = Object.freeze({
  'gemma-4-e2b': Object.freeze({
    id: 'gemma-4-e2b',
    label: 'Gemma 4 E2B',
    url: 'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX',
    engine: /** @type {const} */ ('transformers'),
    repo: 'onnx-community/gemma-4-E2B-it-ONNX',
    file: null,
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
  // webml-community/muse-glimmer-webgpu-kernels. It does NOT load through
  // Transformers.js (which is ONNX-only): the Space ships its own WebGPU GGUF
  // runtime (custom WGSL kernels + GGUF loader), vendored at
  // vendor/muse-glimmer/, and this entry loads through THAT engine. repo/file
  // are the runtime's own defaults (its DEFAULT_MODEL_ID / DEFAULT_GGUF_FILE),
  // so peerd streams exactly the artifact the Space runs.
  //
  // requiresShaderF16 is FALSE: the runtime's kernel manifests prefer f16
  // variants but carry f32 fallbacks, and its own checkSupport (run in
  // engineSupportsSpec before any download) is the authoritative per-device
  // gate - a spec-level f16 refusal here would lock devices the runtime
  // handles.
  //
  // Hardware figures are arithmetic, not a measured load (specVerified:false):
  // the UD-Q2_K_XL file is ~12.4 GB and the KV cache adds ~0.1 MB/token
  // (~1.7 GB at the engine's 16K cache), so ~14 GB of GPU memory is the honest
  // floor. WebGPU exposes no total-VRAM signal, so the hardware test's binding
  // check is a coarse screen - the download itself is the final arbiter, and a
  // machine that cannot hold the weights fails at allocation with a clear
  // error, not silently.
  'muse-glimmer-30b': Object.freeze({
    id: 'muse-glimmer-30b',
    label: 'Muse Glimmer 30B',
    url: 'https://huggingface.co/spaces/webml-community/muse-glimmer-webgpu-kernels',
    engine: /** @type {const} */ ('muse-glimmer'),
    repo: 'unsloth/Muse-Glimmer-30B-GGUF',
    file: 'Muse-Glimmer-30B-UD-Q2_K_XL.gguf',
    modelClass: null,
    dtype: 'q2_k_xl',
    cachePattern: 'muse-glimmer',
    sizeGB: 12.4,
    minStorageBufferBindingSizeGB: 2,
    minBufferSizeGB: 14,
    requiresShaderF16: false,
    contextWindow: 131_072,
    specVerified: false,
    note: 'Sizes are file-size arithmetic, not a measured on-device load.',
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
