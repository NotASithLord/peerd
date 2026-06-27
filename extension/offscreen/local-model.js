// @ts-check
// offscreen/local-model.js — the on-device inference engine (FEATURE-LOCAL-WEBGPU
// B / M1). Gemma-4-E2B runs here in the OFFSCREEN doc via Transformers.js +
// ONNX-Runtime-Web on WebGPU — never the SW (which idles out; WebGPU + the
// resident model need a long-lived document). The SW's local-webgpu adapter
// drives this over runtime messages; this module owns load + streaming generate.
//
// VENDORED, not CDN: the offscreen CSP is `script-src 'self'`, so Transformers.js
// + the ORT WASM are imported from /vendor/transformers/ (populated by
// scripts/vendor-transformers.sh). `connect-src https:` lets the model weights
// download from Hugging Face; Transformers.js caches them (Cache API) so the
// ~2–3 GB download is one-time.
//
// UNVERIFIED HERE: WebGPU + a 2–3 GB model can't run in CI — this is owner-
// load-tested. The two things the load-test confirms: (1) the q4f16 WebGPU load
// succeeds on the target machine, (2) Gemma's tool-call output matches the
// adapter's <tool_call> parser (the §3.3 lever if not). Everything else is
// mechanical message plumbing.

import browser from '/vendor/browser-polyfill.js';

// why this exact id/flow: the onnx-community Gemma-4-E2B model card's Transformers.js
// path, but the TEXT-ONLY variant — AutoTokenizer + Gemma4ForCausalLM, NOT
// AutoProcessor + Gemma4ForConditionalGeneration. The page runner only ever sends
// text, so the causal-LM path loads just embed_tokens + decoder (~3.1 GB) and skips
// the vision (~99 MB) + audio (~171 MB) encoders the multimodal class would pull.
// q4f16 on device:'webgpu', + a TextStreamer.
const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';
const MODEL_LABEL = 'Gemma 4 E2B'; // the name surfaces once downloaded (eval/Settings)

// why any: Transformers.js is a vendored, untyped WASM/ESM module (no .d.ts);
// its AutoTokenizer / Gemma4ForCausalLM / env shapes are type-erased here.
/** @type {any} */
let tx = null;        // the imported Transformers.js module (lazy — only on first init)
/** @type {any} */
let tokenizer = null;
/** @type {any} */
let model = null;
/** @type {Promise<{ available: boolean }> | null} */
let loadingPromise = null;
// "Weights are cached" — the in-memory model evaporates on every extension reload
// (the offscreen doc is torn down) but the weights stay in the browser cache. We
// detect that two ways: our persisted flag (fast), and — retroactively, for a model
// downloaded BEFORE the flag existed — by scanning the Cache API where
// Transformers.js stores the .onnx weight files. Either way: Settings/Lab show
// 'downloaded' (no re-download) and the model lazy-loads from cache on first use.
let downloaded = false;
const DOWNLOADED_KEY = 'localModelDownloaded';
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
// Resolves once we've decided whether the weights are cached. localModelStatus
// awaits it, so the first status read is accurate (no "Locked" flash for a model
// that's really there).
const detectDownloaded = (async () => {
  try { if ((await browser.storage?.local?.get?.(DOWNLOADED_KEY))?.[DOWNLOADED_KEY]) { downloaded = true; return; } } catch { /* storage off */ }
  if (await probeCachedWeights()) {
    downloaded = true;
    browser.storage?.local?.set?.({ [DOWNLOADED_KEY]: true }).catch(() => {}); // memoize so next time is instant
  }
})();

const loadTransformers = async () => {
  if (tx) return tx;
  // Vendored UNIVERSAL build (transformers.js — self-contained, inlines ORT). NOT
  // the "web" build: that externalizes onnxruntime-web via bare specifiers a
  // no-build/CSP browser can't resolve. The script writes it + the matching ORT
  // asyncify wasm runtime to /vendor/transformers/.
  tx = await import('/vendor/transformers/transformers.js');
  // Point ORT at the vendored WASM (no CDN under `script-src 'self'`), keep
  // remote MODEL weights enabled (they ride `connect-src https:` to HF + cache).
  tx.env.backends.onnx.wasm.wasmPaths = '/vendor/transformers/';
  tx.env.allowRemoteModels = true;
  tx.env.allowLocalModels = false;
  return tx;
};

/** Is WebGPU + f16 available? The capability gate (mirrors voice/engine-picker). */
export const probeWebgpu = async () => {
  if (!navigator.gpu) return { ok: false, reason: 'WebGPU is unavailable in this browser.' };
  let adapter;
  try { adapter = await navigator.gpu.requestAdapter(); } catch { adapter = null; }
  if (!adapter) return { ok: false, reason: 'No WebGPU adapter (GPU blocked or unavailable).' };
  if (!adapter.features.has('shader-f16')) return { ok: false, reason: 'GPU lacks shader-f16 (needed for q4f16).' };
  return { ok: true };
};

export const localModelStatus = async () => {
  await detectDownloaded; // ensure the cache probe finished → no false "not downloaded"
  return {
    available: !!model,      // loaded in memory, ready to generate NOW
    downloaded,              // weights cached (survives reloads) → loads fast from cache
    loading: !!loadingPromise,
    model: 'gemma-4-e2b',
    label: MODEL_LABEL,
  };
};

/**
 * Load the model (downloads weights on first call, then cached). Idempotent +
 * single-flight. `onProgress({ status, file, progress, loaded, total })` mirrors
 * Transformers.js's progress_callback so Settings can show a download bar.
 * @param {(p: object) => void} [onProgress]
 */
export const initLocalModel = async (onProgress = () => {}) => {
  if (model) return { available: true };
  if (loadingPromise) return loadingPromise;
  // why narrate: a stall is otherwise invisible (the offscreen doc has no UI).
  // These log to the offscreen console (chrome://extensions → peerd → Inspect
  // views: offscreen.html) AND emit a 'phase' progress event the eval surfaces,
  // so we can see exactly which step hangs — tokenizer vs the ~3.1 GB weights.
  /** @param {string} phase @param {object} [extra] */
  const report = (phase, extra = {}) => {
    console.log(`[local-model] ${phase}`, extra);
    try { onProgress({ status: 'phase', phase, ...extra }); } catch { /* no listener */ }
  };
  // why aggregate: Transformers.js reports progress PER FILE, and its `progress`
  // field resets to 0 each time a new weight file starts — so surfacing a single
  // file's % (the old behavior) makes the bar lurch backwards. Sum the latest
  // bytes across every file and attach ONE honest total % the UI can show.
  /** @type {Map<string, { loaded: number, total: number }>} */
  const fileBytes = new Map();
  /** @param {any} p @returns {any} */
  const withOverall = (p) => {
    if (p && p.file) {
      if (p.status === 'done') {
        // A 'done' event may omit total — fall back to the file's last-known size.
        const prev = fileBytes.get(p.file);
        const total = typeof p.total === 'number' ? p.total : prev?.total;
        if (typeof total === 'number' && total > 0) fileBytes.set(p.file, { loaded: total, total });
      } else if (typeof p.total === 'number' && p.total > 0) {
        fileBytes.set(p.file, { loaded: typeof p.loaded === 'number' ? p.loaded : 0, total: p.total });
      }
    }
    if (fileBytes.size === 0) return p;
    let overallLoaded = 0;
    let overallTotal = 0;
    for (const { loaded, total } of fileBytes.values()) { overallLoaded += loaded; overallTotal += total; }
    const overall = overallTotal > 0 ? Math.min(100, (overallLoaded / overallTotal) * 100) : undefined;
    return { ...p, overall, overallLoaded, overallTotal };
  };
  /** @param {string} label @returns {(p: object) => void} */
  const tap = (label) => (p) => { console.log(`[local-model] ${label}`, p); onProgress(withOverall(p)); };
  loadingPromise = (async () => {
    report('probing WebGPU');
    const cap = await probeWebgpu();
    if (!cap.ok) throw new Error(cap.reason);
    report('loading transformers.js (vendored)');
    const t = await loadTransformers();
    report('loading tokenizer + config (small)');
    tokenizer = await t.AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback: tap('tokenizer') });
    // Text-only causal LM: loads embed_tokens + decoder, SKIPS the vision/audio
    // encoders the multimodal Gemma4ForConditionalGeneration would pull (~270 MB
    // saved — the runner never sends images/audio). device:'webgpu' is the
    // supported hook; pre-created-device injection is the §6.2 open question.
    report('loading model weights (first run streams ~3.1 GB from HF — text-only)');
    model = await t.Gemma4ForCausalLM.from_pretrained(MODEL_ID, {
      dtype: 'q4f16', device: 'webgpu', progress_callback: tap('model'),
    });
    // Remember the weights are now cached, so a future reload skips the
    // re-download and just lazy-loads from cache.
    downloaded = true;
    browser.storage?.local?.set?.({ [DOWNLOADED_KEY]: true }).catch(() => {});
    report('ready');
    return { available: true };
  })();
  try { return await loadingPromise; }
  catch (e) { console.error('[local-model] init FAILED:', e); tokenizer = null; model = null; throw e; }
  finally { loadingPromise = null; }
};

export const teardownLocalModel = async () => {
  try { await model?.dispose?.(); } catch { /* best-effort */ }
  model = null; tokenizer = null;
};

// Flatten a peerd InternalMessage[] to the chat-template's {role, content}
// shape. Gemma has no system role, so the system framing is folded into the
// first user turn. Content blocks (text / tool_use / tool_result) are
// rendered to text — lossy but adequate for the narrow runner read/act task;
// the constrained-format lever (§3.3) is the upgrade if quality demands it.
/** @param {readonly any[]} messages @param {string} [system] */
const toChat = (messages, system) => {
  /** @param {any} content */
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
  const out = messages.map((/** @type {any} */ m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: flat(m.content) }));
  if (system && out.length && out[0].role === 'user') out[0].content = `${system}\n\n${out[0].content}`;
  else if (system) out.unshift({ role: 'user', content: system });
  return out;
};

/**
 * Stream a generation. Calls `onToken(text)` per decoded chunk; resolves when
 * done. Tools are templated into the prompt (the model emits <tool_call> blocks
 * the adapter parses). Greedy decode for determinism (a runner wants the same
 * action for the same page).
 *
 * @param {{ messages: readonly object[], system: string, tools?: readonly object[], maxTokens?: number }} req
 * @param {(text: string) => void} onToken
 */
export const generateLocal = async (req, onToken) => {
  if (!model || !tokenizer) {
    // Cached from a prior session but not loaded into this (fresh) offscreen doc:
    // load from cache on first use — no re-download, no manual step.
    if (downloaded) await initLocalModel();
    if (!model || !tokenizer) throw new Error('local model not loaded');
  }
  const t = tx;
  const messages = toChat(req.messages ?? [], req.system ?? '');
  // apply_chat_template templates the tools in (we own <tool_call> parsing).
  // tokenize:false → return the prompt string, then tokenize explicitly below.
  const prompt = tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    tokenize: false,
    tools: req.tools && req.tools.length ? req.tools : undefined,
  });
  const inputs = await tokenizer(prompt);
  const streamer = new t.TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (/** @type {string} */ text) => { if (text) onToken(text); },
  });
  await model.generate({ ...inputs, max_new_tokens: req.maxTokens ?? 512, do_sample: false, streamer });
};
