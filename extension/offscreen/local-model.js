// @ts-check
// offscreen/local-model.js — the on-device inference engine (FEATURE-LOCAL-WEBGPU
// B / M1). The registered on-device models run here in the OFFSCREEN doc via
// Transformers.js + ONNX-Runtime-Web on WebGPU - never the SW (which idles out;
// WebGPU + a resident model need a long-lived document). The SW's local-webgpu
// adapter drives this over runtime messages; this module owns residency, download
// bookkeeping and streaming generate.
//
// VENDORED, not CDN: the offscreen CSP is `script-src 'self'`, so Transformers.js
// + the ORT WASM are imported from /vendor/transformers/ (populated by
// scripts/vendor-transformers.sh). `connect-src https:` lets the model weights
// download from Hugging Face; Transformers.js caches them (Cache API) so the
// ~2–3 GB download is one-time.
//
// UNVERIFIED HERE: WebGPU + a multi-GB model can't run in CI - this is owner-
// load-tested per model. The two things the load-test confirms: (1) the q4f16
// WebGPU load succeeds on the target machine, (2) the model's tool-call output
// matches the adapter's <tool_call> parser (the §3.3 lever if not). Everything
// else is mechanical message plumbing. What CI CAN check is the step before
// that: whether the vendored runtime carries the architecture at all
// (engineSupportsSpec, asserted live in the options-local-models E2E state).

import browser from '/vendor/browser-polyfill.js';
import { DEFAULT_LOCAL_MODEL_ID, listLocalModelSpecs, localModelSpec } from '/peerd-provider/index.js';

// The load recipe per model (repo / Transformers.js class / dtype) lives in
// peerd-provider's MODEL_SPECS, not here: adding an on-device model must be a
// registry entry, not engine surgery. This module owns residency, download
// bookkeeping and streaming generate for WHICHEVER spec it is handed.
//
// ONE RESIDENT MODEL AT A TIME. why: these are multi-GB WebGPU allocations, and
// two resident models would race for VRAM on exactly the machines that can
// barely hold one. Switching models tears the previous one down first - the
// weights stay in the browser cache, so the switch back is a load, not a
// re-download.

// why any: Transformers.js is a vendored, untyped WASM/ESM module (no .d.ts);
// its AutoTokenizer / Gemma4ForCausalLM / env shapes are type-erased here.
/** @type {any} */
let tx = null;        // the imported Transformers.js module (lazy — only on first init)
/** @type {any} */
let tokenizer = null;
/** @type {any} */
let model = null;
/** @type {string | null} */
let residentId = null;   // which spec.id `model`/`tokenizer` hold
/** @type {{ id: string, promise: Promise<{ available: boolean }> } | null} */
let loading = null;

// "Weights are cached" — the in-memory model evaporates on every extension reload
// (the offscreen doc is torn down) but the weights stay in the browser cache. We
// detect that two ways: our persisted set (fast), and - retroactively, for a model
// downloaded BEFORE we recorded it - by scanning the Cache API where
// Transformers.js stores the .onnx weight files. Either way: Settings/Lab show
// 'downloaded' (no re-download) and the model lazy-loads from cache on first use.
/** @type {Set<string>} */
const downloadedIds = new Set();
const DOWNLOADED_KEY = 'localModelDownloaded';
/**
 * Read the persisted record. LEGACY MIGRATION: this key used to be a bare
 * boolean, back when there was exactly one on-device model - an existing install
 * that downloaded Gemma before the multi-model split stored `true`. Read that as
 * "the default model is downloaded" so nobody is asked to re-fetch 3.1 GB.
 * @returns {Promise<string[]>}
 */
const readDownloadedIds = async () => {
  try {
    const raw = (await browser.storage?.local?.get?.(DOWNLOADED_KEY))?.[DOWNLOADED_KEY];
    if (raw === true) return [DEFAULT_LOCAL_MODEL_ID];
    if (Array.isArray(raw)) return raw.filter((id) => typeof id === 'string');
  } catch { /* storage off */ }
  return [];
};
const persistDownloadedIds = () => {
  browser.storage?.local?.set?.({ [DOWNLOADED_KEY]: [...downloadedIds] }).catch(() => {});
};
/** @param {import('/peerd-provider/local-model-capability.js').ModelSpec} spec */
const probeCachedWeights = async (spec) => {
  try {
    if (typeof caches === 'undefined') return false;
    const marker = new RegExp(spec.cachePattern, 'i');
    for (const name of await caches.keys()) {
      const reqs = await (await caches.open(name)).keys();
      if (reqs.some((req) => marker.test(req.url) && /\.onnx(_data)?(\?|$)/i.test(req.url))) return true;
    }
  } catch { /* no Cache API / blocked */ }
  return false;
};
// Resolves once we've decided which models are cached. localModelStatus awaits
// it, so the first status read is accurate (no "Locked" flash for a model that's
// really there).
const detectDownloaded = (async () => {
  for (const id of await readDownloadedIds()) downloadedIds.add(id);
  let discovered = false;
  for (const spec of listLocalModelSpecs()) {
    if (downloadedIds.has(spec.id)) continue;
    if (await probeCachedWeights(spec)) { downloadedIds.add(spec.id); discovered = true; }
  }
  if (discovered) persistDownloadedIds(); // memoize so next time is instant
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

/**
 * Does the VENDORED Transformers.js carry this model's architecture? The spec
 * names the class it needs (`Gemma4ForCausalLM`, …) and we look it up on the
 * module - present means the build can load it, absent means it cannot, full
 * stop. why probe instead of a hand-kept flag: the answer changes when
 * scripts/vendor-transformers.sh re-pins the library, and a stale hand-kept
 * `true` would send a user into a multi-GB download that dies with
 * "Unsupported model type"; a stale `false` would hide a model that works.
 * This way the vendor bump IS the unlock.
 *
 * Memoized per spec: the answer can't change without a reload, and the import
 * is 1.3 MB of parse we only pay when something actually asks.
 * @type {Map<string, { supported: boolean, reason: string }>}
 */
const supportCache = new Map();
/** @param {import('/peerd-provider/local-model-capability.js').ModelSpec} spec */
const engineSupportsSpec = async (spec) => {
  const hit = supportCache.get(spec.id);
  if (hit) return hit;
  /** @type {{ supported: boolean, reason: string }} */
  let verdict;
  try {
    const t = await loadTransformers();
    verdict = typeof t?.[spec.modelClass] === 'function'
      ? { supported: true, reason: '' }
      : {
        supported: false,
        reason: `This build's Transformers.js has no ${spec.modelClass} - the ${spec.label} architecture is not in the vendored runtime yet.`,
      };
  } catch (e) {
    // Import failure is not a verdict about the model - don't cache it.
    return { supported: false, reason: `runtime unavailable: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
  }
  supportCache.set(spec.id, verdict);
  return verdict;
};

/**
 * Status for ONE model. `includeSupport` costs the Transformers.js import on
 * first call, so the 3s Settings poll leaves it off and the mount asks once.
 *
 * why the ok:true/ok:false literals: callers branch on `ok` before reading the
 * model fields, and a plain `boolean` there would let a typo read `supported`
 * off the error shape without the checker noticing.
 *
 * @typedef {{ ok: false, error: string, model: string }} LocalModelStatusError
 * @typedef {{ ok: true, available: boolean, downloaded: boolean, loading: boolean,
 *   model: string, label: string, supported?: boolean, unsupportedReason?: string }} LocalModelStatusOk
 *
 * @param {{ model?: string, includeSupport?: boolean }} [opts]
 * @returns {Promise<LocalModelStatusOk | LocalModelStatusError>}
 */
export const localModelStatus = async ({ model: modelId = DEFAULT_LOCAL_MODEL_ID, includeSupport = false } = {}) => {
  await detectDownloaded; // ensure the cache probe finished → no false "not downloaded"
  const spec = localModelSpec(modelId);
  if (!spec) return { ok: /** @type {false} */ (false), error: `unknown local model: ${modelId}`, model: modelId };
  const support = includeSupport ? await engineSupportsSpec(spec) : null;
  return {
    ok: /** @type {true} */ (true),
    available: residentId === spec.id && !!model, // loaded in memory, ready to generate NOW
    downloaded: downloadedIds.has(spec.id),       // weights cached (survives reloads) → loads fast from cache
    loading: loading?.id === spec.id,
    model: spec.id,
    label: spec.label,
    ...(support ? { supported: support.supported, unsupportedReason: support.reason } : {}),
  };
};

/**
 * Which model is mid-load, if any. The host handler checks this to REFUSE a
 * second concurrent download up front, rather than inferring it from how a
 * promise happens to settle.
 * @returns {string | null}
 */
export const loadingModelId = () => loading?.id ?? null;

/**
 * Status for EVERY shipped model - what Settings renders its cards from, in one
 * round-trip instead of one call per model.
 * @param {{ includeSupport?: boolean }} [opts]
 */
export const localModelCatalog = async ({ includeSupport = true } = {}) => ({
  ok: true,
  models: await Promise.all(listLocalModelSpecs().map((spec) =>
    localModelStatus({ model: spec.id, includeSupport }))),
});

/**
 * Load a model (downloads weights on first call, then cached). Idempotent +
 * single-flight PER MODEL. `onProgress({ status, file, progress, loaded, total })`
 * mirrors Transformers.js's progress_callback so Settings can show a download
 * bar; every event carries `model` so a card only renders its OWN progress.
 *
 * A different resident model is torn down first - one WebGPU allocation at a
 * time (see the header). A load already in flight for ANOTHER model is refused
 * rather than queued: two multi-GB downloads at once helps nobody, and the
 * caller gets a clear reason instead of a silent wait.
 *
 * @param {{ model?: string }} [opts]
 * @param {(p: object) => void} [onProgress]
 */
export const initLocalModel = async ({ model: modelId = DEFAULT_LOCAL_MODEL_ID } = {}, onProgress = () => {}) => {
  const spec = localModelSpec(modelId);
  if (!spec) throw new Error(`unknown local model: ${modelId}`);
  if (loading && loading.id !== spec.id) {
    throw new Error(`${localModelSpec(loading.id)?.label ?? loading.id} is still loading - wait for it to finish first.`);
  }
  if (loading) return loading.promise;
  if (model && residentId === spec.id) return { available: true };
  // Refuse BEFORE the download: an architecture the vendored runtime doesn't
  // carry fails deep inside from_pretrained after streaming gigabytes.
  const support = await engineSupportsSpec(spec);
  if (!support.supported) throw new Error(support.reason);
  // why narrate: a stall is otherwise invisible (the offscreen doc has no UI).
  // These log to the offscreen console (chrome://extensions → peerd → Inspect
  // views: offscreen.html) AND emit a 'phase' progress event the eval surfaces,
  // so we can see exactly which step hangs — tokenizer vs the ~3.1 GB weights.
  /** @param {string} phase @param {object} [extra] */
  const report = (phase, extra = {}) => {
    console.log(`[local-model:${spec.id}] ${phase}`, extra);
    try { onProgress({ status: 'phase', phase, model: spec.id, ...extra }); } catch { /* no listener */ }
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
  const tap = (label) => (p) => { console.log(`[local-model:${spec.id}] ${label}`, p); onProgress({ ...withOverall(p), model: spec.id }); };
  const promise = (async () => {
    report('probing WebGPU');
    const cap = await probeWebgpu();
    if (!cap.ok) throw new Error(cap.reason);
    // Free the other model's VRAM before allocating this one's.
    if (model && residentId !== spec.id) {
      report(`unloading ${localModelSpec(residentId ?? '')?.label ?? residentId}`);
      await teardownLocalModel();
    }
    report('loading transformers.js (vendored)');
    const t = await loadTransformers();
    report('loading tokenizer + config (small)');
    tokenizer = await t.AutoTokenizer.from_pretrained(spec.repo, { progress_callback: tap('tokenizer') });
    // The spec's class is the TEXT-ONLY causal-LM path where the architecture has
    // one (Gemma4ForCausalLM loads embed_tokens + decoder and SKIPS the
    // vision/audio encoders the multimodal class would pull - ~270 MB saved, and
    // the runner never sends images/audio). device:'webgpu' is the supported
    // hook; pre-created-device injection is the §6.2 open question.
    report(`loading model weights (first run streams ~${spec.sizeGB} GB from HF - text-only)`);
    model = await t[spec.modelClass].from_pretrained(spec.repo, {
      dtype: spec.dtype, device: 'webgpu', progress_callback: tap('model'),
    });
    residentId = spec.id;
    // Remember the weights are now cached, so a future reload skips the
    // re-download and just lazy-loads from cache.
    downloadedIds.add(spec.id);
    persistDownloadedIds();
    report('ready');
    return { available: true };
  })();
  loading = { id: spec.id, promise };
  try { return await promise; }
  catch (e) {
    console.error(`[local-model:${spec.id}] init FAILED:`, e);
    tokenizer = null; model = null; residentId = null;
    throw e;
  }
  finally { loading = null; }
};

export const teardownLocalModel = async () => {
  try { await model?.dispose?.(); } catch { /* best-effort */ }
  model = null; tokenizer = null; residentId = null;
};

// Flatten a peerd InternalMessage[] to the chat-template's {role, content}
// shape. Gemma has no system role, so the system framing is folded into the
// first user turn - chat templates that DO carry one still render this
// correctly, it just costs a line of user-turn preamble. Content blocks
// (text / tool_use / tool_result) are
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
 * `req.model` names WHICH on-device model to run. It is honored, never coerced:
 * a request for a model that isn't resident loads it (swapping out whatever
 * was), because silently answering from the wrong model would put a different
 * model's output under the caller's model id - the one failure mode a local
 * runner must not have.
 *
 * @param {{ messages: readonly object[], system: string, tools?: readonly object[], maxTokens?: number, model?: string }} req
 * @param {(text: string) => void} onToken
 */
export const generateLocal = async (req, onToken) => {
  await detectDownloaded;
  const wanted = req.model && localModelSpec(req.model) ? req.model : DEFAULT_LOCAL_MODEL_ID;
  if (!model || !tokenizer || residentId !== wanted) {
    // Cached from a prior session but not loaded into this (fresh) offscreen doc,
    // or a different model is resident: load from cache on first use - no
    // re-download, no manual step.
    if (downloadedIds.has(wanted)) await initLocalModel({ model: wanted });
    if (!model || !tokenizer || residentId !== wanted) {
      throw new Error(`local model not loaded: ${localModelSpec(wanted)?.label ?? wanted}`);
    }
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
