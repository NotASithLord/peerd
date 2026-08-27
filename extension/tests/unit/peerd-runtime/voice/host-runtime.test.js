// @ts-check

import { createVoiceHostRuntime } from '/peerd-runtime/voice/host-runtime.js';
import { describe, expect, it } from '../../../framework.js';

describe('voice host runtime', () => {
  it('keeps one transcriber across commands and emits bounded voice events', async () => {
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
});
