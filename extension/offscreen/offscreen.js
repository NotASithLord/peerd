// @ts-check
// Offscreen document entry point.
//
// Responsibilities:
//
//   1. Hold a chrome.runtime.connect port to the SW. As long as any
//      port is open AND ACTIVELY EXCHANGING MESSAGES, the SW won't be
//      terminated by the 30s idle timer. Some Chrome versions appear
//      to treat an idle port as "not actually keeping the SW busy" and
//      kill it anyway — see the heartbeat pattern below.
//
//   2. Host the WebVM (CheerpX) runtime (V1 step 10).
//
//   3. Run the DOM sanitizer (DOMParser-based) when read_page lands.
//
//   4. Host the voice transcriber. Moonshine needs WebGPU + WebAudio
//      which the SW doesn't have. The transcriber is lazily created
//      on the first voice/init message; teardown drops it.

import browser from '/vendor/browser-polyfill.js';
// why /peerd-runtime/index.js (not /voice/index.js): index.js is the
// module's public API; the top-level barrel re-exports createBestTranscriber.
import { createBestTranscriber, createModelStore } from '/peerd-runtime/index.js';
// Headless JS jobs (the js_run tool / engine.runJob): a sealed Worker hosted
// here, no UI. See job-runner.js for its (deliberately seal-only) security note.
import { runJob } from './job-runner.js';
// PDF text extraction (the read_pdf runner tool): pdf.js needs a Worker, which
// the SW can't host. Self-registers a 'pdf/extract' message handler.
import './pdf-extract.js';
import { initLocalModel, generateLocal, localModelStatus, probeWebgpu, teardownLocalModel } from './local-model.js';
import { isTrustedSender } from '/shared/messaging.js';
// The always-on base network (S1b). Self-registers a dweb/base-host/* handler;
// inert on store builds (DWEB_ENABLED false + loadDweb stub). The lobby
// connection lives here so the network outlives any tab.
import './dweb-base.js';
// (WebVM used to be hosted here. As of the discrete-VM rework, each
// WebVM lives in its own browser tab at /vm-tab/index.html and runs
// CheerpX in that tab. The offscreen doc keeps the SW keepalive port
// + the voice transcriber.)

const PORT_NAME = 'sw-keepalive';
const RECONNECT_DELAY_MS = 500;
// Heartbeat interval. Must be < 30s (the SW idle timer) by a comfortable
// margin so we never let the SW idle out between heartbeats. We also
// don't want to spam — 20s is the standard MV3 keepalive cadence.
const HEARTBEAT_MS = 20_000;
// Independent tick log so we can see when this doc itself is alive vs
// dead. The offscreen doc has a different lifecycle than the SW;
// Chrome can terminate it under memory pressure even if the SW lives.
const TICK_MS = 5_000;

console.log('[offscreen] loaded at', new Date().toISOString(), '— UA:', navigator.userAgent);

/** @type {import('webextension-polyfill').Runtime.Port | null} */
let port = null;
/** @type {ReturnType<typeof setInterval> | null} */
let heartbeatTimer = null;

const startHeartbeat = () => {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!port) return;
    try {
      port.postMessage({ type: 'heartbeat', at: Date.now() });
    } catch (e) {
      console.warn('[offscreen] heartbeat post failed', e);
    }
  }, HEARTBEAT_MS);
};

const stopHeartbeat = () => {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
};

const connect = () => {
  try {
    const p = browser.runtime.connect({ name: PORT_NAME });
    port = p;
    console.log('[offscreen] keepalive port connected at', new Date().toISOString());

    // Adding onMessage even though we don't strictly need to consume
    // anything — the act of listening makes the port "fully active"
    // from Chrome's POV. The SW posts an ack back to each heartbeat
    // (see service-worker.js); we log if it comes in.
    p.onMessage.addListener((/** @type {any} */ msg) => {
      if (msg?.type === 'heartbeat-ack') {
        // Silent on the happy path — would be very noisy.
        return;
      }
      console.debug('[offscreen] port msg', msg);
    });

    p.onDisconnect.addListener(() => {
      const err = browser.runtime.lastError;
      console.warn('[offscreen] keepalive port disconnected at',
        new Date().toISOString(),
        err ? `— lastError: ${err.message}` : '');
      port = null;
      stopHeartbeat();
      setTimeout(connect, RECONNECT_DELAY_MS);
    });

    startHeartbeat();
  } catch (e) {
    console.error('[offscreen] connect threw', e);
    setTimeout(connect, RECONNECT_DELAY_MS);
  }
};

// Independent liveness tick — lets us see in the offscreen DevTools
// whether THIS doc is alive across the time the SW is supposed to be
// idling out. If the offscreen also dies, we'll see the tick stop;
// if it stays alive while the SW dies, we know it's strictly an SW
// problem and the offscreen isn't being torn down with it.
setInterval(() => {
  console.log('[offscreen] tick at', new Date().toISOString(),
    port ? '(port connected)' : '(port DISCONNECTED)');
}, TICK_MS);

connect();

// ---------------------------------------------------------------------------
// Voice: lazy-loaded Moonshine transcriber.
//
// The transcriber instance lives in this doc for two reasons:
//   - Moonshine needs WebGPU / WebAudio (SW has neither).
//   - The offscreen survives the SW's 30s idle window.
//
// We answer voice/* one-shot messages from the SW. The side-panel
// flow is: side panel → SW → offscreen. We push transcribed chunks
// the other way (offscreen → SW → all side-panel ports).
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof createBestTranscriber> | null} */
let transcriber = null;

// Lazy model-store for reading the Moonshine bytes the side panel already
// downloaded + SRI-verified + cached. They live in the shared origin IDB
// (same origin as the side panel), so we read them here rather than
// receiving them over the message bridge — chrome.runtime.sendMessage
// JSON-serializes, which silently drops ArrayBuffers on Chrome.
/** @type {ReturnType<typeof createModelStore> | null} */
let voiceModelStore = null;
const getVoiceModelStore = () => (voiceModelStore ??= createModelStore());

// --- mic kill switch (field bug 2026-06-12: macOS mic indicator stayed
// hot after stop). The engines acquire audio internally (the vendored
// Moonshine runs its own getUserMedia), so a wedged engine can strand a
// live MediaStream no stop() of ours reaches. Wrapping getUserMedia in
// THIS document records every audio stream handed to anyone here, and
// releaseMicTracks() force-stops them on voice/stop, voice/teardown,
// engine error, and the no-speech watchdog — the OS indicator must
// never outlive the user's intent. (Web Speech captures inside the
// browser, not this doc — abort() is the only lever there.)
/** @type {Set<MediaStream>} */
const liveMicStreams = new Set();
if (navigator.mediaDevices?.getUserMedia) {
  const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await realGetUserMedia(constraints);
    if (constraints?.audio) liveMicStreams.add(stream);
    return stream;
  };
}
const releaseMicTracks = () => {
  for (const stream of liveMicStreams) {
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch { /* already dead */ }
    }
  }
  liveMicStreams.clear();
};

// No-speech watchdog: if listening produces ZERO chunks for this long,
// stop everything and tell the panel — a recognizer that wedges without
// erroring must fail visibly, not sit silent with the mic burning.
const NO_SPEECH_MS = 15_000;
/** @type {ReturnType<typeof setTimeout> | null} */
let noSpeechTimer = null;
const clearNoSpeechTimer = () => {
  if (noSpeechTimer) { clearTimeout(noSpeechTimer); noSpeechTimer = null; }
};
/** @param {string} [targetId] */
const armNoSpeechTimer = (targetId) => {
  clearNoSpeechTimer();
  noSpeechTimer = setTimeout(async () => {
    console.warn('[offscreen] no speech within', NO_SPEECH_MS, 'ms — releasing mic');
    try { if (transcriber) await transcriber.stop(); } catch { /* best effort */ }
    releaseMicTracks();
    onTranscriberError({
      name: 'VoiceNoSpeechError',
      message: 'Heard nothing — mic released. Click the mic to try again.',
      targetId,
    });
  }, NO_SPEECH_MS);
};

/** @param {any} chunk */
const onTranscriberChunk = (chunk) => {
  // A live chunk proves the pipeline works — push the watchdog out.
  if (noSpeechTimer) armNoSpeechTimer(chunk?.targetId);
  // Push directly via runtime.sendMessage; the SW (and any open side
  // panel port subscribers) receive it. Fire-and-forget — we never
  // block the audio pipeline on consumer ack.
  browser.runtime.sendMessage({ type: 'voice/chunk', payload: chunk })
    .catch((e) => console.debug('[offscreen] voice/chunk send failed', e));
};

/** @param {any} err */
const onTranscriberError = (err) => {
  // why: the recognizer just gave up mid-listen (permission denied,
  // mic disconnected, network gone, etc.). Tell the side panel so the
  // manager can revert status and surface a clear error. The error
  // shape is { name, message, code?, targetId } — name is the typed
  // class so the UI can branch. An erroring engine forfeits the mic:
  // clear the watchdog and force-release any stranded tracks.
  clearNoSpeechTimer();
  releaseMicTracks();
  browser.runtime.sendMessage({ type: 'voice/error', payload: err })
    .catch((e) => console.debug('[offscreen] voice/error send failed', e));
};

/** @param {{ targetId?: string | null }} [arg] */
const onTranscriberAutoStop = ({ targetId } = {}) => {
  // why: the transcriber's silence timer fired (end of speech) and
  // stopped the mic on its own. The side panel doesn't know — it only
  // learns of stops it initiated — so its mic button would stay lit.
  // Release the mic and push voice/auto-stop so the manager reverts to
  // 'available' and the button de-highlights. (The whole receive chain
  // SW → side panel → manager already existed; nothing ever SENT it.)
  clearNoSpeechTimer();
  releaseMicTracks();
  browser.runtime.sendMessage({ type: 'voice/auto-stop', payload: { targetId } })
    .catch((e) => console.debug('[offscreen] voice/auto-stop send failed', e));
};

// why the cast at addListener: the polyfill's OnMessageListenerCallback types
// the return as the literal `true`, so a handler that also `return undefined`s
// to decline a message can't satisfy it. The body stays fully typed.
/**
 * @param {any} msg
 * @param {import('webextension-polyfill').Runtime.MessageSender} _sender
 * @param {(response: any) => void} sendResponse
 */
const onVoiceMessage = (msg, _sender, sendResponse) => {
  if (!msg?.type?.startsWith?.('voice/')) return undefined;
  (async () => {
    try {
      switch (msg.type) {
        case 'voice/init': {
          if (!transcriber) transcriber = createBestTranscriber({}, msg.engine);
          // why: Moonshine needs model bytes; Web Speech doesn't. The
          // bytes can't ride the message (sendMessage drops ArrayBuffers
          // on Chrome), so we read them from the shared origin IDB the
          // side panel just populated — a cache hit, no re-download.
          if (transcriber.engine === 'moonshine') {
            const { files } = await getVoiceModelStore().getModel(msg.variant, { dev: true });
            await transcriber.init({ files });
          } else {
            await transcriber.init();
          }
          sendResponse({ ok: true, engine: transcriber.engine });
          return;
        }
        case 'voice/listen': {
          if (!transcriber) {
            sendResponse({ ok: false, error: 'not-initialized' });
            return;
          }
          await transcriber.listenFor(msg.targetId, onTranscriberChunk, onTranscriberError, onTranscriberAutoStop);
          armNoSpeechTimer(msg.targetId);
          sendResponse({ ok: true });
          return;
        }
        case 'voice/stop': {
          clearNoSpeechTimer();
          if (transcriber) await transcriber.stop();
          // Belt-and-suspenders: the user said stop — no engine state
          // may keep the OS mic indicator lit past this line.
          releaseMicTracks();
          sendResponse({ ok: true });
          return;
        }
        case 'voice/silence': {
          if (transcriber) transcriber.setSilenceThreshold(msg.ms);
          sendResponse({ ok: true });
          return;
        }
        case 'voice/teardown': {
          clearNoSpeechTimer();
          if (transcriber) {
            await transcriber.teardown();
            transcriber = null;
          }
          releaseMicTracks();
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: `unknown-voice-msg:${msg.type}` });
          return;
      }
    } catch (e) {
      console.error('[offscreen] voice handler threw', msg.type, e);
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      sendResponse({ ok: false, error: err?.name === 'TypedError' || err?.name
        ? err.name : (err?.message ?? String(e)) });
    }
  })();
  return true;     // async sendResponse contract
};
browser.runtime.onMessage.addListener(/** @type {any} */ (onVoiceMessage));

// --- headless JS jobs (js_run tool → engine.runJob) ---
// Spawns the sealed Worker here and relays its egress/subagent bridges back to
// the SW's audited routes. A separate listener so voice is untouched.
/**
 * @param {any} msg
 * @param {import('webextension-polyfill').Runtime.MessageSender} sender
 * @param {(response: any) => void} sendResponse
 */
const onJobMessage = (msg, sender, sendResponse) => {
  if (msg?.type !== 'job/run') return undefined;
  // Fail closed for any non-first-party sender — this runs arbitrary code, so it
  // must match the SW dispatcher's posture (sender-trust.js). externally_connectable
  // is unset today, so this is defense-in-depth, not an active hole.
  if (!isTrustedSender(sender)) { sendResponse({ ok: false, error: 'untrusted-sender' }); return true; }
  runJob(
    { code: msg.code, timeoutMs: msg.timeoutMs },
    { sendToSW: (type, payload) => browser.runtime.sendMessage({ type, ...payload }) },
  )
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) }));
  return true;     // async sendResponse contract
};
browser.runtime.onMessage.addListener(/** @type {any} */ (onJobMessage));

// Local WebGPU inference (FEATURE-LOCAL-WEBGPU B). The SW's local-webgpu adapter
// drives this: status/probe/init/teardown are request→response; generate STREAMS
// tokens back as local-model/delta messages (the SW collects them into the
// adapter's async-generator) and ends with local-model/done.
// `local-model/host/*` are the SW→offscreen COMMANDS (distinct from the SW's own
// dispatcher routes so the harness's local-model/status hits the SW, not also
// here). Pushes BACK to the SW use local-model/delta|done|progress.
/**
 * @param {any} msg
 * @param {import('webextension-polyfill').Runtime.MessageSender} sender
 * @param {(response: any) => void} sendResponse
 */
const onLocalModelMessage = (msg, sender, sendResponse) => {
  if (typeof msg?.type !== 'string' || !msg.type.startsWith('local-model/host/')) return undefined;
  if (!isTrustedSender(sender)) { sendResponse({ ok: false, error: 'untrusted-sender' }); return true; }
  (async () => {
    switch (msg.type) {
      case 'local-model/host/status':
        sendResponse({ ok: true, ...(await localModelStatus()) });
        return;
      case 'local-model/host/probe':
        // probeWebgpu always carries its own `ok` (true/false) — spread it as-is.
        sendResponse(await probeWebgpu());
        return;
      case 'local-model/host/init':
        // Kick off the (minutes-long, ONE-TIME) load fire-and-forget — progress
        // streams via local-model/progress, status reflects completion. Respond
        // immediately so the SW route doesn't block for the whole download; the
        // caller polls local-model/status.
        initLocalModel((p) => { try { browser.runtime.sendMessage({ type: 'local-model/progress', progress: p }); } catch { /* SW asleep */ } })
          .catch((e) => { try { browser.runtime.sendMessage({ type: 'local-model/progress', progress: { status: 'error', message: /** @type {{ message?: string }} */ (e)?.message ?? String(e) } }); } catch { /* SW asleep */ } });
        sendResponse({ ok: true, started: true, ...(await localModelStatus()) });
        return;
      case 'local-model/host/teardown':
        await teardownLocalModel();
        sendResponse({ ok: true });
        return;
      case 'local-model/host/generate': {
        const { genId } = msg;
        try {
          await generateLocal(msg, (token) => { try { browser.runtime.sendMessage({ type: 'local-model/delta', genId, token }); } catch { /* SW asleep */ } });
          try { browser.runtime.sendMessage({ type: 'local-model/done', genId }); } catch { /* SW asleep */ }
        } catch (e) {
          try { browser.runtime.sendMessage({ type: 'local-model/done', genId, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) }); } catch { /* SW asleep */ }
        }
        sendResponse({ ok: true });
        return;
      }
      default:
        sendResponse({ ok: false, error: `unknown local-model message: ${msg.type}` });
    }
  })().catch((e) => { try { sendResponse({ ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) }); } catch { /* response gone */ } });
  return true; // async sendResponse contract
};
browser.runtime.onMessage.addListener(/** @type {any} */ (onLocalModelMessage));
