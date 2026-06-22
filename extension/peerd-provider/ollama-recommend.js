// @ts-check
// Ollama model recommendation — "which local model fits this machine?"
//
// Two halves, split on the functional-core / imperative-shell line:
//
//   probeGpuCapability()    — IMPERATIVE. Reads navigator.gpu adapter
//                             limits (+ deviceMemory, hardwareConcurrency).
//                             Only works in a document context (side
//                             panel / settings) — NOT the service worker.
//   recommendOllamaModel()  — PURE. Capability snapshot in, tier pick
//                             out. Bun-testable without a browser.
//
// The tier table is deliberately small, data-driven, and easy to edit as
// the local-model landscape moves. One model per size class, all from a
// tool-capable family — peerd is an agent harness, so a local model that
// can't call tools would demo as broken.

/**
 * @typedef {Object} OllamaModelTier
 * @property {string} model     ollama id (`ollama pull <model>`)
 * @property {string} label     human name for the UI
 * @property {string} sizeClass approximate parameter class ("~8B")
 * @property {number} q4SizeGB  approximate q4 download/weights size
 * @property {number} needsGB   memory the model plausibly needs to run
 *                              (q4 weights + KV cache + runtime headroom)
 */

// Ordered LARGEST FIRST — recommendation picks the first tier that fits,
// so order is load-bearing (a sanity test pins it). needsGB is the
// editable knob: weights + ~2GB headroom, rounded to be conservative.
// Snapshot 2026-06; revisit as model families move.
/** @type {ReadonlyArray<OllamaModelTier>} */
export const OLLAMA_MODEL_TIERS = Object.freeze([
  Object.freeze({ model: 'qwen3:32b', label: 'Qwen3 32B', sizeClass: '~30B', q4SizeGB: 20,  needsGB: 24 }),
  Object.freeze({ model: 'qwen3:14b', label: 'Qwen3 14B', sizeClass: '~14B', q4SizeGB: 9.3, needsGB: 12 }),
  Object.freeze({ model: 'qwen3:8b',  label: 'Qwen3 8B',  sizeClass: '~8B',  q4SizeGB: 5.2, needsGB: 7 }),
  Object.freeze({ model: 'qwen3:4b',  label: 'Qwen3 4B',  sizeClass: '~4B',  q4SizeGB: 2.6, needsGB: 4 }),
]);

const GIB = 2 ** 30;

/**
 * @typedef {Object} GpuCapability
 * @property {{ maxBufferSizeGB: number, maxStorageBufferBindingSizeGB: number } | null} gpu
 *   WebGPU adapter limits, or null when WebGPU is unavailable/denied.
 * @property {number | null} deviceMemoryGB    navigator.deviceMemory (Chrome clamps to [0.25, 8])
 * @property {number | null} hardwareConcurrency
 */

/**
 * Probe the machine through what a browser is willing to reveal.
 * Degrades to nulls instead of throwing — a machine we can't read is a
 * recommendation we can't make, not an error.
 *
 * `deviceMemory` + `gpu` are experimental Navigator surfaces not yet in the
 * lib DOM types, so the param widens Navigator to declare them.
 *
 * @param {{ nav?: Navigator & { deviceMemory?: number, gpu?: GPU } }} [deps]
 *   test seam: inject a fake navigator
 * @returns {Promise<GpuCapability>}
 */
export const probeGpuCapability = async ({ nav = globalThis.navigator } = {}) => {
  /** @type {GpuCapability} */
  const out = {
    gpu: null,
    deviceMemoryGB: typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null,
    hardwareConcurrency: typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
  };
  try {
    const adapter = nav?.gpu ? await nav.gpu.requestAdapter() : null;
    if (adapter?.limits) {
      out.gpu = {
        maxBufferSizeGB: Number(adapter.limits.maxBufferSize) / GIB || 0,
        maxStorageBufferBindingSizeGB: Number(adapter.limits.maxStorageBufferBindingSize) / GIB || 0,
      };
    }
  } catch {
    // requestAdapter can reject (e.g. GPU blocklisted) — same as absent.
  }
  return out;
};

// Chrome clamps navigator.deviceMemory to at most 8 — a reading of 8
// means "8GB OR MORE", every bigger machine reports the same number.
const DEVICE_MEMORY_CLAMP_GB = 8;

/**
 * Estimate how much memory a local model could plausibly use. PURE —
 * heuristic by necessity (browsers deliberately blur hardware), so every
 * rule says why:
 *
 *   - WebGPU maxBufferSize is the strongest signal: it tracks the GPU
 *     heap (unified memory on Apple Silicon, VRAM-ish on discrete), and
 *     it is NOT clamped the way deviceMemory is.
 *   - deviceMemory / 2: on a CPU/iGPU box the model shares RAM with
 *     everything else; half is a conservative usable share.
 *   - deviceMemory == 8 is the CLAMP, not a measurement. With many
 *     cores (>= 12) the machine is very likely 16GB+, so we credit the
 *     full 8 instead of 4 — still conservative for a real 32GB box.
 *
 * @param {GpuCapability} cap
 * @returns {{ usableMemGB: number | null, signals: string[] }}
 */
export const estimateUsableMemGB = (cap) => {
  /** @type {string[]} */
  const signals = [];
  /** @type {number | null} */
  let usable = null;
  const gpuGB = cap?.gpu?.maxBufferSizeGB;
  // typeof narrows the optional field to number for the comparisons below;
  // Number.isFinite still rejects NaN/Infinity exactly as before.
  if (typeof gpuGB === 'number' && Number.isFinite(gpuGB) && gpuGB > 0) {
    usable = gpuGB;
    signals.push('webgpu');
  }
  const memGB = cap?.deviceMemoryGB;
  if (typeof memGB === 'number' && Number.isFinite(memGB) && memGB > 0) {
    const cores = cap?.hardwareConcurrency ?? 0;
    const clampedHighEnd = memGB >= DEVICE_MEMORY_CLAMP_GB && cores >= 12;
    const ram = clampedHighEnd ? memGB : memGB / 2;
    usable = Math.max(usable ?? 0, ram);
    signals.push('device-memory');
  }
  return { usableMemGB: usable, signals };
};

/**
 * Pick the largest tier that plausibly fits the machine. PURE.
 *
 * @param {GpuCapability} cap
 * @param {ReadonlyArray<OllamaModelTier>} [tiers]
 * @returns {{
 *   model: string | null, label: string | null, sizeClass: string | null,
 *   q4SizeGB: number | null, needsGB: number | null,
 *   usableMemGB: number | null,
 *   confidence: 'high' | 'low' | 'none',
 *   signals: string[],
 * }}
 *   `confidence` is 'high' with a WebGPU reading, 'low' on coarse
 *   signals only, 'none' when the browser revealed nothing (model is
 *   null then — the caller decides the graceful fallback).
 */
export const recommendOllamaModel = (cap, tiers = OLLAMA_MODEL_TIERS) => {
  const { usableMemGB, signals } = estimateUsableMemGB(cap);
  const confidence = signals.includes('webgpu') ? 'high'
    : signals.length > 0 ? 'low'
    : 'none';
  const tier = usableMemGB === null ? null
    : tiers.find((t) => t.needsGB <= usableMemGB) ?? null;
  return {
    model: tier?.model ?? null,
    label: tier?.label ?? null,
    sizeClass: tier?.sizeClass ?? null,
    q4SizeGB: tier?.q4SizeGB ?? null,
    needsGB: tier?.needsGB ?? null,
    usableMemGB,
    confidence,
    signals,
  };
};
