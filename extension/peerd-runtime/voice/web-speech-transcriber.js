// @ts-check
// Web Speech API transcriber — the V1 default engine.
//
// Why this exists
// ---------------
// Moonshine is the LOCAL transcription target — but it pulls
// Transformers.js + onnxruntime-web + vad-web at runtime, and MV3's
// `script-src 'self'` blocks remote dynamic imports. Vendoring all of
// those is ~15MB of JS plus a Moonshine fork; that's phase 3 work, not
// V1 ship state.
//
// In the meantime, every modern browser ships a Web Speech API that
// works out of the box with zero download. We use it as the default
// engine so voice DEMOS on first install. Moonshine, when vendored, is an
// explicit OPT-IN privacy upgrade the user chooses in Settings — the picker
// switches to it only on request, never automatically (DECISIONS #22).
//
// Privacy trade-off
// -----------------
// Web Speech's locality depends on the browser:
//   - Chrome (desktop + Android): audio is sent to Google's speech
//     service. Same for Edge.
//   - Safari (since iOS 14.5 / macOS 11.3): on-device.
//   - Firefox: experimental; provider varies.
// The UI is honest about this — the settings card labels the engine
// in use, and recommends the Moonshine vendor flow for users who need
// strict locality.
//
// Interface contract (matches transcriber.js)
// ------------------------------------------
//   init({ silenceMs? })          — preflight (no-op for Web Speech)
//   listenFor(targetId, onChunk)  — start; chunks tagged with targetId
//   stop()                        — stop listening
//   teardown()                    — alias for stop here; no model to release
//   setSilenceThreshold(ms)       — pass-through; the API has its own VAD

const DEFAULT_LANG = 'en-US';

// why: TS's DOM lib ships SpeechRecognitionEvent / SpeechRecognitionErrorEvent
// but NOT the SpeechRecognition interface or its `webkit`-prefixed constructor,
// so we describe the slice of the recognizer we touch ourselves.
/**
 * @typedef {Object} SpeechRecognizer
 * @property {string} lang
 * @property {boolean} continuous
 * @property {boolean} interimResults
 * @property {number} maxAlternatives
 * @property {(() => void) | null} onspeechend
 * @property {((ev: SpeechRecognitionEvent) => void) | null} onresult
 * @property {((ev: SpeechRecognitionErrorEvent) => void) | null} onerror
 * @property {(() => void) | null} onend
 * @property {() => void} start
 * @property {() => void} stop
 * @property {() => void} abort
 */
/** @typedef {new () => SpeechRecognizer} SpeechRecognizerCtor */

/**
 * A transcript chunk handed to the consumer.
 * @typedef {{ text: string, committed: boolean, targetId: string|null }} WebSpeechChunk
 */

// Web Speech API surfaces errors as a string code on the SpeechRecognitionErrorEvent.
// Map to our typed error names (the manager and UI key off these). 'aborted'
// is benign (we called stop()); 'no-speech' is a soft timeout we just swallow.
// Everything else is surfaced; permission failures get a dedicated typed name.
/** @type {Readonly<Record<string, string>>} */
const ERROR_NAME_MAP = Object.freeze({
  'not-allowed':           'MicPermissionDeniedError',
  'service-not-allowed':   'MicPermissionDeniedError',
  'audio-capture':         'MicHardwareError',
  'network':               'TranscriberNetworkError',
  'language-not-supported': 'VoiceUnsupportedError',
});
// Codes we deliberately don't surface — they're transient and the stop()
// path runs anyway.
const SILENT_ERROR_CODES = new Set(['aborted', 'no-speech']);

/**
 * Capability check. Returns the constructor if usable, null otherwise.
 * `self` is preferred over `window` so this works in workers /
 * offscreen contexts identically.
 */
const detectImpl = () => {
  // why: neither global is typed with the (non-standard) recognizer ctors;
  // read them off an indexable view of the global.
  const g = /** @type {Record<string, SpeechRecognizerCtor|undefined>} */ (
    /** @type {unknown} */ (typeof self !== 'undefined' ? self : globalThis)
  );
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
};

export const isWebSpeechAvailable = () => detectImpl() !== null;

/**
 * @typedef {Object} WebSpeechDeps
 * @property {SpeechRecognizerCtor} [impl]   override the SpeechRecognition class for tests
 * @property {string}  [lang]          BCP-47 language tag; default en-US
 * @property {(fn: () => void, ms: number) => any} [setTimer]
 * @property {(h: any) => void} [clearTimer]
 */

/**
 * Factory matching the createTranscriber(...) shape so the offscreen
 * voice handler can swap engines without branching call sites.
 *
 * @param {WebSpeechDeps} [deps]
 */
export const createWebSpeechTranscriber = (deps = {}) => {
  const Impl = deps.impl ?? detectImpl();
  const lang = deps.lang ?? DEFAULT_LANG;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  /** @type {SpeechRecognizer | null} */
  let recognizer = null;
  /** @type {string | null} */
  let activeTargetId = null;
  /** @type {((chunk: WebSpeechChunk) => void) | null} */
  let onChunk = null;
  /** @type {((err:{name:string,message:string,code?:string,targetId:string|null}) => void) | null} */
  let onError = null;
  /** @type {((info:{targetId:string|null,reason:'silence'|'manual'|'browser'}) => void) | null} */
  let onEnd = null;
  let silenceMs = 1500;
  /** @type {ReturnType<typeof setTimer> | null} */
  let silenceTimer = null;

  const buildRecognizer = () => {
    if (!Impl) {
      throw Object.assign(new Error('Web Speech API is not available in this browser.'), {
        name: 'VoiceUnsupportedError',
      });
    }
    const r = new Impl();
    r.lang = lang;
    r.continuous = true;
    // why: interimResults:true streams Chrome's running guess into the
    // input as the recognizer revises mid-phrase. That makes the text
    // visibly jump around. We only want the locked-in result, which
    // we get with isFinal=true chunks under interimResults:false.
    // Trade-off: text appears in larger jumps at natural phrase ends
    // instead of streaming character-by-character. For command input
    // that's the right call.
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onspeechend   = () => {
      // why: this is the recognizer's explicit "user stopped talking"
      // signal. In continuous mode Chrome sometimes doesn't commit
      // chunks (isFinal=true) at natural pauses — it just keeps the
      // stream open. Arming silence here means the auto-stop fires
      // reliably after the configured threshold whether or not Chrome
      // chose to commit. The silenceMs setting from settings becomes
      // a real knob again.
      armSilence();
    };
    r.onresult = (ev) => {
      const startIdx = typeof ev?.resultIndex === 'number' ? ev.resultIndex : 0;
      const total = ev?.results?.length ?? 0;
      if (!onChunk) return;
      for (let i = startIdx; i < total; i++) {
        const result = ev.results[i];
        const alt = result?.[0];
        const text = (alt && typeof alt.transcript === 'string') ? alt.transcript : '';
        const committed = !!result?.isFinal;
        try { onChunk({ text, committed, targetId: activeTargetId }); }
        catch (e) { console.error('[web-speech] onChunk threw', e); }
        if (committed) armSilence();
      }
    };
    r.onerror = (ev) => {
      const code = ev?.error ?? 'unknown';
      // Benign codes don't surface — onend will reset state and the
      // user clicks the mic again to retry.
      if (SILENT_ERROR_CODES.has(code)) {
        return;
      }
      const name = ERROR_NAME_MAP[code] ?? 'TranscriberError';
      const message = ev?.message || code;
      console.warn('[web-speech] error', code, message);
      // why: capture activeTargetId BEFORE the cleanup loop nulls it so
      // the manager can correlate which input field's mic just died.
      const tid = activeTargetId;
      const cb = onError;
      // Reset local state synchronously — the recognizer may or may not
      // fire onend after a fatal error depending on the browser; we
      // can't rely on it to clean up.
      activeTargetId = null;
      onChunk = null;
      onError = null;
      onEnd = null;
      if (silenceTimer !== null) { clearTimer(silenceTimer); silenceTimer = null; }
      try { r.stop(); } catch { /* may already be stopped */ }
      // Notify outward last so any throw upstream doesn't leave state
      // in a half-cleaned shape.
      try { cb?.({ name, message, code, targetId: tid }); }
      catch (e) { console.error('[web-speech] onError threw', e); }
    };
    r.onend = () => {
      // why: if the recognizer ended on its own (browser auto-stopped,
      // network blip), notify the consumer so it can sync state. If
      // we already cleaned up via stop() or onerror, onEnd is null
      // and this is a no-op.
      const tid = activeTargetId;
      const cb = onEnd;
      activeTargetId = null;
      onChunk = null;
      onError = null;
      onEnd = null;
      if (silenceTimer !== null) { clearTimer(silenceTimer); silenceTimer = null; }
      if (cb) {
        try { cb({ targetId: tid, reason: 'browser' }); }
        catch (e) { console.error('[web-speech] onEnd threw', e); }
      }
    };
    return r;
  };

  // Internal stop variant that carries a reason so onEnd consumers
  // know whether the auto-stop was silence-triggered vs explicit.
  /** @param {'silence'|'manual'|'browser'} reason */
  const stopWithReason = async (reason) => {
    if (silenceTimer !== null) { clearTimer(silenceTimer); silenceTimer = null; }
    const tid = activeTargetId;
    const cb = onEnd;
    activeTargetId = null;
    onChunk = null;
    onError = null;
    onEnd = null;
    if (recognizer) {
      try { recognizer.stop(); }
      catch { /* not started, fine */ }
    }
    if (cb) {
      try { cb({ targetId: tid, reason }); }
      catch (e) { console.error('[web-speech] onEnd threw', e); }
    }
  };

  const armSilence = () => {
    if (silenceTimer !== null) clearTimer(silenceTimer);
    silenceTimer = setTimer(() => {
      stopWithReason('silence').catch(() => {});
    }, silenceMs);
  };

  const init = async () => {
    // No-op for Web Speech. The recognizer is constructed lazily in
    // listenFor; init exists so the offscreen handler can call the
    // same path on every engine.
    if (!Impl) {
      throw Object.assign(new Error('Web Speech API is not available in this browser.'), {
        name: 'VoiceUnsupportedError',
      });
    }
  };

  /**
   * @param {string} targetId
   * @param {(chunk: WebSpeechChunk) => void} cb
   * @param {((err:{name:string,message:string,code?:string,targetId:string|null}) => void)} [errCb]
   * @param {((info:{targetId:string|null,reason:'silence'|'manual'|'browser'}) => void)} [endCb]
   */
  const listenFor = async (targetId, cb, errCb, endCb) => {
    if (activeTargetId) await stop();
    activeTargetId = targetId;
    onChunk = cb;
    onError = errCb ?? null;
    onEnd = endCb ?? null;
    if (!recognizer) recognizer = buildRecognizer();
    try {
      recognizer.start();
    } catch {
      // Spec says calling start() while already started throws
      // InvalidStateError. Reset and retry once.
      try { recognizer.abort(); }
      catch { /* ignore */ }
      recognizer = buildRecognizer();
      recognizer.start();
    }
    // why: the silence timer should ONLY arm after the user has
    // actually spoken (after the first committed chunk). Arming here
    // would stop the recognizer in `silenceMs` even if the user is
    // still about to start — the bug that made "click → mic on →
    // nothing" silently auto-stop.
  };

  const stop = async () => stopWithReason('manual');

  const teardown = async () => {
    await stop();
    if (recognizer) {
      try { recognizer.abort(); }
      catch { /* noop */ }
      recognizer = null;
    }
  };

  /** @param {number} ms */
  const setSilenceThreshold = (ms) => {
    silenceMs = Number.isFinite(ms) && ms > 0 ? ms : 1500;
  };

  return Object.freeze({
    engine: 'web-speech',
    init,
    listenFor,
    stop,
    teardown,
    setSilenceThreshold,
    isInitialized: () => true,                   // no async setup
    activeTargetId: () => activeTargetId,
  });
};
