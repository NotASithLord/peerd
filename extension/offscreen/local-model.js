// @ts-check
// offscreen/local-model.js — the on-device inference engine (FEATURE-LOCAL-WEBGPU
// B / M1). The registered on-device models run here in the OFFSCREEN doc - never
// the SW (which idles out; WebGPU + a resident model need a long-lived document).
// The SW's local-webgpu adapter drives this over runtime messages; this module
// owns residency, download bookkeeping and streaming generate.
//
// TWO ENGINES, dispatched on spec.engine (the registry decides which runtime a
// model needs - see MODEL_SPECS):
//   - 'transformers': Transformers.js + ONNX-Runtime-Web (ONNX exports, e.g.
//     Gemma). Weights cache in the Cache API.
//   - 'muse-glimmer': the vendored Muse Glimmer WebGPU GGUF runtime
//     (vendor/muse-glimmer/ - custom WGSL kernels + its own GGUF loader).
//     Weights cache in IndexedDB (gguf-cache-v1).
//
// VENDORED, not CDN: the offscreen CSP is `script-src 'self'`, so both runtimes
// are imported from /vendor/ (Transformers.js via scripts/vendor-transformers.sh;
// the muse runtime's provenance in vendor/muse-glimmer/SOURCE.txt).
// `connect-src https:` lets the model weights download from Hugging Face; both
// engines cache them so the multi-GB download is one-time.
//
// UNVERIFIED HERE: WebGPU + a multi-GB model can't run in CI - this is owner-
// load-tested per model. The two things the load-test confirms: (1) the WebGPU
// load succeeds on the target machine, (2) the model's tool-call output
// matches the adapter's <tool_call> parser (the §3.3 lever if not). Everything
// else is mechanical message plumbing. What CI CAN check is the step before
// that: whether the vendored runtime carries the model at all
// (engineSupportsSpec, asserted live in the options-local-models E2E state).

import browser from '/vendor/browser-polyfill.js';
import { DEFAULT_LOCAL_MODEL_ID, listLocalModelSpecs, localModelSpec } from '/peerd-provider/index.js';
import { makeMuseChannelSplitter } from './muse-glimmer-stream.js';

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

// why any: both runtimes are vendored, untyped ESM modules (no .d.ts);
// their AutoTokenizer / MuseGlimmer30B / env shapes are type-erased here.
/** @type {any} */
let tx = null;        // the imported Transformers.js module (lazy — only on first init)
/** @type {any} */
let tokenizer = null;
/** @type {any} */
let model = null;
/** @type {any} */
let museModule = null;    // the imported muse-glimmer runtime (lazy - only on first use)
/** @type {any} */
let museInstance = null;  // a loaded MuseGlimmer30B (generate/dispose/lastAssistantMessage)
/** @type {string | null} */
let residentId = null;   // which spec.id the loaded engine state belongs to
/** @type {{ id: string, promise: Promise<{ available: boolean }> } | null} */
let loading = null;
// Generations currently streaming from the resident engine. A resident swap or
// teardown while one is live would destroy the GPU device under the stream, so
// those paths refuse while this is non-zero (see initLocalModel + the host's
// teardown handler).
let activeGenerations = 0;
/** Is any local generation currently streaming? */
export const generationInFlight = () => activeGenerations > 0;

/**
 * The context window the ENGINE will actually enforce for this spec - the
 * spec's `enforcedContextWindow` cap where one exists (muse: the KV-cache
 * budget), else the nominal window. This is the number the trim layer must
 * see; the nominal alone would let sessions run into "context window is full".
 * @param {import('/peerd-provider/local-model-capability.js').ModelSpec} spec
 */
const effectiveWindow = (spec) =>
  Math.min(spec.enforcedContextWindow ?? spec.contextWindow, spec.contextWindow);

/**
 * Is this spec's engine state loaded in memory right now?
 * @param {import('/peerd-provider/local-model-capability.js').ModelSpec} spec
 */
const residentReady = (spec) => residentId === spec.id
  && (spec.engine === 'muse-glimmer' ? !!museInstance : (!!model && !!tokenizer));

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
    // The Cache-API probe is a 'transformers' RETROFIT (it matches .onnx URLs
    // Transformers.js wrote before we kept records). The muse engine postdates
    // the persisted record and caches in IndexedDB, so the record is the truth.
    if (spec.engine !== 'transformers') continue;
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

const loadMuseGlimmer = async () => {
  if (museModule) return museModule;
  // The vendored Muse Glimmer runtime is fully self-contained (no imports, no
  // DOM at module scope) - see vendor/muse-glimmer/SOURCE.txt for provenance.
  museModule = await import('/vendor/muse-glimmer/muse-glimmer.js');
  return museModule;
};

/**
 * Is WebGPU available (+ shader-f16 where the model's dtype demands it)? The
 * capability gate (mirrors voice/engine-picker). f16 is opt-out per spec: the
 * muse engine's kernels carry f32 fallbacks, so requiring f16 there would
 * refuse devices its own support check accepts.
 * @param {{ requireF16?: boolean }} [opts]
 */
export const probeWebgpu = async ({ requireF16 = true } = {}) => {
  if (!navigator.gpu) return { ok: false, reason: 'WebGPU is unavailable in this browser.' };
  let adapter;
  try { adapter = await navigator.gpu.requestAdapter(); } catch { adapter = null; }
  if (!adapter) return { ok: false, reason: 'No WebGPU adapter (GPU blocked or unavailable).' };
  if (requireF16 && !adapter.features.has('shader-f16')) return { ok: false, reason: 'GPU lacks shader-f16 (needed for q4f16).' };
  return { ok: true };
};

/**
 * Can this spec's VENDORED engine actually run it here? Three verdicts, and
 * the difference between the last two matters: 'unsupported' is a fact about
 * the runtime (or this device), 'unknown' is our own ignorance and must not
 * read as a refusal.
 *
 * Per engine:
 *   - 'transformers': (1) a pinned modelClass present on the module = loadable,
 *     no network; (2) otherwise ASK THE MODEL WHAT IT IS - fetch its config (a
 *     few KB, not the weights) and check the declared `model_type` against the
 *     runtime's own dispatch table. why the config and not a hard-coded class
 *     name: a class name is a GUESS about how an export was published, and a
 *     wrong guess locks a model that would have run. The repo's config is
 *     authoritative and the mapping is the runtime's own.
 *   - 'muse-glimmer': the runtime's OWN checkAvailability - it probes the
 *     WebGPU adapter, reads the GGUF header (a range request, not the weights)
 *     and dry-runs its kernel support check against this device. Its verdict
 *     is authoritative for both build and device; a network failure inside it
 *     resolves optimistic ({ok:true}), matching the Space's behavior.
 *
 * Either way the vendor pin remains the gate, and a re-pin is the unlock.
 * Successes and hard refusals are memoized; 'unknown' is NOT cached, so a probe
 * that failed offline is retried rather than frozen into a lock.
 *
 * @typedef {{ state: 'supported'|'unsupported'|'unknown', reason: string }} SupportVerdict
 * @type {Map<string, SupportVerdict>}
 */
const supportCache = new Map();
/**
 * @param {import('/peerd-provider/local-model-capability.js').ModelSpec} spec
 * @returns {Promise<SupportVerdict>}
 */
const engineSupportsSpec = async (spec) => {
  const hit = supportCache.get(spec.id);
  if (hit) return hit;
  /** @type {SupportVerdict} */
  let verdict;
  try {
    if (spec.engine === 'muse-glimmer') {
      const mg = await loadMuseGlimmer();
      const res = await mg.MuseGlimmer30B.checkAvailability(spec.repo, { file: spec.file });
      if (!res?.ok) {
        // A muse refusal is DEVICE state (adapter missing/blocked, a kernel the
        // GPU can't compile), not a fact about the build - and adapter requests
        // can fail transiently. Report it honestly but do NOT memoize, so a
        // recovered GPU un-locks on the next status read instead of staying
        // frozen behind a stale verdict for the document's lifetime.
        return { state: 'unsupported', reason: res?.reason || `This device cannot run ${spec.label}.` };
      }
      verdict = { state: 'supported', reason: '' };
    } else if (spec.modelClass) {
      const t = await loadTransformers();
      verdict = typeof t?.[spec.modelClass] === 'function'
        ? { state: 'supported', reason: '' }
        : {
          state: 'unsupported',
          reason: `This build's Transformers.js has no ${spec.modelClass}, so it cannot load ${spec.label} yet.`,
        };
    } else {
      // Ask the repo what architecture it declares, then ask the runtime
      // whether it dispatches that. AutoConfig fetches config.json only.
      const t = await loadTransformers();
      const config = await t.AutoConfig.from_pretrained(spec.repo);
      const modelType = config?.model_type ?? null;
      const mappings = t.AutoModelForCausalLM?.MODEL_CLASS_MAPPINGS ?? [];
      const dispatches = !!modelType && mappings.some(
        (/** @type {Map<string, unknown>} */ map) => typeof map?.has === 'function' && map.has(modelType));
      verdict = dispatches
        ? { state: 'supported', reason: '' }
        : {
          state: 'unsupported',
          reason: `${spec.repo} declares architecture "${modelType ?? 'unknown'}", which this build's Transformers.js cannot load yet.`,
        };
    }
  } catch (e) {
    // Import or config fetch failed (offline, repo unreachable, renamed). That
    // is not a verdict about the model, so report it as UNKNOWN and don't cache.
    const message = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
    return { state: 'unknown', reason: `Could not check this model's architecture: ${message}` };
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
 *   model: string, label: string, contextWindow: number,
 *   supportState?: 'supported'|'unsupported'|'unknown',
 *   supportReason?: string }} LocalModelStatusOk
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
    available: residentReady(spec), // loaded in memory, ready to generate NOW
    downloaded: downloadedIds.has(spec.id),       // weights cached (survives reloads) → loads fast from cache
    loading: loading?.id === spec.id,
    model: spec.id,
    label: spec.label,
    // The EFFECTIVE window the engine will enforce, not the nominal maximum:
    // the muse engine caps its KV cache (enforcedContextWindow; the loaded
    // instance is the final word), so reporting 131K would make the trim layer
    // compress too late and hit "context window is full" instead. The SW feeds
    // this to the adapter's live-window seam (setLocalModelInfo).
    contextWindow: residentReady(spec) && spec.engine === 'muse-glimmer'
      && typeof museInstance?.contextLength === 'number'
      ? museInstance.contextLength
      : effectiveWindow(spec),
    ...(support ? { supportState: support.state, supportReason: support.reason } : {}),
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
  if (residentReady(spec)) return { available: true };
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
  // The muse runtime reports {status, kind, loaded, total, fraction, message}.
  // Map its byte events onto the SAME aggregate-bar shape the transformers tap
  // produces (overall/overallLoaded/overallTotal) and everything else onto
  // 'phase' lines, so the Settings card renders both engines identically.
  /** @param {any} p */
  const museTap = (p) => {
    if (p?.status === 'weights' && p?.kind === 'bytes' && typeof p.loaded === 'number') {
      const total = typeof p.total === 'number' && p.total > 0 ? p.total : 0;
      onProgress({
        status: 'progress', file: spec.file ?? undefined, loaded: p.loaded,
        ...(total ? {
          total,
          overall: Math.min(100, (p.loaded / total) * 100),
          overallLoaded: p.loaded,
          overallTotal: total,
        } : {}),
        model: spec.id,
      });
      return;
    }
    // Non-byte events are sparse (init/tokenizer/warmup/ready) - log those only;
    // byte events fire per chunk and would flood the console.
    console.log(`[local-model:${spec.id}] muse`, p);
    onProgress({ status: 'phase', phase: String(p?.message ?? p?.status ?? 'working'), model: spec.id });
  };
  const promise = (async () => {
    // Refuse BEFORE the download, but only on a DEFINITE no: an architecture the
    // vendored runtime doesn't carry fails deep inside from_pretrained after
    // streaming gigabytes. An 'unknown' verdict (config unreachable) is not a
    // refusal - the load re-checks and fails cheaply at the config step anyway.
    // why INSIDE the single-flight slot: this await spans a runtime import and
    // possibly a network probe; run before the slot claim it would open a
    // window where two concurrent init calls both pass the `loading` guard and
    // both stream the full weights.
    const support = await engineSupportsSpec(spec);
    if (support.state === 'unsupported') throw new Error(support.reason);
    report('probing WebGPU');
    const cap = await probeWebgpu({ requireF16: spec.requiresShaderF16 });
    if (!cap.ok) throw new Error(cap.reason);
    // Free the other model's VRAM before allocating this one's - but never
    // under a live stream: disposing the engine destroys the GPU device the
    // in-flight generate is reading from, killing the user's turn mid-answer.
    if ((model || museInstance) && residentId !== spec.id) {
      if (generationInFlight()) {
        throw new Error(`${localModelSpec(residentId ?? '')?.label ?? residentId} is answering right now - try again when the response finishes.`);
      }
      report(`unloading ${localModelSpec(residentId ?? '')?.label ?? residentId}`);
      await teardownLocalModel();
    }
    if (spec.engine === 'muse-glimmer') {
      report('loading muse-glimmer runtime (vendored)');
      const mg = await loadMuseGlimmer();
      report(`loading model weights (first run streams ~${spec.sizeGB} GB from HF)`);
      // maxLength = the KV-cache budget (the spec's enforcedContextWindow); the
      // runtime clamps it to the model's own max_position_embeddings. The
      // runtime handles download + IndexedDB cache + GPU upload + kernel
      // warmup itself.
      museInstance = await mg.MuseGlimmer30B.load(spec.repo, {
        file: spec.file,
        maxLength: effectiveWindow(spec),
        onProgress: museTap,
      });
    } else {
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
      const ModelClass = spec.modelClass ? t[spec.modelClass] : t.AutoModelForCausalLM;
      model = await ModelClass.from_pretrained(spec.repo, {
        dtype: spec.dtype, device: 'webgpu', progress_callback: tap('model'),
      });
    }
    residentId = spec.id;
    // Remember the weights are now cached, so a future reload skips the
    // re-download and just lazy-loads from cache.
    downloadedIds.add(spec.id);
    persistDownloadedIds();
    report('ready');
    return { available: true };
  })();
  // Claimed SYNCHRONOUSLY after the guards above - the IIFE has yielded at its
  // first await by the time this line runs, and no other await sits between
  // the `if (loading)` check and this assignment, so a concurrent init can
  // never slip past the single-flight guard.
  loading = { id: spec.id, promise };
  try { return await promise; }
  catch (e) {
    console.error(`[local-model:${spec.id}] init FAILED:`, e);
    // Clear only THIS attempt's half-loaded state. If the failure happened
    // before the teardown step (e.g. the WebGPU probe threw) a previous model
    // is still resident and healthy - nulling its handles here would leak its
    // GPU memory and un-register a working model.
    if (residentId === null || residentId === spec.id) {
      tokenizer = null; model = null; museInstance = null; residentId = null;
    }
    throw e;
  }
  finally { if (loading?.promise === promise) loading = null; }
};

export const teardownLocalModel = async () => {
  try { await model?.dispose?.(); } catch { /* best-effort */ }
  try { museInstance?.dispose?.(); } catch { /* best-effort */ }
  model = null; tokenizer = null; museInstance = null; residentId = null;
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

// The muse runtime renders its chat template with tools:null (hard-coded), so
// the tool inventory rides the SYSTEM TEXT instead - same output contract as
// the templated transformers path: the model emits <tool_call>{json}</tool_call>
// blocks the local-webgpu adapter parses.
/** @param {readonly any[] | undefined} tools */
const museToolsPreamble = (tools) => {
  if (!tools || tools.length === 0) return '';
  return 'You can call tools. To call one, reply with exactly:\n'
    + '<tool_call>{"name": "<tool name>", "arguments": {}}</tool_call>\n'
    + `Available tools (JSON):\n${JSON.stringify(tools)}`;
};

/**
 * Stream a generation. Calls `onToken(text)` per decoded chunk; resolves when
 * done. Tools reach the model per engine (templated in for transformers;
 * system-text preamble for muse) and it emits <tool_call> blocks the adapter
 * parses either way. Greedy decode where the engine exposes the knob (a runner
 * wants the same action for the same page).
 *
 * `req.model` names WHICH on-device model to run. It is honored, never coerced:
 * a request for a model that isn't resident loads it (swapping out whatever
 * was), because silently answering from the wrong model would put a different
 * model's output under the caller's model id - the one failure mode a local
 * runner must not have.
 *
 * @param {{ messages: readonly object[], system: string, tools?: readonly object[], maxTokens?: number, model?: string }} req
 * @param {(text: string) => void} onToken
 * @param {{ signal?: AbortSignal }} [opts]
 *   `signal` ends a muse generation early (the engine honors it per token,
 *   releasing its generation lease). The transformers path ignores it for now
 *   (v1 posture: runs to max_new_tokens).
 */
export const generateLocal = async (req, onToken, { signal } = {}) => {
  await detectDownloaded;
  const wanted = req.model && localModelSpec(req.model) ? req.model : DEFAULT_LOCAL_MODEL_ID;
  const spec = localModelSpec(wanted);
  if (!spec) throw new Error(`unknown local model: ${wanted}`);
  if (!residentReady(spec)) {
    // Cached from a prior session but not loaded into this (fresh) offscreen doc,
    // or a different model is resident: load from cache on first use - no
    // re-download, no manual step. (Runs BEFORE this call claims a generation
    // slot: the swap path refuses while a generation is live, and this call's
    // own slot must not count against its own load.)
    if (downloadedIds.has(wanted)) await initLocalModel({ model: wanted });
    if (!residentReady(spec)) {
      throw new Error(`local model not loaded: ${spec?.label ?? wanted}`);
    }
  }
  activeGenerations += 1;
  try {
    if (spec.engine === 'muse-glimmer') {
      const system = [req.system ?? '', museToolsPreamble(req.tools)].filter(Boolean).join('\n\n');
      const messages = toChat(req.messages ?? [], system);
      // The raw stream interleaves the model's reasoning channel with the
      // visible one; the splitter forwards only the visible content (see
      // muse-glimmer-stream.js). reconcile() flushes any tail the stream
      // missed, taken from the engine's own authoritative post-parse (and
      // re-filtered through the same visibility rule, so a truncated
      // generation's raw fallback can never flush the reasoning channel).
      //
      // TOKEN-GROUNDED switch: reasoning that merely QUOTES the words
      // "assistant to=user" must not flip the channel - only the real <|eom|>
      // token does. Watch for that token id in the stream and arm the splitter
      // at (roughly) the cumulative-text offset where it went by; the 8-char
      // backoff absorbs incremental-decode boundary flux. An unresolvable id
      // falls back to text-only detection.
      const eomId = museInstance.tokenizer?.token_to_id?.('<|eom|>') ?? null;
      const splitter = makeMuseChannelSplitter({ tokenGrounded: eomId != null });
      for await (const step of museInstance.generate(messages, { maxNewTokens: req.maxTokens ?? 512, signal })) {
        if (eomId != null && step?.token === eomId) {
          splitter.arm(Math.max(0, String(step?.text ?? '').length - 8));
        }
        const delta = splitter.push(String(step?.text ?? ''));
        if (delta) onToken(delta);
      }
      const tail = splitter.reconcile(museInstance.lastAssistantMessage?.content ?? null);
      if (tail) onToken(tail);
      return;
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
  } finally {
    activeGenerations -= 1;
  }
};
