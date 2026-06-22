// @ts-check
// voice transcriber — the offscreen-doc Moonshine wrapper.
//
// Two load-bearing contracts live here, both of which broke real voice
// at least once:
//
//   1. SAME-ORIGIN ASSET REDIRECT. Moonshine ships its ORT runtime +
//      Silero VAD pointing at jsdelivr; under the MV3 extension_pages CSP
//      the cross-origin loader re-wraps the remote script as a blob:,
//      which the CSP blocks — and voice dies silently. init() must
//      repoint Settings.BASE_ASSET_PATH.{ONNX_RUNTIME,SILERO_VAD,MOONSHINE}
//      at same-origin bases before constructing the instance.
//
//   2. THE REAL 0.1.29 CONSTRUCTOR + BYTE DELIVERY. The API is
//      `new MicrophoneTranscriber(modelName, callbacks, useVAD, precision)`
//      — a NAME string first, callbacks second. The pre-vendor placeholder
//      passed an options OBJECT as the name, which stringified into a bad
//      model URL and surfaced as the generic "PlatformUnsupported". And
//      because 0.1.29 has no pre-loaded-bytes API (it always fetches the
//      model by URL), init() installs a scoped fetch shim that serves the
//      two model URLs from peerd's already-loaded bytes.
//
// In-browser because it imports the real moonshine bundle to reach the
// real (mutable) Settings singleton — a mock can't prove the contract.

import { describe, it, expect } from '../../../framework.js';
import { createTranscriber } from '/peerd-runtime/voice/transcriber.js';
import { Settings } from '/vendor/moonshine-js/moonshine.js';

/** @typedef {NonNullable<Parameters<typeof createTranscriber>[0]>} TranscriberDeps */

// why these casts exist: the mock Moonshine class and the fetch-env stub are
// deliberately-minimal stand-ins for the production `typeof MicrophoneTranscriber`
// and `{ fetch: typeof fetch }` surfaces — they exercise only the slice the
// transcriber touches. Cast to the real dep types so drift still bites.
/** @param {new (...a: any[]) => any} c @returns {TranscriberDeps['moonshineClass']} */
const asMoonshineClass = (c) => /** @type {any} */ (c);
/** @param {{ fetch: (...a: any[]) => Promise<Response> }} env @returns {{ fetch: typeof fetch }} */
const asFetchEnv = (env) => /** @type {any} */ (env);

// A Moonshine stand-in: records the constructor argument list
// (name, callbacks, useVAD, precision), exposes those callbacks so a
// test can drive transcription events, and counts speechBuffer.flush()
// calls. No ORT, no audio.
/**
 * @typedef {{
 *   onTranscriptionUpdated: (text: string) => void,
 *   onTranscriptionCommitted: (text: string) => void,
 *   onError: (message: unknown) => void,
 * }} MoonshineCallbacks
 */
const makeMock = () => {
  /** @type {any[][]} */
  const calls = [];
  const flushed = { count: 0 };
  /** @type {MoonshineCallbacks | null} */
  let cbs = null;
  class MockMoonshine {
    /** @param {any[]} args */
    constructor(...args) {
      calls.push(args);
      cbs = args[1] ?? null;
      /** @type {{ flush: () => void }} */
      this.speechBuffer = { flush: () => { flushed.count += 1; } };
    }
    async start() {}
    async stop() {}
    async dispose() {}
  }
  return { MockMoonshine, calls, flushed, getCbs: () => cbs };
};

// A controllable timer so we can drive the silence countdown by hand.
const makeTimer = () => {
  /** @type {{ fn: () => void, ms: number } | null} */
  let scheduled = null;
  return {
    /**
     * @param {() => void} fn
     * @param {number} ms
     */
    setTimer: (fn, ms) => { scheduled = { fn, ms }; return scheduled; },
    /** @param {{ fn: () => void, ms: number } | null} h */
    clearTimer: (h) => { if (scheduled === h) scheduled = null; },
    pending: () => scheduled,
    fire: () => { const s = scheduled; scheduled = null; s?.fn(); },
  };
};

// Let queued microtasks (autoStop's stop().then(...)) settle.
const flush = () => new Promise((r) => globalThis.setTimeout(r, 0));

// Distinct byte lengths so we can prove the shim serves the RIGHT file.
const dummyModel = () => ({
  files: { encoder: new ArrayBuffer(8), decoder: new ArrayBuffer(16), tokenizer: new ArrayBuffer(4) },
});

describe('voice.transcriber', () => {
  it('redirects ORT + VAD + MODEL asset bases to the injected same-origin base on init', async () => {
    const { MockMoonshine } = makeMock();
    /** @type {string[]} */
    const seen = [];
    /** @param {string} p */
    const getAssetUrl = (p) => { seen.push(p); return `ext://abc/${p}`; };
    const fetchEnv = { fetch: async () => new Response(null, { status: 404 }) };
    const t = createTranscriber({ moonshineClass: asMoonshineClass(MockMoonshine), getAssetUrl, fetchEnv: asFetchEnv(fetchEnv) });

    await t.init(dummyModel());

    // All three Moonshine asset bases now point at same-origin copies
    // (not jsdelivr / download.moonshine.ai) — the reason voice loads.
    expect(seen.includes('vendor/onnxruntime-web/')).toBe(true);
    expect(seen.includes('vendor/vad-web/')).toBe(true);
    expect(seen.includes('moonshine-model/')).toBe(true);
    expect(Settings.BASE_ASSET_PATH.ONNX_RUNTIME).toBe('ext://abc/vendor/onnxruntime-web/');
    expect(Settings.BASE_ASSET_PATH.SILERO_VAD).toBe('ext://abc/vendor/vad-web/');
    expect(Settings.BASE_ASSET_PATH.MOONSHINE).toBe('ext://abc/moonshine-model/');
    // And none is a remote CDN URL.
    expect(Settings.BASE_ASSET_PATH.ONNX_RUNTIME.startsWith('http')).toBe(false);
  });

  it('constructs with the real API: model-name string, then callbacks, then useVAD', async () => {
    const { MockMoonshine, calls } = makeMock();
    const fetchEnv = { fetch: async () => new Response(null, { status: 404 }) };
    const t = createTranscriber({ moonshineClass: asMoonshineClass(MockMoonshine), getAssetUrl: (p) => `ext://abc/${p}`, fetchEnv: asFetchEnv(fetchEnv) });

    await t.init(dummyModel());

    expect(calls.length).toBe(1);
    const [name, callbacks, useVAD] = calls[0];
    // First arg is a NAME string — and must contain 'base', which is what
    // MoonshineModel keys its decoder shape off of (vs 'tiny').
    expect(typeof name).toBe('string');
    expect(name.includes('base')).toBe(true);
    // Callbacks are the SECOND arg (silently dropped by the old object form).
    expect(typeof callbacks.onTranscriptionUpdated).toBe('function');
    expect(typeof callbacks.onTranscriptionCommitted).toBe('function');
    expect(typeof callbacks.onError).toBe('function');
    expect(useVAD).toBe(true);
  });

  it('serves Moonshine the cached model bytes via a scoped fetch shim, restored on teardown', async () => {
    const { MockMoonshine } = makeMock();
    const passthrough = new Response('other', { status: 200 });
    /** @type {{ fetch: typeof fetch }} */
    const fetchEnv = asFetchEnv({ fetch: async () => passthrough });
    const original = fetchEnv.fetch;
    const t = createTranscriber({
      moonshineClass: asMoonshineClass(MockMoonshine),
      getAssetUrl: (p) => `ext://abc/${p}`,
      fetchEnv,
    });

    const model = dummyModel();
    await t.init(model);

    // The shim is installed on the INJECTED env, never the real global.
    expect(fetchEnv.fetch !== original).toBe(true);

    // Moonshine's two model URLs resolve to the in-memory bytes (matched
    // by the sentinel marker + filename), and to the RIGHT one each.
    const base = 'ext://abc/moonshine-model/model/base/float';
    const enc = await fetchEnv.fetch(`${base}/encoder_model.onnx`);
    const dec = await fetchEnv.fetch(`${base}/decoder_model_merged.onnx`);
    expect((await enc.arrayBuffer()).byteLength).toBe(model.files.encoder.byteLength);
    expect((await dec.arrayBuffer()).byteLength).toBe(model.files.decoder.byteLength);

    // Everything else (ORT wasm, the VAD worklet, anything) passes through.
    const other = await fetchEnv.fetch('ext://abc/vendor/onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm');
    expect(other === passthrough).toBe(true);

    // Teardown un-patches the env — the shim must not outlive the instance.
    await t.teardown();
    expect(fetchEnv.fetch === original).toBe(true);
  });

  it('rejects init without encoder/decoder bytes (model-store contract)', async () => {
    const { MockMoonshine } = makeMock();
    const t = createTranscriber({ moonshineClass: asMoonshineClass(MockMoonshine), getAssetUrl: (p) => p });
    /** @type {unknown} */
    let threw = null;
    try { await t.init({ files: {} }); } catch (e) { threw = e; }
    expect(threw !== null).toBe(true);
    expect(/** @type {{ name?: string }} */ (threw)?.name).toBe('VoiceUnsupportedError');
  });

  it('resets the silence countdown on EVERY chunk, not just committed ones', async () => {
    // Regression: arming the auto-stop timer on committed chunks only cut
    // a long continuous utterance off mid-sentence. Streaming updates must
    // reset it too — they prove the user is still talking.
    const { MockMoonshine, getCbs } = makeMock();
    const timer = makeTimer();
    const t = createTranscriber({
      moonshineClass: asMoonshineClass(MockMoonshine), getAssetUrl: (p) => `ext://abc/${p}`,
      fetchEnv: asFetchEnv({ fetch: async () => new Response(null, { status: 404 }) }),
      setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    });
    await t.init(dummyModel());
    /** @type {Array<{ text: string, committed: boolean, targetId: string|null }>} */
    const chunks = [];
    await t.listenFor('field-1', (c) => chunks.push(c), () => {});
    const cbs = /** @type {MoonshineCallbacks} */ (getCbs());

    cbs.onTranscriptionUpdated('hello');          // streaming → arms timer
    const first = timer.pending();
    expect(first !== null).toBe(true);
    cbs.onTranscriptionUpdated('hello world');    // streaming → RESETS timer
    expect(timer.pending() !== first).toBe(true);
    expect(chunks.length).toBe(2);
    expect(chunks[1].committed).toBe(false);
  });

  it('auto-stops + notifies the caller after the silence timer fires', async () => {
    const { MockMoonshine, getCbs } = makeMock();
    const timer = makeTimer();
    const t = createTranscriber({
      moonshineClass: asMoonshineClass(MockMoonshine), getAssetUrl: (p) => `ext://abc/${p}`,
      fetchEnv: asFetchEnv({ fetch: async () => new Response(null, { status: 404 }) }),
      setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    });
    await t.init(dummyModel());
    /** @type {{ targetId: string|null } | null} */
    let autoStopped = null;
    await t.listenFor('field-1', () => {}, () => {}, (info) => { autoStopped = info; });

    /** @type {MoonshineCallbacks} */ (getCbs()).onTranscriptionCommitted('hello world.');   // arms the timer
    timer.fire();                                          // silence elapsed
    await flush();

    // The caller is told (so the offscreen can relay voice/auto-stop and
    // the mic button de-highlights), tagged with the field that was live.
    expect(autoStopped !== null).toBe(true);
    // why cast through unknown: TS flow-narrows `autoStopped` to `null` (its
    // only sync assignment); the real value lands via the autoStop callback.
    expect(/** @type {{ targetId: string|null }} */ (/** @type {unknown} */ (autoStopped)).targetId).toBe('field-1');
    expect(t.activeTargetId()).toBe(null);
  });

  it('flushes Moonshine\'s speech buffer on stop (no stale-text leak next listen)', async () => {
    const { MockMoonshine, flushed } = makeMock();
    const t = createTranscriber({
      moonshineClass: asMoonshineClass(MockMoonshine), getAssetUrl: (p) => `ext://abc/${p}`,
      fetchEnv: asFetchEnv({ fetch: async () => new Response(null, { status: 404 }) }),
    });
    await t.init(dummyModel());
    await t.listenFor('field-1', () => {}, () => {});
    expect(flushed.count).toBe(0);
    await t.stop();
    // Uncommitted audio is discarded so the next start() can't commit the
    // tail of this utterance into the next field.
    expect(flushed.count).toBe(1);
  });
});
