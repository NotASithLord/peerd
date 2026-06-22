// @ts-check
// manager — side-panel-side voice lifecycle + state distribution.
//
// Context: this file runs in the side panel, NOT the SW and NOT the
// offscreen doc. It owns the user-visible state machine and routes
// orchestration through the SW (which forwards to the offscreen doc
// where transcription actually happens).
//
// State machine
// -------------
//   idle              voice mode off; mic buttons hidden
//   downloading       model fetch in progress; progress field is 0..1
//   available         model ready; mic buttons visible, no input active
//   listening         a specific input is capturing chunks
//   error             last operation failed; UI shows a recoverable error
//
// Transitions are guarded — calling listenFor() from `downloading`
// is a no-op (the UI shouldn't allow it; defense in depth).
//
// Why the model download lives in the side panel
// ----------------------------------------------
// The download is ~30s of streaming progress that the user is
// staring at. Driving it from the side panel keeps the progress
// callback synchronous with the UI; no message-passing overhead per
// chunk. The offscreen doc receives the assembled bytes once.
//
// If the side panel closes mid-download, the request is aborted via
// AbortController and the IDB cache state stays consistent (no
// partial writes — model-store only stores complete-and-verified
// assets). On reopen, the user re-clicks "Enable" and we resume from
// the cached assets that did complete + re-fetch the rest.

import { createModelStore } from './model-store.js';
import { detectVoiceCapability } from './engine-picker.js';
import { createWebSpeechTranscriber } from './web-speech-transcriber.js';
import { normalizeVariant } from './settings.js';
import {
  VoiceNotEnabledError, VoiceUnsupportedError,
  MicPermissionDeniedError, ModelDownloadError, SriMismatchError,
} from './errors.js';

/**
 * @typedef {Object} VoiceState
 * @property {'idle'|'downloading'|'available'|'listening'|'error'} status
 * @property {number} progress           0..1 during download
 * @property {string|null} activeTarget  id of the input currently listening
 * @property {string|null} error         human-readable error from last failure
 * @property {string|null} variant       the shipped model ('base') or null
 * @property {'moonshine'|'web-speech'|null} engine    which transcription
 *   engine is live. UI surfaces this so the user knows whether audio is
 *   local (moonshine) or cloud-routed by the browser (web-speech).
 * @property {string|null} cloudVendor   best-effort label for the
 *   web-speech cloud provider; null on local engines.
 */

/** @type {VoiceState} */
const INITIAL_STATE = Object.freeze({
  status: 'idle',
  progress: 0,
  activeTarget: null,
  error: null,
  variant: null,
  engine: null,
  cloudVendor: null,
});

/**
 * Build a manager bound to a messaging backend. Production passes a
 * thin `send` that calls chrome.runtime.sendMessage; tests pass a
 * recording mock to drive transitions deterministically.
 *
 * @param {Object} deps
 * @param {(msg: any) => Promise<any>} deps.send         side-panel → SW one-shot send
 * @param {(handler: (msg:any)=>void) => () => void} deps.onMessage   subscribe to SW pushes; returns unsubscribe
 * @param {ReturnType<typeof createModelStore>} [deps.modelStore]
 * @param {(devFlag?: boolean) => boolean} [deps.isDev]
 *   When true, the model-store accepts assets without a pinned SRI
 *   hash (loud warning instead of throw). V1 default is true so the
 *   manager works the moment moonshine-js is vendored, before the
 *   release engineer has run scripts/compute-model-sri.sh against
 *   the model URLs. The default must flip to false before tagging a
 *   public release; see scripts/compute-model-sri.sh.
 * @param {typeof detectVoiceCapability} [deps.detectCapability]
 * @param {() => Promise<void>} [deps.requestMicPermission]
 * @param {typeof createWebSpeechTranscriber} [deps.createLocalTranscriber]
 */
export const createVoiceManager = (deps) => {
  const {
    send,
    onMessage,
    // why (#2): wire the model store's outbound-fetch audit through `send` so the
    // HF download lands in the SW audit log. Non-'voice/' type so the offscreen
    // ignores it and the SW dispatcher handles it. (`send` is destructured above,
    // so this default can reference it.)
    modelStore = createModelStore({ audit: (entry) => send?.({ type: 'audit/voice-fetch', url: entry?.url }) }),
    isDev = () => true,
    detectCapability = detectVoiceCapability,
    // why: the offscreen doc CAN'T prompt for mic permission — its
    // getUserMedia() rejects synchronously without a UI when the
    // extension origin hasn't been granted mic access. We acquire the
    // grant from the side panel's user-gesture context (the mic
    // button click), then the offscreen's call inherits it silently.
    // Default implementation does query + getUserMedia; tests inject
    // a no-op so the runner doesn't trigger a real OS prompt.
    requestMicPermission = defaultRequestMicPermission,
    // Factory for the Web Speech transcriber that lives in the side
    // panel (i.e. THIS context). Tests inject a stub so they don't
    // depend on the runner browser shipping SpeechRecognition.
    createLocalTranscriber = createWebSpeechTranscriber,
  } = deps;

  /** @type {VoiceState} */
  let state = { ...INITIAL_STATE };
  /** @type {Set<(s: VoiceState) => void>} */
  const subscribers = new Set();
  /** @type {AbortController | null} */
  let downloadAbort = null;
  /** @type {((chunk: any) => void) | null} */
  let activeOnChunk = null;
  /** @type {(() => void) | null} */
  let unsubMessages = null;
  /**
   * The side-panel-local transcriber, set when the engine is
   * web-speech. When non-null, the manager bypasses the offscreen
   * round-trip entirely — listenFor/stop/teardown go straight here.
   *
   * Why: Chrome's offscreen documents don't reliably inherit mic
   * permission grants from sibling extension pages. Running Web
   * Speech in the side panel (where the user clicks and where the
   * grant was acquired) avoids the cross-document permission issue
   * entirely. Moonshine still needs the offscreen for WebGPU / SW-
   * idle survival, so that path stays intact.
   *
   * @type {ReturnType<typeof createWebSpeechTranscriber> | null}
   */
  let localTranscriber = null;

  /** @param {Partial<VoiceState>} delta */
  const patch = (delta) => {
    state = { ...state, ...delta };
    for (const fn of subscribers) {
      try { fn(state); }
      catch (e) { console.error('[voice/manager] subscriber threw', e); }
    }
  };

  /** @param {unknown} e */
  const errorMessageFor = (e) => {
    if (e instanceof MicPermissionDeniedError) return 'mic-permission-denied';
    if (e instanceof SriMismatchError) return 'model-integrity-check-failed';
    if (e instanceof VoiceUnsupportedError) return 'voice-not-supported-in-this-build';
    if (e instanceof ModelDownloadError) return `download-failed${e.status ? `-${e.status}` : ''}`;
    return /** @type {{ message?: string }} */ (e)?.message ?? 'unknown-error';
  };

  // Map a runtime error envelope (sent across contexts so we can't
  // typeof-check class instances) to the same UI-facing string the
  // local error path uses.
  /** @param {string|undefined} name */
  const errorMessageForName = (name) => {
    switch (name) {
      case 'MicPermissionDeniedError': return 'mic-permission-denied';
      case 'MicHardwareError':         return 'mic-hardware-error';
      case 'TranscriberNetworkError':  return 'transcriber-network-error';
      case 'VoiceUnsupportedError':    return 'voice-not-supported-in-this-build';
      default:                          return name || 'unknown-error';
    }
  };

  /**
   * Subscribe to voice-state changes. Returns an unsubscribe function.
   *
   * @param {(s: VoiceState) => void} fn
   * @returns {() => void}
   */
  const subscribe = (fn) => {
    subscribers.add(fn);
    try { fn(state); }
    catch (e) { console.error('[voice/manager] initial subscriber call threw', e); }
    return () => subscribers.delete(fn);
  };

  /**
   * Enable voice: download (or load cached) the single shipped Moonshine
   * model, then ship the bytes to the offscreen doc for transcriber.init.
   *
   * @param {Object} [opts]
   * @param {string} [opts.variant]  back-compat only; any value is coerced
   *   to the one shipped model (normalizeVariant). A stale stored 'small'
   *   from an old install therefore loads fine instead of throwing.
   * @param {'auto'|'web-speech'|'moonshine'} [opts.engine]  engine preference
   */
  const enable = async ({ variant, engine } = {}) => {
    variant = normalizeVariant(variant);
    if (state.status === 'downloading') return;
    // why: pass the user's engine preference ('auto' default → Web Speech when
    // available, else Moonshine). detectCapability resolves it to the live engine.
    const cap = detectCapability(engine);
    if (!cap.engine) {
      const err = new VoiceUnsupportedError(
        'No transcription engine available. Vendor Moonshine or run peerd in a browser '
        + 'with the Web Speech API.',
      );
      patch({ status: 'error', error: errorMessageFor(err) });
      throw err;
    }
    patch({
      status: 'downloading',
      progress: 0,
      error: null,
      variant,
      engine: cap.engine,
      cloudVendor: cap.cloudVendor ?? null,
    });
    downloadAbort = new AbortController();
    try {
      // ---- Web Speech: run locally in this side panel --------------------
      if (cap.engine === 'web-speech') {
        if (localTranscriber) await localTranscriber.teardown();
        localTranscriber = createLocalTranscriber();
        await localTranscriber.init();
        patch({ status: 'available', progress: 1, error: null });
        return;
      }
      // ---- Moonshine: download + cache; offscreen reads from IDB ---------
      // why ship the VARIANT, not the bytes: chrome.runtime.sendMessage
      // JSON-serializes, so ArrayBuffers arrive as {} on Chrome. getModel
      // downloads + SRI-verifies + caches into the shared origin IDB here;
      // the offscreen reads the same cached bytes by variant (cache hit).
      await modelStore.getModel(variant, {
        onProgress: (p) => patch({ progress: Math.max(0, Math.min(1, p)) }),
        dev: isDev(),
        signal: downloadAbort.signal,
      });
      // Watchdog: the offscreen voice helper can crash before replying, leaving
      // the UI stuck "Downloading…" forever. Time the init round-trip out and
      // surface a clear error instead of hanging.
      const reply = await Promise.race([
        // why send cap.engine: the offscreen builds EXACTLY the engine the
        // manager resolved (it no longer re-derives from moonshineReady — with
        // Web Speech now the default, that would build the wrong engine).
        send({ type: 'voice/init', variant, engine: cap.engine }),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('voice init timed out — toggle voice off and on to retry')),
          15_000,
        )),
      ]);
      if (!reply?.ok) {
        throw new VoiceUnsupportedError(reply?.error ?? 'offscreen init failed');
      }
      // Subscribe to chunk pushes from the offscreen doc (via SW).
      if (unsubMessages) unsubMessages();
      unsubMessages = onMessage((msg) => {
        if (msg?.type === 'voice/chunk' && activeOnChunk) {
          try { activeOnChunk(msg.payload); }
          catch (e) { console.error('[voice/manager] onChunk threw', e); }
        }
        if (msg?.type === 'voice/auto-stop') {
          activeOnChunk = null;
          patch({ status: 'available', activeTarget: null });
        }
        if (msg?.type === 'voice/error') {
          // why: the offscreen transcriber surfaced an async failure
          // (mic permission denied mid-listen, network gone, hardware
          // unplugged). Revert to 'available' so the mic button is
          // clickable again, but stamp the error so the UI can render
          // the permission-needed / hardware-error message.
          activeOnChunk = null;
          patch({
            status: 'available',
            activeTarget: null,
            error: errorMessageForName(msg.payload?.name),
          });
        }
      });
      patch({ status: 'available', progress: 1, error: null });
    } catch (e) {
      patch({ status: 'error', error: errorMessageFor(e) });
      throw e;
    } finally {
      downloadAbort = null;
    }
  };

  /**
   * Disable voice: stop any active listen, tear down the offscreen
   * transcriber. Cached model bytes are NOT cleared — re-enable
   * skips the download.
   */
  const disable = async () => {
    if (downloadAbort) downloadAbort.abort();
    if (state.status === 'listening') await stop();
    if (localTranscriber) {
      try { await localTranscriber.teardown(); }
      catch (e) { console.warn('[voice/manager] local teardown failed', e); }
      localTranscriber = null;
    } else {
      // Offscreen path: tear down the remote transcriber.
      if (unsubMessages) { unsubMessages(); unsubMessages = null; }
      try { await send({ type: 'voice/teardown' }); }
      catch (e) { console.warn('[voice/manager] teardown send failed', e); }
    }
    patch({ status: 'idle', progress: 0, activeTarget: null, error: null });
  };

  /**
   * Start listening; route chunks to `onChunk` tagged with this
   * input's id. If another input is already active, swap to this one.
   *
   * @param {string} targetId
   * @param {(chunk: { text: string, committed: boolean, targetId: string|null }) => void} onChunk
   */
  const listenFor = async (targetId, onChunk) => {
    if (state.status === 'idle' || state.status === 'downloading' || state.status === 'error') {
      throw new VoiceNotEnabledError();
    }
    if (state.activeTarget && state.activeTarget !== targetId) {
      await stop();
    }
    // Acquire mic permission in the side panel's user-gesture context.
    // For both paths: the recognizer.start() under the hood calls
    // getUserMedia, and the side panel is the one place we can reliably
    // make that succeed.
    try {
      await requestMicPermission();
    } catch (e) {
      patch({ status: 'available', activeTarget: null, error: errorMessageFor(e) });
      throw e;
    }
    activeOnChunk = onChunk;
    // why: clear any stale error from a previous failed attempt — if
    // the user clicks the mic again after a permission-denied, the
    // amber state should drop immediately rather than persist until a
    // chunk lands.
    patch({ status: 'listening', activeTarget: targetId, error: null });

    if (localTranscriber) {
      // ---- Web Speech: run in this side panel; no SW round-trip ---------
      try {
        await localTranscriber.listenFor(
          targetId,
          (chunk) => {
            try { onChunk(chunk); }
            catch (e) { console.error('[voice/manager] onChunk threw', e); }
          },
          (err) => {
            // Async failure mid-listen — map to the same typed code the
            // offscreen path would have produced.
            activeOnChunk = null;
            patch({
              status: 'available',
              activeTarget: null,
              error: errorMessageForName(err?.name),
            });
          },
          () => {
            // why: the transcriber's silence timer fired (or the
            // browser ended recognition on its own). The manager state
            // was still 'listening'; sync it back to 'available' so
            // the mic button stops pulsing red.
            activeOnChunk = null;
            patch({ status: 'available', activeTarget: null });
          },
        );
      } catch (e) {
        activeOnChunk = null;
        // Sync failure on start (rare for Web Speech; happens when
        // permission is hard-denied before the prompt path).
        patch({
          status: 'available',
          activeTarget: null,
          error: /** @type {{ name?: string }} */ (e)?.name === 'NotAllowedError'
            ? 'mic-permission-denied'
            : errorMessageFor(e),
        });
        throw e;
      }
      return;
    }

    // ---- Offscreen path (Moonshine) ------------------------------------
    const reply = await send({ type: 'voice/listen', targetId });
    if (!reply?.ok) {
      activeOnChunk = null;
      patch({ status: 'available', activeTarget: null, error: reply?.error ?? 'listen-failed' });
      throw new Error(reply?.error ?? 'listen-failed');
    }
  };

  /**
   * Stop the active listen. Idempotent; safe to call when nothing is
   * listening.
   */
  const stop = async () => {
    if (state.status !== 'listening') return;
    activeOnChunk = null;
    if (localTranscriber) {
      try { await localTranscriber.stop(); }
      catch (e) { console.warn('[voice/manager] local stop threw', e); }
    } else {
      try { await send({ type: 'voice/stop' }); }
      catch (e) { console.warn('[voice/manager] stop send failed', e); }
    }
    patch({ status: 'available', activeTarget: null });
  };

  /**
   * Bump the silence threshold (auto-stop after N ms of silence).
   * Forwards to the offscreen transcriber.
   *
   * @param {number} ms
   */
  const setSilenceThreshold = async (ms) => {
    if (localTranscriber) {
      localTranscriber.setSilenceThreshold(ms);
      return;
    }
    await send({ type: 'voice/silence', ms });
  };

  const isAvailable = () => state.status === 'available' || state.status === 'listening';
  const isListening = () => state.status === 'listening';
  const getState = () => state;

  /**
   * Drop any sticky error so the UI returns to a clean state. Called
   * from the "Clear error & retry" affordance in settings after the
   * user has gone to fix browser / OS mic permission. Doesn't change
   * status — only clears state.error.
   */
  const clearError = () => {
    if (state.error !== null) patch({ error: null });
  };

  return Object.freeze({
    enable,
    disable,
    listenFor,
    stop,
    clearError,
    setSilenceThreshold,
    subscribe,
    isAvailable,
    isListening,
    getState,
  });
};

/**
 * Default mic-permission probe.
 *
 * 1. permissions.query first — if already granted, we're done with no
 *    prompt, no audio stream creation.
 * 2. Otherwise getUserMedia({audio:true}) — this is the call that
 *    triggers the browser prompt. It MUST run in a user-gesture
 *    context (the click on the mic button); otherwise Chrome rejects
 *    silently with NotAllowedError.
 * 3. Stop the tracks immediately — we don't need the stream, we just
 *    wanted the grant. The grant persists for the extension origin
 *    so the offscreen's Web Speech / Moonshine call inherits it.
 *
 * Throws MicPermissionDeniedError on NotAllowedError / SecurityError;
 * lets other errors propagate so the manager can map them.
 *
 * @returns {Promise<void>}
 */
const defaultRequestMicPermission = async () => {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    // Non-browser context — let the offscreen handle whatever it can.
    return;
  }
  // Optional fast path: query first to avoid a redundant prompt.
  // Not all engines/browsers expose 'microphone' in permissions.query;
  // failures here are non-fatal — fall through to getUserMedia.
  try {
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({ name: 'microphone' });
      if (status.state === 'granted') return;
      if (status.state === 'denied') throw new MicPermissionDeniedError();
    }
  } catch (e) {
    if (e instanceof MicPermissionDeniedError) throw e;
    // 'microphone' not a recognised permission name in this browser;
    // proceed to the explicit prompt.
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    const name = /** @type {{ name?: string }} */ (e)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new MicPermissionDeniedError();
    }
    throw e;
  }
  // We have the grant. Release the stream — the offscreen will open
  // its own when it actually starts transcribing.
  try {
    stream.getTracks().forEach((t) => t.stop());
  } catch (e) {
    console.warn('[voice/manager] failed to release probe stream', e);
  }
};
