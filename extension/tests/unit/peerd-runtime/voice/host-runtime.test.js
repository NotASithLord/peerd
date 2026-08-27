// @ts-check

import { createVoiceHostRuntime } from '/peerd-runtime/voice/host-runtime.js';
import { describe, expect, it } from '../../../framework.js';

describe('voice host runtime', () => {
  it('keeps one transcriber across commands and emits bounded voice events', async () => {
    /** @type {any[]} */
    /** @type {any[]} */
    const events = [];
    /** @type {(value:any)=>void} */
    let chunk = () => {};
    /** @type {(value:any)=>void} */
    let autoStop = () => {};
    let teardowns = 0;
    const transcriber = {
      engine: 'moonshine',
      init: async () => {},
      listenFor: async (
        /** @type {string} */ _target,
        /** @type {(value:any)=>void} */ onChunk,
        /** @type {(value:any)=>void} */ _onError,
        /** @type {(value:any)=>void} */ onAutoStop,
      ) => {
        chunk = onChunk;
        autoStop = onAutoStop;
      },
      stop: async () => {},
      teardown: async () => { teardowns += 1; },
      setSilenceThreshold: () => {},
    };
    const host = createVoiceHostRuntime({
      emit: (event) => { events.push(event); },
      loadEngine: async () => ({ createBestTranscriber: () => transcriber }),
      loadModelStore: async () => ({
        getModel: async () => ({ files: { encoder: new ArrayBuffer(1), decoder: new ArrayBuffer(1) } }),
      }),
      navigatorEnv: {},
    });
    expect(await host.handle({ type: 'voice/init', engine: 'moonshine', variant: 'base' }))
      .toEqual({ ok: true, engine: 'moonshine' });
    expect(await host.handle({ type: 'voice/listen', targetId: 'composer' }))
      .toEqual({ ok: true });
    chunk({ text: 'hello', committed: true, targetId: 'composer' });
    autoStop({ targetId: 'composer' });
    expect(events).toEqual([
      { type: 'voice/chunk', payload: { text: 'hello', committed: true, targetId: 'composer' } },
      { type: 'voice/auto-stop', payload: { targetId: 'composer' } },
    ]);
    expect(await host.handle({ type: 'voice/teardown' })).toEqual({ ok: true });
    expect(teardowns).toBe(1);
  });

  it('cannot resurrect a transcriber when custody is retired during model loading', async () => {
    /** @type {(value:any)=>void} */
    let releaseModel = () => {};
    const model = new Promise((resolve) => { releaseModel = resolve; });
    /** @type {()=>void} */
    let noteModelStarted = () => {};
    const modelStarted = new Promise((resolve) => {
      noteModelStarted = () => resolve(undefined);
    });
    let teardowns = 0;
    const transcriber = {
      engine: 'moonshine',
      init: async () => {},
      listenFor: async () => {},
      stop: async () => {},
      teardown: async () => { teardowns += 1; },
    };
    const host = createVoiceHostRuntime({
      emit: () => {},
      loadEngine: async () => ({ createBestTranscriber: () => transcriber }),
      loadModelStore: async () => ({
        getModel: async () => { noteModelStarted(); return model; },
      }),
      navigatorEnv: {},
    });
    let current = true;
    const initializing = host.handle(
      { type: 'voice/init', engine: 'moonshine', variant: 'base' },
      { current: () => current },
    );
    await modelStarted;
    current = false;
    expect(await host.teardown()).toEqual({ ok: true });
    releaseModel({ files: { encoder: new ArrayBuffer(1), decoder: new ArrayBuffer(1) } });
    expect(await initializing).toEqual({
      ok: false, error: 'voice-host-generation-retired', outcomeKnown: true, retryable: true,
    });
    expect(await host.handle({ type: 'voice/listen', targetId: 'composer' }))
      .toEqual({ ok: false, error: 'not-initialized' });
    expect(teardowns).toBeGreaterThan(0);
  });

  it('a retired media promise cannot stop a successor microphone', async () => {
    /** @type {()=>void} */
    let releaseOldMedia = () => {};
    const oldMediaReady = new Promise((resolve) => {
      releaseOldMedia = () => resolve(undefined);
    });
    /** @type {()=>void} */
    let noteOldMediaStarted = () => {};
    const oldMediaStarted = new Promise((resolve) => {
      noteOldMediaStarted = () => resolve(undefined);
    });
    const oldTrack = { stopped: false, stop() { this.stopped = true; } };
    const newTrack = { stopped: false, stop() { this.stopped = true; } };
    const oldStream = { getTracks: () => [oldTrack] };
    const newStream = { getTracks: () => [newTrack] };
    let mediaCalls = 0;
    const navigatorEnv = /** @type {any} */ ({ mediaDevices: {
      getUserMedia: async () => {
        mediaCalls += 1;
        if (mediaCalls === 1) {
          noteOldMediaStarted();
          await oldMediaReady;
          return oldStream;
        }
        return newStream;
      },
    } });
    const transcribers = [0, 1].map(() => ({
      engine: 'web-speech',
      init: async () => {},
      listenFor: async () => { await navigatorEnv.mediaDevices.getUserMedia({ audio: true }); },
      stop: async () => {},
      teardown: async () => {},
    }));
    let created = 0;
    const host = createVoiceHostRuntime({
      emit: () => {}, navigatorEnv,
      loadEngine: async () => ({ createBestTranscriber: () => transcribers[created++] }),
      setTimeoutFn: /** @type {typeof setTimeout} */ (
        /** @type {unknown} */ (() => /** @type {any} */ (1))
      ),
      clearTimeoutFn: () => {},
    });
    expect(await host.handle({ type: 'voice/init', engine: 'web-speech', variant: 'base' }))
      .toEqual({ ok: true, engine: 'web-speech' });
    const retiredListen = host.handle({ type: 'voice/listen', targetId: 'old' });
    await oldMediaStarted;
    await host.teardown();
    expect(await host.handle({ type: 'voice/init', engine: 'web-speech', variant: 'base' }))
      .toEqual({ ok: true, engine: 'web-speech' });
    expect(await host.handle({ type: 'voice/listen', targetId: 'new' })).toEqual({ ok: true });
    releaseOldMedia();
    expect(await retiredListen).toEqual({
      ok: false, error: 'voice-host-generation-retired', outcomeKnown: true, retryable: true,
    });
    expect(oldTrack.stopped).toBe(true);
    expect(newTrack.stopped).toBe(false);
  });

  it('a no-speech stop cannot race a successor listen', async () => {
    /** @type {()=>void} */
    let fireNoSpeech = () => {};
    /** @type {()=>void} */
    let releaseStop = () => {};
    const stopGate = new Promise((resolve) => { releaseStop = () => resolve(undefined); });
    let listens = 0;
    let stops = 0;
    /** @type {any[]} */
    const events = [];
    const transcriber = {
      engine: 'web-speech',
      init: async () => {},
      listenFor: async () => { listens += 1; },
      stop: async () => { stops += 1; await stopGate; },
      teardown: async () => {},
    };
    const host = createVoiceHostRuntime({
      emit: (event) => { events.push(event); },
      loadEngine: async () => ({ createBestTranscriber: () => transcriber }),
      navigatorEnv: {},
      setTimeoutFn: /** @type {typeof setTimeout} */ ((/** @type {()=>void} */ callback) => {
        fireNoSpeech = callback;
        return /** @type {any} */ (1);
      }),
      clearTimeoutFn: () => {},
    });
    await host.handle({ type: 'voice/init', engine: 'web-speech', variant: 'base' });
    await host.handle({ type: 'voice/listen', targetId: 'old' });
    fireNoSpeech();
    await Promise.resolve();
    expect(stops).toBe(1);

    const successor = host.handle({ type: 'voice/listen', targetId: 'new' });
    await Promise.resolve();
    expect(listens).toBe(1);
    releaseStop();
    expect(await successor).toEqual({ ok: true });
    expect(listens).toBe(2);
    expect(events).toEqual([]);
  });
});
