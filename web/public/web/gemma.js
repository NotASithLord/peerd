// web/gemma.js — on-device LLM over WebGPU for peerd-lite (host side).
//
// A faithful port of the extension's offscreen/local-model.js: vendored
// transformers.js 4.2.0 + ORT asyncify, q4f16, device:webgpu, TextStreamer
// streaming, the same chat formatting. The model is capability-picked by the page
// (Gemma 3n E2B when the GPU's storage-buffer binding fits its ~1.1 GB embedding
// tensor; otherwise a smaller model like Qwen2.5-1.5B) and passed in via cfg.
// Weights stream from HF once, then the browser Cache API serves them later.
//
// The engine itself runs in a dedicated module worker (web/gemma-worker.js): the
// ORT WebGPU session-create deadlocks during compile on the page main thread
// (external-data + multithreaded WASM; worst on Apple Silicon/Metal), exactly as
// the official transformers.js demo avoids by using a worker. This file is the
// thin host: initGemma / generateGemma / teardownGemma, proxying progress +
// token streams across postMessage.

// Default config (Gemma 3n E2B) when initGemma is called without one — keeps the
// exported API back-compatible. index.html passes a capability-picked config.
const DEFAULT_CFG = { id: 'onnx-community/gemma-4-E2B-it-ONNX', label: 'Gemma 3n E2B', modelClass: 'Gemma4ForCausalLM', dtype: 'q4f16', minBindingGiB: 1.8, foldSystemIntoUser: true };

let worker = null, ready = false, loadingPromise = null, loadedCfg = null;
let progressCb = () => {};
let loadResolve = null, loadReject = null;
let genSeq = 0;
const genHandlers = new Map(); // id → { onToken, resolve, reject }

const ensureWorker = () => {
  if (worker) return worker;
  worker = new Worker('/web/gemma-worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data || {};
    switch (m.type) {
      case 'phase': try { progressCb({ status: 'phase', phase: m.phase }); } catch {} break;
      case 'progress': try { progressCb(m.p); } catch {} break;
      case 'ready':
        ready = true;
        loadResolve?.({ available: true }); loadResolve = loadReject = null;
        break;
      case 'error':
        loadReject?.(new Error(m.message)); loadResolve = loadReject = null;
        break;
      case 'token': { const h = genHandlers.get(m.id); if (h) h.onToken(m.text); break; }
      case 'genDone': { const h = genHandlers.get(m.id); if (h) { h.resolve(); genHandlers.delete(m.id); } break; }
      case 'genError': { const h = genHandlers.get(m.id); if (h) { h.reject(new Error(m.message)); genHandlers.delete(m.id); } break; }
      default: break;
    }
  };
  worker.onerror = (ev) => {
    const err = new Error(`Gemma worker crashed: ${  ev?.message || 'unknown error'}`);
    loadReject?.(err); loadResolve = loadReject = null;
    for (const [id, h] of genHandlers) { h.reject(err); genHandlers.delete(id); }
  };
  return worker;
};

/**
 * Load the model (downloads weights on first call, then served from the browser
 * cache). Idempotent + single-flight. onProgress mirrors transformers.js, with an
 * aggregated `overall` % across all weight files; phase steps arrive as
 * { status:'phase', phase }.
 * @param {(p: any) => void} [onProgress]
 * @param {{ id:string, label?:string, modelClass?:string, dtype?:string, minBindingGiB?:number, foldSystemIntoUser?:boolean }} [cfg]
 */
export const initGemma = async (onProgress = () => {}, cfg = DEFAULT_CFG) => {
  if (ready) return { available: true };
  progressCb = onProgress;
  if (loadingPromise) return loadingPromise;
  loadedCfg = { ...DEFAULT_CFG, ...(cfg || {}) };
  ensureWorker();
  loadingPromise = new Promise((resolve, reject) => { loadResolve = resolve; loadReject = reject; });
  worker.postMessage({ type: 'load', cfg: loadedCfg });
  try { return await loadingPromise; }
  finally { loadingPromise = null; }
};

export const teardownGemma = async () => {
  try { worker?.terminate(); } catch {}
  worker = null; ready = false; loadingPromise = null; loadedCfg = null;
  for (const [id, h] of genHandlers) { h.reject(new Error('torn down')); genHandlers.delete(id); }
};

/**
 * Stream a generation. Calls onToken(text) per chunk; resolves when done.
 * Greedy decode for determinism. Tools are templated in (worker side); the caller
 * parses the <tool_call> blocks the model emits. The host loads the model before
 * the agent is created, so by here `ready` is true.
 * @param {{ messages: readonly any[], system?: string, tools?: readonly any[], maxTokens?: number }} req
 * @param {(text: string) => void} onToken
 */
export const generateGemma = async (req, onToken) => {
  if (!ready) throw new Error('Model not loaded');
  const id = ++genSeq;
  return new Promise((resolve, reject) => {
    genHandlers.set(id, { onToken: (t) => { try { onToken(t); } catch {} }, resolve, reject });
    worker.postMessage({ type: 'generate', req, id });
  });
};
