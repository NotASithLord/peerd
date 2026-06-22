// @ts-check
// voice manager — side-panel-side lifecycle + state machine.
//
// Tests use a mocked send() + onMessage subscribe pair so we can drive
// the offscreen-doc replies and the chunk pushes deterministically.

import { describe, it, expect } from '../../../framework.js';
import { createVoiceManager } from '/peerd-runtime/voice/index.js';
import { MicPermissionDeniedError } from '/peerd-runtime/voice/errors.js';

/** @typedef {import('/peerd-runtime/voice/model-store.js').createModelStore} CreateModelStore */

/**
 * @param {{ files?: Record<string, ArrayBuffer>, fail?: boolean, seenVariants?: string[] }} [opts]
 * @returns {ReturnType<typeof import('/peerd-runtime/voice/index.js').createModelStore>}
 */
const fakeModelStore = ({ files = { encoder: new ArrayBuffer(8), decoder: new ArrayBuffer(8) }, fail = false, seenVariants = [] } = {}) => ({
  /**
   * @param {string} [variant]
   * @param {{ onProgress?: (p: number) => void, dev?: boolean, signal?: AbortSignal }} [opts]
   */
  getModel: async (variant, opts) => {
    seenVariants.push(variant ?? '');
    if (fail) throw Object.assign(new Error('boom'), { name: 'ModelDownloadError', status: 503 });
    opts?.onProgress?.(0.5);
    opts?.onProgress?.(1);
    return { files, sizeBytes: 16, variant: /** @type {'base'} */ (variant ?? 'base') };
  },
});

// why: pin the engine in tests so the result doesn't depend on whether
// the runner browser ships Web Speech. Each test passes a stub. Cast to the
// real detectVoiceCapability shape — these are deliberately-minimal stand-ins.
/** @typedef {typeof import('/peerd-runtime/voice/index.js').detectVoiceCapability} DetectCap */
const moonshineCap = /** @type {DetectCap} */ (() => ({ engine: 'moonshine', source: 'vendored', webSpeech: false, moonshine: true, cloudVendor: null }));
const webSpeechCap = /** @type {DetectCap} */ (() => ({ engine: 'web-speech', source: 'browser', cloudVendor: 'test-cloud', webSpeech: true, moonshine: false }));
const noEngineCap  = /** @type {DetectCap} */ (() => ({ engine: null, source: null, webSpeech: false, moonshine: false, cloudVendor: null }));

const makeBackend = () => {
  /** @type {any[]} */
  const sends = [];
  /** @type {((msg: any) => void) | null} */
  let chunkHandler = null;
  /** @type {any} */
  let nextReply = { ok: true };
  return {
    sends,
    /** @param {any} r */
    setReply: (r) => { nextReply = r; },
    /** @param {any} msg */
    pushChunk: (msg) => chunkHandler?.(msg),
    /** @param {any} msg */
    send: async (msg) => { sends.push(msg); return nextReply; },
    /** @param {(msg: any) => void} h */
    onMessage: (h) => { chunkHandler = h; return () => { chunkHandler = null; }; },
  };
};

describe('voice.manager', () => {
  describe('enable / disable', () => {
    it('walks idle → downloading → available on success', async () => {
      const backend = makeBackend();
      /** @type {string[]} */
      const states = [];
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(), detectCapability: moonshineCap, requestMicPermission: async () => {},
      });
      m.subscribe((s) => states.push(s.status));
      await m.enable();
      expect(states).toContain('idle');
      expect(states).toContain('downloading');
      expect(states).toContain('available');
      expect(m.isAvailable()).toBe(true);
      expect(backend.sends.find((s) => s.type === 'voice/init')).toBeTruthy();
    });

    it('coerces a stale/legacy variant to the shipped model (no crash)', async () => {
      // The recurring bug: an old install passes voiceVariant:'small'.
      // enable() must normalize it to the one shipped model before the
      // store sees it, so the model store never gets an unknown key.
      /** @type {string[]} */
      const seenVariants = [];
      const backend = makeBackend();
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore({ seenVariants }), detectCapability: moonshineCap, requestMicPermission: async () => {},
      });
      await m.enable({ variant: 'small' });
      expect(m.isAvailable()).toBe(true);
      expect(seenVariants).toEqual(['base']);   // coerced before the store call
      expect(m.getState().variant).toBe('base');
    });

    it('transitions to error and surfaces a typed message on download failure', async () => {
      const backend = makeBackend();
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore({ fail: true }), detectCapability: moonshineCap, requestMicPermission: async () => {},
      });
      await expect(() => m.enable()).toThrow();
      expect(m.getState().status).toBe('error');
      expect(m.isAvailable()).toBe(false);
    });

    it('disable tears down and returns to idle', async () => {
      const backend = makeBackend();
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(), detectCapability: moonshineCap, requestMicPermission: async () => {},
      });
      await m.enable();
      await m.disable();
      expect(m.getState().status).toBe('idle');
      expect(backend.sends.find((s) => s.type === 'voice/teardown')).toBeTruthy();
    });
  });

  describe('listenFor / stop', () => {
    it('refuses listenFor before enable', async () => {
      const backend = makeBackend();
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(), detectCapability: moonshineCap, requestMicPermission: async () => {},
      });
      await expect(() => m.listenFor('input-A', () => {}))
        .toThrow(e => e.name === 'VoiceNotEnabledError');
    });

    it('starts listening when available', async () => {
      const backend = makeBackend();
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(), detectCapability: moonshineCap, requestMicPermission: async () => {},
      });
      await m.enable();
      await m.listenFor('input-A', () => {});
      expect(m.getState().activeTarget).toBe('input-A');
      expect(m.isListening()).toBe(true);
      expect(backend.sends.find((s) => s.type === 'voice/listen')?.targetId).toBe('input-A');
    });

    it('listenFor on a new target stops the previous one', async () => {
      const backend = makeBackend();
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(), detectCapability: moonshineCap, requestMicPermission: async () => {},
      });
      await m.enable();
      await m.listenFor('input-A', () => {});
      await m.listenFor('input-B', () => {});
      // A stop should have been emitted between the two listens.
      const types = backend.sends.map((s) => s.type);
      expect(types.includes('voice/stop')).toBe(true);
      expect(m.getState().activeTarget).toBe('input-B');
    });

    it('routes voice/chunk pushes to the active onChunk callback', async () => {
      const backend = makeBackend();
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(), detectCapability: moonshineCap, requestMicPermission: async () => {},
      });
      await m.enable();
      /** @type {Array<{ text: string, committed: boolean, targetId: string|null }>} */
      const received = [];
      await m.listenFor('input-A', (c) => received.push(c));
      backend.pushChunk({ type: 'voice/chunk', payload: { text: 'hello', committed: false, targetId: 'input-A' } });
      backend.pushChunk({ type: 'voice/chunk', payload: { text: 'hello world', committed: true, targetId: 'input-A' } });
      expect(received.length).toBe(2);
      expect(received[1].committed).toBe(true);
    });

    it('voice/auto-stop pushes drop activeTarget and revert to available', async () => {
      const backend = makeBackend();
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(), detectCapability: moonshineCap, requestMicPermission: async () => {},
      });
      await m.enable();
      await m.listenFor('input-A', () => {});
      backend.pushChunk({ type: 'voice/auto-stop' });
      expect(m.getState().status).toBe('available');
      expect(m.getState().activeTarget).toBe(null);
    });

    it('voice/error from the offscreen surfaces a typed error code on state', async () => {
      const backend = makeBackend();
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(), detectCapability: moonshineCap, requestMicPermission: async () => {},
      });
      await m.enable();
      await m.listenFor('input-A', () => {});
      backend.pushChunk({
        type: 'voice/error',
        payload: { name: 'MicPermissionDeniedError', message: 'denied', targetId: 'input-A' },
      });
      expect(m.getState().status).toBe('available');
      expect(m.getState().activeTarget).toBe(null);
      expect(m.getState().error).toBe('mic-permission-denied');
    });

    it('voice/error maps hardware + network failures to specific codes', async () => {
      const backend = makeBackend();
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(), detectCapability: moonshineCap, requestMicPermission: async () => {},
      });
      await m.enable();
      await m.listenFor('input-A', () => {});
      backend.pushChunk({
        type: 'voice/error',
        payload: { name: 'MicHardwareError', message: 'no device', targetId: 'input-A' },
      });
      expect(m.getState().error).toBe('mic-hardware-error');
      await m.listenFor('input-A', () => {});
      backend.pushChunk({
        type: 'voice/error',
        payload: { name: 'TranscriberNetworkError', message: 'unreachable', targetId: 'input-A' },
      });
      expect(m.getState().error).toBe('transcriber-network-error');
    });
  });

  describe('subscribers', () => {
    it('fires once on subscribe with current state, then on each transition', async () => {
      const backend = makeBackend();
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(), detectCapability: moonshineCap, requestMicPermission: async () => {},
      });
      /** @type {string[]} */
      const observed = [];
      m.subscribe((s) => observed.push(s.status));
      await m.enable();
      expect(observed[0]).toBe('idle');             // initial replay
      expect(observed.includes('downloading')).toBe(true);
      expect(observed[observed.length - 1]).toBe('available');
    });

    it('unsubscribe stops further notifications', async () => {
      const backend = makeBackend();
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(), detectCapability: moonshineCap, requestMicPermission: async () => {},
      });
      let count = 0;
      const unsub = m.subscribe(() => count++);
      const before = count;
      unsub();
      await m.enable();
      // The only counted call should be the initial replay.
      expect(count).toBe(before);
    });
  });

  describe('mic permission prompt', () => {
    it('runs requestMicPermission before sending voice/listen', async () => {
      const backend = makeBackend();
      /** @type {string[]} */
      const sequence = [];
      const m = createVoiceManager({
        /** @param {any} msg */
        send: async (msg) => { sequence.push(`send:${msg.type}`); return { ok: true }; },
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(),
        detectCapability: moonshineCap,
        requestMicPermission: async () => { sequence.push('prompt'); },
      });
      await m.enable();
      await m.listenFor('input-A', () => {});
      const promptIdx = sequence.indexOf('prompt');
      const listenIdx = sequence.indexOf('send:voice/listen');
      expect(promptIdx >= 0).toBe(true);
      expect(listenIdx > promptIdx).toBe(true);
    });

    it('skips voice/listen and surfaces a typed error when permission is denied', async () => {
      const backend = makeBackend();
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(),
        detectCapability: moonshineCap,
        // why: a real instance, not a name-tagged plain Error — the
        // prompt runs locally in the side panel, so the manager matches
        // it by instanceof (errorMessageForName handles the errors that
        // cross the messaging boundary and lose their prototype).
        requestMicPermission: async () => {
          throw new MicPermissionDeniedError();
        },
      });
      await m.enable();
      await expect(() => m.listenFor('input-A', () => {}))
        .toThrow(e => e.name === 'MicPermissionDeniedError');
      expect(m.getState().status).toBe('available');
      expect(m.getState().activeTarget).toBe(null);
      expect(m.getState().error).toBe('mic-permission-denied');
      // The offscreen never gets the voice/listen request when the
      // side-panel prompt rejects.
      expect(backend.sends.find((s) => s.type === 'voice/listen')).toBe(undefined);
    });
  });

  describe('engine picker', () => {
    it('uses Web Speech when Moonshine is not vendored — no model download, no offscreen init', async () => {
      const backend = makeBackend();
      let modelCalled = false;
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        // why cast: web-speech path never calls getModel; minimal stub stands
        // in for the full model-store surface.
        modelStore: /** @type {ReturnType<typeof import('/peerd-runtime/voice/index.js').createModelStore>} */ ({
          getModel: async () => { modelCalled = true; return { files: {}, sizeBytes: 0, variant: /** @type {'base'} */ ('base') }; },
        }),
        detectCapability: webSpeechCap, requestMicPermission: async () => {},
        createLocalTranscriber: /** @type {typeof import('/peerd-runtime/voice/web-speech-transcriber.js').createWebSpeechTranscriber} */ (/** @type {unknown} */ (() => ({
          engine: 'web-speech',
          init: async () => {},
          listenFor: async () => {},
          stop: async () => {},
          teardown: async () => {},
          setSilenceThreshold: () => {},
        }))),
      });
      await m.enable();
      expect(modelCalled).toBe(false);
      expect(m.getState().engine).toBe('web-speech');
      expect(m.getState().cloudVendor).toBe('test-cloud');
      // The whole point of this branch: Web Speech runs in the side
      // panel; NO voice/init is sent over the SW.
      expect(backend.sends.find((s) => s.type === 'voice/init')).toBe(undefined);
    });

    it('Web Speech listenFor goes straight to the local transcriber, not the SW', async () => {
      const backend = makeBackend();
      /** @type {string[]} */
      const localCalls = [];
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(),
        detectCapability: webSpeechCap,
        requestMicPermission: async () => {},
        createLocalTranscriber: /** @type {typeof import('/peerd-runtime/voice/web-speech-transcriber.js').createWebSpeechTranscriber} */ (/** @type {unknown} */ (() => ({
          engine: 'web-speech',
          init: async () => { localCalls.push('init'); },
          /**
           * @param {string} targetId
           * @param {(chunk: { text: string, committed: boolean, targetId: string|null }) => void} onChunk
           */
          listenFor: async (targetId, onChunk) => {
            localCalls.push(`listen:${targetId}`);
            onChunk({ text: 'hi', committed: true, targetId });
          },
          stop: async () => { localCalls.push('stop'); },
          teardown: async () => { localCalls.push('teardown'); },
          setSilenceThreshold: () => {},
        }))),
      });
      await m.enable();
      /** @type {Array<{ text: string, committed: boolean, targetId: string|null }>} */
      const chunks = [];
      await m.listenFor('input-A', (c) => chunks.push(c));
      expect(localCalls).toContain('init');
      expect(localCalls).toContain('listen:input-A');
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toBe('hi');
      // No SW round-trip for voice/listen.
      expect(backend.sends.find((s) => s.type === 'voice/listen')).toBe(undefined);
    });

    it('errors cleanly when neither engine is available', async () => {
      const backend = makeBackend();
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(),
        detectCapability: noEngineCap, requestMicPermission: async () => {},
      });
      await expect(() => m.enable())
        .toThrow(e => e.name === 'VoiceUnsupportedError');
      expect(m.getState().status).toBe('error');
    });

    it('exposes the chosen engine in state for UI surfacing', async () => {
      const backend = makeBackend();
      const m = createVoiceManager({
        send: backend.send,
        onMessage: backend.onMessage,
        modelStore: fakeModelStore(),
        detectCapability: moonshineCap, requestMicPermission: async () => {},
      });
      await m.enable();
      expect(m.getState().engine).toBe('moonshine');
      expect(m.getState().cloudVendor).toBe(null);
    });
  });
});
