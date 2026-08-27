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
  let generation = 0;
  /** @type {Map<MediaStream, number>} */
  const liveMicStreams = new Map();
  const mediaDevices = navigatorEnv?.mediaDevices;
  const originalGetUserMedia = mediaDevices?.getUserMedia?.bind(mediaDevices);
  if (originalGetUserMedia) {
    mediaDevices.getUserMedia = async (/** @type {MediaStreamConstraints} */ constraints) => {
      const owner = generation;
      const stream = await originalGetUserMedia(constraints);
      // why: a retired getUserMedia promise may resolve after a successor
      // listen starts. Keep the stream attached to the requesting generation
      // so stale cleanup cannot stop its successor's microphone.
      if (constraints?.audio) liveMicStreams.set(stream, owner);
      return stream;
    };
  }
  /** @param {number|null} [owner] */
  const releaseMicTracks = (owner = null) => {
    for (const [stream, streamOwner] of liveMicStreams) {
      if (owner !== null && streamOwner !== owner) continue;
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* already stopped */ }
      }
      liveMicStreams.delete(stream);
    }
  };
  /** @param {MediaStream[]} streams */
  const releaseExactMicTracks = (streams) => {
    for (const stream of streams) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* already stopped */ }
      }
      liveMicStreams.delete(stream);
    }
  };
  /** @type {ReturnType<typeof setTimeoutFn>|null} */
  let noSpeechTimer = null;
  const clearNoSpeechTimer = () => {
    if (noSpeechTimer !== null) clearTimeoutFn(noSpeechTimer);
    noSpeechTimer = null;
  };
  /** @param {unknown} value @param {number} max */
  const boundedString = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  /** @param {unknown} value */
  const targetId = (value) => typeof value === 'string' ? value.slice(0, 256) : null;
  /** @param {any} event */
  const push = (event) => { void Promise.resolve(emit(event)).catch(() => {}); };
  /** @param {any} error */
  const pushError = (error) => {
    clearNoSpeechTimer();
    releaseMicTracks();
    push({
      type: 'voice/error',
      payload: {
        name: boundedString(error?.name, 64) || 'TranscriberError',
        message: boundedString(error?.message, 512),
        ...(boundedString(error?.code, 64) ? { code: boundedString(error.code, 64) } : {}),
        targetId: targetId(error?.targetId),
      },
    });
  };
  /** @param {number} owner @param {()=>boolean} current */
  const operationCurrent = (owner, current) => generation === owner && current();
  /** @param {string|undefined} ownerTargetId @param {number} owner @param {any} active @param {()=>boolean} current */
  const armNoSpeechTimer = (ownerTargetId, owner, active, current) => {
    clearNoSpeechTimer();
    noSpeechTimer = setTimeoutFn(() => {
      if (!operationCurrent(owner, current) || transcriber !== active) return;
      void Promise.resolve(active?.stop?.()).catch(() => {}).finally(() => {
        if (!operationCurrent(owner, current) || transcriber !== active) return;
        releaseMicTracks();
        pushError({
          name: 'VoiceNoSpeechError',
          message: 'Heard nothing — mic released. Click the mic to try again.',
          targetId: ownerTargetId,
        });
      });
    }, noSpeechMs);
  };
  const teardown = async () => {
    generation += 1;
    clearNoSpeechTimer();
    const active = transcriber;
    transcriber = null;
    // why: release the exact retiring microphones before a possibly slow
    // engine teardown. A successor may then start without a late finally
    // stopping streams acquired by its newer generation.
    const retiringStreams = [...liveMicStreams.keys()];
    releaseExactMicTracks(retiringStreams);
    try { await active?.teardown?.(); }
    finally { releaseExactMicTracks(retiringStreams); }
    return { ok: true };
  };
  /** @param {any} active @param {number} owner */
  const retireStale = async (active, owner) => {
    if (transcriber === active) transcriber = null;
    try { await active?.teardown?.(); } catch {}
    releaseMicTracks(owner);
    return {
      ok: false, error: 'voice-host-generation-retired', outcomeKnown: true, retryable: true,
    };
  };
  /**
   * @param {any} command
   * @param {{current?:()=>boolean}} [custody]
   */
  const handle = async (command, { current = () => true } = {}) => {
    if (typeof current !== 'function') return { ok: false, error: 'voice-custody-invalid' };
    if (command?.type === 'voice/teardown') {
      try { return await teardown(); } catch (cause) { return voiceFailure(cause); }
    }
    if (command?.type === 'voice/stop') generation += 1;
    const owner = command?.type === 'voice/init' || command?.type === 'voice/listen'
      ? ++generation : generation;
    try {
      if (command?.type === 'voice/init') {
        let active = transcriber;
        if (!active) {
          const { createBestTranscriber } = await getEngine();
          if (!operationCurrent(owner, current)) return retireStale(null, owner);
          active = createBestTranscriber({}, command.engine);
          if (!operationCurrent(owner, current)) return retireStale(active, owner);
          transcriber = active;
        }
        if (active.engine === 'moonshine') {
          const store = await getModelStore();
          if (!operationCurrent(owner, current)) return retireStale(active, owner);
          const { files } = await store.getModel(command.variant, { dev: true });
          if (!operationCurrent(owner, current)) return retireStale(active, owner);
          await active.init({ files });
        } else await active.init();
        if (!operationCurrent(owner, current)) return retireStale(active, owner);
        return { ok: true, engine: active.engine };
      }
      if (command?.type === 'voice/listen') {
        const active = transcriber;
        if (!active) return { ok: false, error: 'not-initialized' };
        if (!operationCurrent(owner, current)) return retireStale(active, owner);
        await active.listenFor(
          command.targetId,
          (/** @type {any} */ chunk) => {
            if (!operationCurrent(owner, current) || transcriber !== active) return;
            if (noSpeechTimer !== null) {
              armNoSpeechTimer(chunk?.targetId, owner, active, current);
            }
            push({
              type: 'voice/chunk',
              payload: {
                text: boundedString(chunk?.text, 65_536),
                committed: chunk?.committed === true,
                targetId: targetId(chunk?.targetId),
              },
            });
          },
          (/** @type {any} */ error) => {
            if (!operationCurrent(owner, current) || transcriber !== active) return;
            pushError(error);
          },
          (/** @type {{targetId?:string|null}} */ info = {}) => {
            if (!operationCurrent(owner, current) || transcriber !== active) return;
            clearNoSpeechTimer();
            releaseMicTracks();
            push({ type: 'voice/auto-stop', payload: { targetId: targetId(info.targetId) } });
          },
        );
        if (!operationCurrent(owner, current)) return retireStale(active, owner);
        armNoSpeechTimer(command.targetId, owner, active, current);
        return { ok: true };
      }
      if (command?.type === 'voice/stop') {
        clearNoSpeechTimer();
        const active = transcriber;
        try { await active?.stop?.(); }
        finally { releaseMicTracks(); }
        return { ok: true };
      }
      if (command?.type === 'voice/silence') {
        transcriber?.setSilenceThreshold?.(command.ms);
        return { ok: true };
      }
      return { ok: false, error: 'unknown-voice-command' };
    } catch (cause) {
      return voiceFailure(cause);
    }
  };
  return Object.freeze({ handle, teardown });
};
