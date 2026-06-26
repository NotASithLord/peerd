// web/gemma.js — on-device Gemma over WebGPU for peerd-lite.
//
// A faithful port of the extension's offscreen/local-model.js: same model
// (onnx-community/gemma-4-E2B-it-ONNX, text-only Gemma4ForCausalLM, q4f16,
// device:webgpu), same vendored transformers.js 4.2.0 + ORT asyncify, same
// TextStreamer streaming, same chat formatting. The extension hosts this in
// the offscreen doc only because its MV3 service worker can't keep a long-lived
// WebGPU context; in a plain page we just run it on the main thread. The only
// edit vs the extension: drop the webextension-polyfill (use localStorage for
// the "downloaded" flag). Weights (~3 GB) stream from HF once, then the browser
// Cache API serves them on every later visit.

const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';
const MODEL_LABEL = 'Gemma 4 E2B';
const DOWNLOADED_KEY = 'peerd-lite:gemmaDownloaded';

let tx = null, tokenizer = null, model = null, loadingPromise = null;
let downloaded = false;
try { downloaded = localStorage.getItem(DOWNLOADED_KEY) === '1'; } catch { /* storage off */ }
const markDownloaded = () => { downloaded = true; try { localStorage.setItem(DOWNLOADED_KEY, '1'); } catch {} };

const probeCachedWeights = async () => {
  try {
    if (typeof caches === 'undefined') return false;
    for (const name of await caches.keys()) {
      const reqs = await (await caches.open(name)).keys();
      if (reqs.some((req) => /gemma-4-e2b/i.test(req.url) && /\.onnx(_data)?(\?|$)/i.test(req.url))) return true;
    }
  } catch { /* no Cache API / blocked */ }
  return false;
};
const detectDownloaded = (async () => { if (!downloaded && await probeCachedWeights()) markDownloaded(); })();

const loadTransformers = async () => {
  if (tx) return tx;
  tx = await import('/vendor/transformers/transformers.js');
  tx.env.backends.onnx.wasm.wasmPaths = '/vendor/transformers/';
  tx.env.allowRemoteModels = true;
  tx.env.allowLocalModels = false;
  return tx;
};

export const probeWebgpu = async () => {
  if (!navigator.gpu) return { ok: false, reason: 'WebGPU is unavailable in this browser.' };
  let adapter;
  try { adapter = await navigator.gpu.requestAdapter(); } catch { adapter = null; }
  if (!adapter) return { ok: false, reason: 'No WebGPU adapter (GPU blocked or unavailable).' };
  if (!adapter.features.has('shader-f16')) return { ok: false, reason: 'GPU lacks shader-f16 (needed for q4f16).' };
  const lim = adapter.limits || {};
  const maxStorage = Number(lim.maxStorageBufferBindingSize) || 0;
  const maxBuffer = Number(lim.maxBufferSize) || 0;
  console.log('[gemma] WebGPU adapter limits', { maxStorageBufferBindingSize: maxStorage, maxBufferSize: maxBuffer });
  return { ok: true, maxStorage, maxBuffer };
};

// Gemma-4-E2B's 1.59 GB per-layer embedding table is a single WebGPU storage
// binding, so the GPU must allow ≥ ~1.8 GB per binding (and a >3 GB buffer) or
// the model can't instantiate. We gate on it (a touch below 1.8 GB to avoid
// false negatives) so an incapable GPU gets a clear message instead of a
// silent stall during the post-download compile.
const MIN_STORAGE = 1.6e9;
const MIN_BUFFER = 3.0e9;

export const gemmaStatus = async () => {
  await detectDownloaded;
  return { available: !!model, downloaded, loading: !!loadingPromise, model: 'gemma-4-e2b', label: MODEL_LABEL };
};

/**
 * Load Gemma (downloads ~3 GB on first call, then served from the browser cache).
 * Idempotent + single-flight. onProgress mirrors transformers.js, with an
 * aggregated `overall` % across all weight files so the bar never jumps backward.
 * @param {(p: any) => void} [onProgress]
 */
export const initGemma = async (onProgress = () => {}) => {
  if (model) return { available: true };
  if (loadingPromise) return loadingPromise;
  const report = (phase, extra = {}) => { try { onProgress({ status: 'phase', phase, ...extra }); } catch {} };
  const fileBytes = new Map();
  const withOverall = (p) => {
    if (p && p.file) {
      if (p.status === 'done') {
        const prev = fileBytes.get(p.file);
        const total = typeof p.total === 'number' ? p.total : prev?.total;
        if (typeof total === 'number' && total > 0) fileBytes.set(p.file, { loaded: total, total });
      } else if (typeof p.total === 'number' && p.total > 0) {
        fileBytes.set(p.file, { loaded: typeof p.loaded === 'number' ? p.loaded : 0, total: p.total });
      }
    }
    if (fileBytes.size === 0) return p;
    let overallLoaded = 0, overallTotal = 0;
    for (const { loaded, total } of fileBytes.values()) { overallLoaded += loaded; overallTotal += total; }
    const overall = overallTotal > 0 ? Math.min(100, (overallLoaded / overallTotal) * 100) : undefined;
    return { ...p, overall, overallLoaded, overallTotal };
  };
  const tap = () => (p) => onProgress(withOverall(p));
  loadingPromise = (async () => {
    report('probing WebGPU');
    const cap = await probeWebgpu();
    if (!cap.ok) throw new Error(cap.reason);
    if (cap.maxStorage && cap.maxStorage < MIN_STORAGE) {
      throw new Error(`This GPU allows only ${Math.round(cap.maxStorage / 1e6)} MB per storage buffer; Gemma-4-E2B needs ~1.8 GB, so it can't fit on this GPU. (A discrete/desktop GPU usually works.)`);
    }
    if (cap.maxBuffer && cap.maxBuffer < MIN_BUFFER) {
      throw new Error(`This GPU's max buffer is ${Math.round(cap.maxBuffer / 1e6)} MB; Gemma-4-E2B needs ~3 GB and can't fit here.`);
    }
    report('loading transformers.js (vendored)');
    const t = await loadTransformers();
    report('loading tokenizer + config');
    tokenizer = await t.AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback: tap() });
    report('streaming model weights (~3 GB on first run, then cached)');
    model = await t.Gemma4ForCausalLM.from_pretrained(MODEL_ID, { dtype: 'q4f16', device: 'webgpu', progress_callback: tap() });
    markDownloaded();
    report('ready');
    return { available: true };
  })();
  try { return await loadingPromise; }
  catch (e) { console.error('[gemma] init failed:', e); tokenizer = null; model = null; throw e; }
  finally { loadingPromise = null; }
};

export const teardownGemma = async () => { try { await model?.dispose?.(); } catch {} model = null; tokenizer = null; };

// Gemma has no system role → fold system into the first user turn. Content blocks
// (text / tool_use / tool_result) render to text the same way the extension does.
const toChat = (messages, system) => {
  const flat = (content) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((b) => {
      if (b?.type === 'text') return b.text ?? '';
      if (b?.type === 'tool_use') return `<tool_call>${JSON.stringify({ name: b.name, arguments: b.input })}</tool_call>`;
      if (b?.type === 'tool_result') return `<tool_result>${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}</tool_result>`;
      return '';
    }).join('\n');
  };
  const out = messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: flat(m.content) }));
  if (system && out.length && out[0].role === 'user') out[0].content = `${system}\n\n${out[0].content}`;
  else if (system) out.unshift({ role: 'user', content: system });
  return out;
};

/**
 * Stream a generation. Calls onToken(text) per chunk; resolves when done.
 * Greedy decode for determinism. Tools are templated in; the caller parses
 * the <tool_call> blocks Gemma emits.
 * @param {{ messages: readonly any[], system?: string, tools?: readonly any[], maxTokens?: number }} req
 * @param {(text: string) => void} onToken
 */
export const generateGemma = async (req, onToken) => {
  if (!model || !tokenizer) { if (downloaded) await initGemma(); if (!model || !tokenizer) throw new Error('Gemma not loaded'); }
  const t = tx;
  const messages = toChat(req.messages ?? [], req.system ?? '');
  const prompt = tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true, tokenize: false,
    tools: req.tools && req.tools.length ? req.tools : undefined,
  });
  const inputs = await tokenizer(prompt);
  const streamer = new t.TextStreamer(tokenizer, {
    skip_prompt: true, skip_special_tokens: true,
    callback_function: (text) => { if (text) onToken(text); },
  });
  await model.generate({ ...inputs, max_new_tokens: req.maxTokens ?? 512, do_sample: false, streamer });
};
