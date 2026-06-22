// @ts-check
// transcriber — offscreen-doc-side wrapper around Moonshine.
//
// Context: this file runs in the offscreen document, NOT the service
// worker. Two reasons:
//   1. Moonshine needs a full document context for WebGPU + WebAudio.
//      Service workers have neither.
//   2. The offscreen doc survives SW restarts. A 30-minute transcription
//      session would otherwise die at the 30s SW-idle boundary.
//
// The transcriber holds a single Moonshine instance per offscreen
// lifetime. Switching the listening target (which input field
// captures the transcript) is cheap — we don't recreate the model,
// we just retarget the chunk callback.
//
// VAD-based auto-stop
// -------------------
// After each COMMITTED chunk, we restart a silence timer. If it
// elapses with no further commits, we stop the mic. Streaming
// (incremental, uncommitted) chunks don't reset the timer — that
// would defeat the "user has finished speaking" signal. The threshold
// is settable so the settings UI can offer it as a slider.

import { MicrophoneTranscriber, Settings, VENDORED } from '/vendor/moonshine-js/moonshine.js';
import {
  VoiceUnsupportedError, VoiceNotEnabledError, MicPermissionDeniedError,
} from './errors.js';

const DEFAULT_SILENCE_MS = 1500;

// why this exists: Moonshine ships its ORT runtime + the Silero VAD
// pointing at jsdelivr (Settings.BASE_ASSET_PATH.{ONNX_RUNTIME,
// SILERO_VAD}). Under the MV3 extension_pages CSP (script-src 'self'
// 'wasm-unsafe-eval'), ORT can't `import()` / `new Worker()` a
// CROSS-ORIGIN script, so it fetches the source and re-wraps it as a
// `blob:` — which the SAME CSP then blocks (script-src has no blob:,
// and Chrome refuses to let extension_pages add one). Net: the wasm
// backend never loads and voice silently dies ("not supported"). This
// regressed the day the real runtime was vendored (16585e1): before
// that the stub fell back to Web Speech, which worked.
//
// The fix is to serve ORT + the VAD assets SAME-ORIGIN from the
// extension package (vendor/onnxruntime-web, vendor/vad-web). The ORT
// loader builds its worker + wasm URLs from `import.meta.url`, so a
// same-origin base means `import()`/`new Worker()`/`new URL(...wasm)`
// are all same-origin — allowed by 'self', no blob, no remote fetch.
// crossOriginIsolated is already true (COEP require-corp + COOP
// same-origin in the manifest), so ORT threads with same-origin
// pthread workers; `proxy` defaults false. The model .onnx bytes still
// arrive via peerd's own model-store (init({files})), not these paths.
const VENDOR_ONNX_RUNTIME = 'vendor/onnxruntime-web/';
const VENDOR_SILERO_VAD = 'vendor/vad-web/';

// why: Moonshine 0.1.29's model API is URL-ONLY. MoonshineModel always
// fetches encoder_model.onnx / decoder_model_merged.onnx by URL from
// Settings.BASE_ASSET_PATH.MOONSHINE + name (ORT InferenceSession.create
// → global fetch). There is NO constructor path for pre-loaded bytes, and
// ORT's JS is sealed inside the bundle so we can't build sessions
// ourselves. peerd already holds the bytes (SRI-verified, IDB-cached by
// model-store). Bridge the two: point MOONSHINE at a same-origin sentinel
// base and serve exactly those two model URLs from the cached bytes via a
// scoped fetch shim (installModelFetch). Keeps model-store's SRI + IDB
// cache; no network, no download.moonshine.ai CSP entry.
//
// MODEL_NAME MUST contain 'base' — MoonshineModel infers the decoder
// shape from modelURL.includes('base') (vs 'tiny'). MODEL_PRECISION is a
// cosmetic URL segment (the shim serves bytes regardless of it); 'float'
// is honest since peerd ships the float ONNX variant.
const VENDOR_MODEL_BASE = 'moonshine-model/';
const MODEL_PATH_MARKER = 'moonshine-model/';
const MODEL_NAME = 'model/base';
const MODEL_PRECISION = 'float';

// Resolve an extension-packaged asset to its absolute same-origin URL.
// Works in both Chrome and Firefox MV3 (both expose chrome.runtime);
// falls back to the raw path in non-extension test contexts (where the
// mock transcriber never touches ORT, so the value is inert).
/** @param {string} p */
const defaultAssetUrl = (p) =>
  (globalThis.chrome?.runtime?.getURL ? globalThis.chrome.runtime.getURL(p) : p);

/**
 * @typedef {Object} TranscriberChunk
 * @property {string} text         the (partial or final) transcribed text
 * @property {boolean} committed   true when Moonshine considers this final
 * @property {string|null} targetId  the input the user clicked the mic next to
 */

/**
 * Factory. Tests can pass a mock `moonshineClass` so the offscreen
 * doc's behavior is exercised without loading the real model.
 *
 * @param {Object} [deps]
 * @param {typeof MicrophoneTranscriber} [deps.moonshineClass]
 * @param {(fn: () => void, ms: number) => any} [deps.setTimer]
 * @param {(handle: any) => void} [deps.clearTimer]
 * @param {(p: string) => string} [deps.getAssetUrl]
 * @param {{ fetch: typeof fetch }} [deps.fetchEnv]
 */
export const createTranscriber = (deps = {}) => {
  const {
    moonshineClass = MicrophoneTranscriber,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    // Injected so tests can assert the redirect without a real extension
    // origin; production resolves to chrome.runtime.getURL.
    getAssetUrl = defaultAssetUrl,
    // The object whose `fetch` the model-bytes shim patches. Defaults to
    // the offscreen global; tests inject a fake so they never touch the
    // runner's real fetch.
    fetchEnv = globalThis,
  } = deps;

  /** @type {any} */
  let instance = null;
  /** @type {string | null} */
  let activeTargetId = null;
  /** @type {((c: TranscriberChunk) => void) | null} */
  let onChunk = null;
  /** @type {((err:{name:string,message:string,code?:string,targetId:string|null}) => void) | null} */
  let onError = null;
  /** @type {((info:{targetId:string|null}) => void) | null} */
  let onAutoStop = null;
  /** @type {any} */
  let silenceTimer = null;
  let silenceMs = DEFAULT_SILENCE_MS;
  // Uninstaller for the model-bytes fetch shim (installModelFetch),
  // restored on teardown so the patch never outlives the transcriber.
  /** @type {(() => void) | null} */
  let restoreFetch = null;

  /**
   * Serve Moonshine's two model URLs from the bytes peerd already loaded.
   * Moonshine builds them as `<MOONSHINE base><name>/<precision>/
   * encoder_model.onnx` (and decoder_model_merged.onnx) and loads them via
   * global fetch; we intercept exactly those (scoped to our sentinel base
   * marker) and pass everything else — ORT wasm, the VAD worklet/model —
   * straight through. Returns an uninstaller.
   *
   * @param {Record<string, ArrayBuffer>} files
   * @returns {() => void}
   */
  const installModelFetch = (files) => {
    // Keep the ORIGINAL reference (not a .bind() copy) so teardown can
    // restore it by identity; invoke it via .call so `this` is still the
    // env (real fetch tolerates a detached call, but don't rely on it).
    const original = fetchEnv.fetch;
    /** @param {ArrayBuffer} buf */
    const reply = (buf) => Promise.resolve(
      new Response(buf, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    );
    /**
     * @param {Parameters<typeof fetch>[0]} input
     * @param {Parameters<typeof fetch>[1]} [opts]
     * @returns {Promise<Response>}
     */
    const shim = (input, opts) => {
      const url = typeof input === 'string'
        ? input
        : (/** @type {{ url?: string }} */ (input).url ?? '');
      if (url.includes(MODEL_PATH_MARKER)) {
        if (url.endsWith('encoder_model.onnx')) return reply(files.encoder);
        if (url.endsWith('decoder_model_merged.onnx')) return reply(files.decoder);
      }
      return original.call(fetchEnv, input, opts);
    };
    // why: cast past `typeof fetch`'s static `preconnect` member (present on the
    // Bun/lib fetch type) — the shim is a drop-in for the request path only.
    fetchEnv.fetch = /** @type {typeof fetch} */ (shim);
    return () => { if (fetchEnv.fetch === shim) fetchEnv.fetch = original; };
  };

  // Fired by the silence timer: the user has gone quiet for silenceMs.
  // Stop the mic AND notify (the offscreen relays voice/auto-stop to the
  // side panel so the mic button de-highlights). Distinct from a manual
  // stop(), which the side panel already initiated and knows about.
  const autoStop = () => {
    const tid = activeTargetId;
    const notify = onAutoStop;   // capture before stop() nulls it
    stop()
      .then(() => { try { notify?.({ targetId: tid }); } catch { /* noop */ } })
      .catch(() => {});
  };

  /**
   * @param {string} text
   * @param {boolean} committed
   */
  const emit = (text, committed) => {
    if (!onChunk) return;
    onChunk({ text, committed, targetId: activeTargetId });
    // why reset on EVERY chunk, not committed-only: a partial/streaming
    // update is just as much proof the user is still talking. Arming the
    // timer only on commits cut a long continuous utterance off
    // mid-sentence — the 1.5s countdown from an early commit elapsed
    // while speech was still streaming. Now auto-stop fires only after
    // silenceMs of NO transcription activity at all (true end-of-speech).
    if (silenceTimer !== null) clearTimer(silenceTimer);
    silenceTimer = setTimer(autoStop, silenceMs);
  };

  /**
   * Build the Moonshine instance from already-loaded model bytes. The
   * caller (the offscreen voice handler) is responsible for loading
   * the bytes from the model-store first.
   *
   * @param {{ files?: Record<string, ArrayBuffer> }} [model]
   */
  const init = async ({ files } = {}) => {
    // why: cast off VENDORED's literal narrowing — the vendored bundle bakes
    // it in as a concrete value, so `=== false` would otherwise be flagged
    // as a no-overlap comparison even though the stub can ship it false.
    if (/** @type {boolean} */ (VENDORED) === false) throw new VoiceUnsupportedError();
    if (!files || !files.encoder || !files.decoder) {
      throw new VoiceUnsupportedError('transcriber.init: missing encoder/decoder files');
    }
    if (instance) await teardown();
    // Point Moonshine's ORT + VAD at the SAME-ORIGIN vendored copies, and
    // its MODEL base at our sentinel (served from `files` by the shim
    // below). Set every render — cheap, and it can't go stale if Moonshine
    // ever resets the singleton. Guarded so a mock Settings in tests (or a
    // future bundle without the key) can't throw.
    if (Settings?.BASE_ASSET_PATH) {
      Settings.BASE_ASSET_PATH.ONNX_RUNTIME = getAssetUrl(VENDOR_ONNX_RUNTIME);
      Settings.BASE_ASSET_PATH.SILERO_VAD = getAssetUrl(VENDOR_SILERO_VAD);
      Settings.BASE_ASSET_PATH.MOONSHINE = getAssetUrl(VENDOR_MODEL_BASE);
    }
    // Serve the bytes peerd already loaded (model-store) to Moonshine's
    // URL-only loader. Must be live before start() triggers the fetch.
    restoreFetch = installModelFetch(files);
    // Real @moonshine-ai/moonshine-js@0.1.29 API:
    //   new MicrophoneTranscriber(modelName, callbacks, useVAD, precision)
    // The FIRST arg is a model-NAME string, not a bag of bytes. The
    // pre-vendor placeholder passed an options OBJECT here, so that object
    // stringified into the model URL ('download.moonshine.ai/[object
    // Object]'); the load fetch failed and surfaced as the generic
    // onError(PlatformUnsupported) — the "platform not supported" symptom.
    // Callbacks are the SECOND arg (they were silently dropped before).
    instance = new moonshineClass(
      MODEL_NAME,
      {
        /** @param {string} text */
        onTranscriptionUpdated:   (text) => emit(text, false),
        /** @param {string} text */
        onTranscriptionCommitted: (text) => emit(text, true),
        // Surface async model/VAD load failures through peerd's error path
        // (Moonshine hands a human-readable string here).
        /** @param {unknown} message */
        onError: (message) => {
          try {
            onError?.({ name: 'MoonshineError', message: String(message), targetId: activeTargetId });
          } catch { /* noop */ }
        },
      },
      true,             // useVAD — speech endpointing drives onTranscriptionCommitted
      MODEL_PRECISION,
    );
  };

  /**
   * Start listening; route incoming chunks to `cb` tagged with the
   * provided `targetId`. If something is already listening, stop it
   * first — only one input field can hold the mic at a time.
   *
   * @param {string} targetId
   * @param {(chunk: TranscriberChunk) => void} cb
   * @param {(err: {name:string,message:string,targetId:string|null}) => void} [errCb]
   * @param {(info: {targetId:string|null}) => void} [autoStopCb]
   *   Called when the silence timer auto-stops (end of speech) so the
   *   caller can de-highlight the mic. NOT called on a manual stop().
   */
  const listenFor = async (targetId, cb, errCb, autoStopCb) => {
    if (!instance) throw new VoiceNotEnabledError();
    if (activeTargetId) await stop();
    activeTargetId = targetId;
    onChunk = cb;
    onError = errCb ?? null;
    onAutoStop = autoStopCb ?? null;
    try {
      await instance.start();
    } catch (e) {
      const tid = activeTargetId;
      activeTargetId = null;
      onChunk = null;
      onError = null;
      onAutoStop = null;
      // why: notify async-style too so the offscreen pushes a
      // voice/error to the side panel. The synchronous throw still
      // runs so the original listenFor caller sees a typed error.
      const typed = /** @type {{ name?: string, message?: string }} */ (e)?.name === 'NotAllowedError'
        ? new MicPermissionDeniedError()
        : /** @type {{ name?: string, message?: string }} */ (e);
      try { errCb?.({ name: typed.name ?? '', message: typed.message ?? '', targetId: tid }); }
      catch { /* noop */ }
      throw typed;
    }
  };

  /**
   * Stop listening. Idempotent. Clears the silence timer and the
   * active target so the next listenFor starts from a clean state.
   */
  const stop = async () => {
    if (silenceTimer !== null) {
      clearTimer(silenceTimer);
      silenceTimer = null;
    }
    const wasActive = activeTargetId !== null;
    activeTargetId = null;
    onChunk = null;
    onError = null;
    onAutoStop = null;
    if (instance && wasActive) {
      try { await instance.stop(); }
      catch (e) { console.warn('[voice/transcriber] stop threw', e); }
      // why: Moonshine's stop() pauses the VAD but does NOT clear its
      // speech buffer — uncommitted audio survives and gets committed on
      // the NEXT start(), leaking the tail of the previous utterance into
      // the next field. Flush it (the same reset Moonshine runs after
      // each commit). Internal API, guarded — may move on a version bump.
      try { instance.speechBuffer?.flush?.(); }
      catch (e) { console.warn('[voice/transcriber] speechBuffer flush threw', e); }
    }
  };

  /**
   * Tear the Moonshine instance down. Used when voice mode is
   * disabled or the offscreen doc is being closed.
   */
  const teardown = async () => {
    await stop();
    if (instance?.dispose) {
      try { await instance.dispose(); }
      catch (e) { console.warn('[voice/transcriber] dispose threw', e); }
    }
    instance = null;
    // Restore the real fetch — the shim must never outlive the instance.
    if (restoreFetch) {
      try { restoreFetch(); }
      catch (e) { console.warn('[voice/transcriber] fetch restore threw', e); }
      restoreFetch = null;
    }
  };

  /** @param {number} ms */
  const setSilenceThreshold = (ms) => {
    silenceMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_SILENCE_MS;
  };

  return Object.freeze({
    engine: 'moonshine',
    init,
    listenFor,
    stop,
    teardown,
    setSilenceThreshold,
    isInitialized: () => instance !== null,
    activeTargetId: () => activeTargetId,
  });
};

/**
 * Capability check that doesn't actually instantiate Moonshine. The
 * vendor stub exposes a VENDORED constant; when it's false (the
 * shipped placeholder), we know the engine can't run yet.
 */
// why: VENDORED is baked into the bundle as a literal, so compare through a
// boolean cast to avoid a spurious no-overlap error on `!== false`.
export const isMoonshineVendored = () => /** @type {boolean} */ (VENDORED) !== false;

