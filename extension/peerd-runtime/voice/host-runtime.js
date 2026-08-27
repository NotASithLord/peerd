// @ts-check
// DOM-hosted voice runtime shared by Chrome's offscreen document and
// Firefox's background page. Authority and sender admission stay outside.

import { makeBoundedModuleLoader } from '/shared/bounded-module-load.js';

/** @param {unknown} cause */
const voiceFailure = (cause) => {
  const error = /** @type {{name?:unknown,message?:unknown,code?:unknown,phase?:unknown}} */ (cause);
  if (error?.phase === 'startup') return {
    ok: false,
    code: typeof error.code === 'string' ? error.code : 'voice-host-load-failed',
    error: 'Feature unavailable. Try again.',
    outcomeKnown: true,
    retryable: true,
    phase: 'startup',
  };
  return {
    ok: false,
    error: typeof error?.name === 'string' && error.name
      ? error.name : typeof error?.message === 'string' ? error.message : String(cause),
  };
};

/**
 * @param {Object} deps
 * @param {(event:any)=>Promise<any>|any} deps.emit
 * @param {()=>Promise<{createBestTranscriber:(deps?:any,pref?:any)=>any}>} [deps.loadEngine]
 * @param {()=>Promise<any>} [deps.loadModelStore]
 * @param {any} [deps.navigatorEnv]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 * @param {number} [deps.noSpeechMs]
 */
export const createVoiceHostRuntime = ({
  emit,
  loadEngine = () => import('/peerd-runtime/voice/transcriber-picker.js'),
  loadModelStore = () => import('/peerd-runtime/offscreen.js')
    .then(({ createModelStore }) => createModelStore()),
  navigatorEnv = globalThis.navigator,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  noSpeechMs = 15_000,
}) => {
  if (typeof emit !== 'function' || !Number.isFinite(noSpeechMs) || noSpeechMs <= 0) {
    throw new TypeError('voice-host-runtime-config-invalid');
  }
  const getEngine = makeBoundedModuleLoader(loadEngine, {
    loadCode: 'voice-host-load-failed', timeoutCode: 'voice-host-load-timeout',
  });
  const getModelStore = makeBoundedModuleLoader(loadModelStore, {
    loadCode: 'voice-model-store-load-failed', timeoutCode: 'voice-model-store-load-timeout',
  });
  /** @type {any|null} */
  let transcriber = null;
  /** @type {Set<MediaStream>} */
  const liveMicStreams = new Set();
  const mediaDevices = navigatorEnv?.mediaDevices;
  const originalGetUserMedia = mediaDevices?.getUserMedia?.bind(mediaDevices);
  if (originalGetUserMedia) {
    mediaDevices.getUserMedia = async (/** @type {MediaStreamConstraints} */ constraints) => {
      const stream = await originalGetUserMedia(constraints);
      if (constraints?.audio) liveMicStreams.add(stream);
      return stream;
    };
  }
  const releaseMicTracks = () => {
    for (const stream of liveMicStreams) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* already stopped */ }
      }
    }
    liveMicStreams.clear();
  };
  /** @type {ReturnType<typeof setTimeoutFn>|null} */
  let noSpeechTimer = null;
  const clearNoSpeechTimer = () => {
    if (noSpeechTimer !== null) clearTimeoutFn(noSpeechTimer);
    noSpeechTimer = null;
  };
  /** @param {any} event */
  const push = (event) => { void Promise.resolve(emit(event)).catch(() => {}); };
  /** @param {any} error */
  const onError = (error) => {
    clearNoSpeechTimer();
    releaseMicTracks();
    push({ type: 'voice/error', payload: error });
  };
  /** @param {string|undefined} targetId */
  const armNoSpeechTimer = (targetId) => {
    clearNoSpeechTimer();
    noSpeechTimer = setTimeoutFn(() => {
      void Promise.resolve(transcriber?.stop?.()).catch(() => {}).finally(() => {
        releaseMicTracks();
        onError({
          name: 'VoiceNoSpeechError',
          message: 'Heard nothing — mic released. Click the mic to try again.',
          targetId,
        });
      });
    }, noSpeechMs);
  };
  const teardown = async () => {
    clearNoSpeechTimer();
    try { await transcriber?.teardown?.(); }
    finally {
      transcriber = null;
      releaseMicTracks();
    }
    return { ok: true };
  };
  const handle = async (/** @type {any} */ command) => {
    try {
      if (command?.type === 'voice/init') {
        if (!transcriber) {
          const { createBestTranscriber } = await getEngine();
          transcriber = createBestTranscriber({}, command.engine);
        }
        if (transcriber.engine === 'moonshine') {
          const store = await getModelStore();
          const { files } = await store.getModel(command.variant, { dev: true });
          await transcriber.init({ files });
        } else await transcriber.init();
        return { ok: true, engine: transcriber.engine };
      }
      if (command?.type === 'voice/listen') {
        if (!transcriber) return { ok: false, error: 'not-initialized' };
        await transcriber.listenFor(
          command.targetId,
          (/** @type {any} */ chunk) => {
            if (noSpeechTimer !== null) armNoSpeechTimer(chunk?.targetId);
            push({ type: 'voice/chunk', payload: chunk });
          },
          onError,
          (/** @type {{targetId?:string|null}} */ info = {}) => {
            clearNoSpeechTimer();
            releaseMicTracks();
            push({ type: 'voice/auto-stop', payload: { targetId: info.targetId } });
          },
        );
        armNoSpeechTimer(command.targetId);
        return { ok: true };
      }
      if (command?.type === 'voice/stop') {
        clearNoSpeechTimer();
        try { await transcriber?.stop?.(); }
        finally { releaseMicTracks(); }
        return { ok: true };
      }
      if (command?.type === 'voice/silence') {
        transcriber?.setSilenceThreshold?.(command.ms);
        return { ok: true };
      }
      if (command?.type === 'voice/teardown') return teardown();
      return { ok: false, error: 'unknown-voice-command' };
    } catch (cause) {
      return voiceFailure(cause);
    }
  };
  return Object.freeze({ handle, teardown });
};
