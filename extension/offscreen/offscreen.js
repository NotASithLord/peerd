// @ts-check
// Offscreen document entry point.
//
// Responsibilities:
//
//   1. Execute exact controller/dweb/DOM/media feature leases. With no lease
//      this document has no runtime Port, heartbeat, network, microphone, or
//      heavyweight feature graph.
//
//   2. Run DOM-dependent parsing and sealed jobs on bounded demand.
//
//   3. Host the voice transcriber. Moonshine needs WebGPU + WebAudio
//      which the SW doesn't have. The transcriber is lazily created
//      on the first voice/init message; teardown drops it.

import browser from '/shared/browser-api.js';
import { CONTROLLER_BUILD_DIGEST, EXTENSION_VERSION } from '/shared/build-config.js';
import {
  createOffscreenFeatureLeaseHost,
} from './feature-lease-host.js';
import {
  FEATURE_LEASE_HOST_PROTOCOL,
  FEATURE_LEASE_KEEPALIVE_PORT,
} from '/shared/feature-lease-protocol.js';
// PDF text extraction (the read_pdf runner tool): pdf.js needs a Worker, which
// the SW can't host. Self-registers a 'pdf/extract' message handler.
// Office/publishing document conversion (the read_doc tool): Word, Excel,
// PowerPoint, OpenDocument, RTF, EPUB, CSV -> Markdown. Self-registers a
// 'doc/extract' message handler. Offscreen for the same reason as the PDF
// reader: the untrusted bytes (tens of MB) never enter the SW.
// HTML -> markdown extraction (fetch_url's clean-content path): Readability +
// Turndown need a DOM Document, which the SW can't build. The shell
// self-registers a 'web/extract' message handler; the headless job runner's
// fetch bridge reaches the pipeline DIRECTLY through the core's adapter
// (same document — no route needed).
import {
  isServiceWorkerSender, isTrustedSender, registerServiceWorkerChannels,
} from './supervisor-channels.js';
// The base network is operation-lazy: Store never loads it, while Preview
// starts it only after the service worker acquires the deliberate dweb lease.
// Once started it remains in this offscreen document so discovery, seeding and
// App rooms outlive any single tab. The loader is not the lease; the host's
// explicit start/stop routes retain that lifecycle contract.
// (WebVM used to be hosted here. As of the discrete-VM rework, each WebVM
// lives in its own browser tab.)

console.log('[offscreen] loaded at', new Date().toISOString(), '— UA:', navigator.userAgent);

/** @type {ReturnType<typeof createOffscreenFeatureLeaseHost> | null} */
let featureLeaseHost = null;
/** @type {Promise<typeof import('./controller-bootstrap.js')> | null} */
let controllerBootstrapPromise = null;
const loadControllerBootstrap = () => (controllerBootstrapPromise ??= import('./controller-bootstrap.js')
  .catch((cause) => { controllerBootstrapPromise = null; throw cause; }));
/** @type {Promise<typeof import('./repository-host.js')> | null} */
let repositoryHostPromise = null;
const loadRepositoryHost = () => (repositoryHostPromise ??= import('./repository-host.js')
  .catch((cause) => { repositoryHostPromise = null; throw cause; }));
/** @type {Promise<typeof import('./dweb-base.js')> | null} */
let dwebHostPromise = null;
const loadDwebHost = () => (dwebHostPromise ??= import('./dweb-base.js')
  .catch((cause) => { dwebHostPromise = null; throw cause; }));
const rejectWithoutLease = (/** @type {string} */ scope,
  /** @type {(value:any)=>void} */ sendResponse) => {
  const refusal = featureLeaseHost
    ? featureLeaseHost.requireActive(scope)
    : { ok: false, error: 'feature-lease-host-not-ready', scope };
  if (!refusal) return false;
  sendResponse(refusal);
  return true;
};

const { actorPorts, vaultAuthorityWorkers } = registerServiceWorkerChannels({
  getFeatureLeaseHost: () => featureLeaseHost,
  loadControllerBootstrap,
  loadRepositoryHost,
});

// Preview dweb coordinator. Do not put the network graph in this document's
// static imports: Store has no dweb, and Preview must not make first-run vault
// enrollment wait for WebRTC/gossip code. The service worker's explicit
// dweb/base-host/start call is the on-demand lease boundary. Exact sender
// provenance is checked here before loading and again by the feature host.
browser.runtime.onMessage.addListener(/** @type {any} */ ((
  /** @type {any} */ msg,
  /** @type {any} */ sender,
  /** @type {(value:any)=>void} */ sendResponse,
) => {
  if (typeof msg?.type !== 'string' || !msg.type.startsWith('dweb/base-host/')) return false;
  if (!isServiceWorkerSender(sender)) {
    sendResponse({ ok: false, error: 'unauthorized-command-sender' });
    return false;
  }
  if (rejectWithoutLease('dweb', sendResponse)) return false;
  loadDwebHost()
    .then(({ handleDwebBaseMessage }) => {
      const handled = handleDwebBaseMessage(msg, sender, sendResponse);
      if (handled !== true) sendResponse({ ok: false, error: 'unknown-dweb-host-message' });
    }, (cause) => sendResponse({
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    }));
  return true;
}));

// Heavy untrusted parsers load only after the exact trusted request arrives.
// This central listener owns sender authority; the feature modules export pure
// handlers and carry no independent runtime-message surface.
/** @typedef {(message: any) => Promise<any>} ExtractionHandler */
/** @type {Readonly<Record<string, () => Promise<ExtractionHandler>>>} */
const extractionLoaders = Object.freeze({
  'pdf/extract': async () => /** @type {ExtractionHandler} */ (
    (await import('./pdf-extract.js')).handlePdfExtract
  ),
  'doc/extract': async () => /** @type {ExtractionHandler} */ (
    (await import('./doc-extract.js')).handleDocExtract
  ),
  'web/extract': async () => /** @type {ExtractionHandler} */ (
    (await import('./web-extract.js')).handleWebExtract
  ),
});
browser.runtime.onMessage.addListener(/** @type {any} */ ((
  /** @type {any} */ msg,
  /** @type {any} */ sender,
  /** @type {(value:any)=>void} */ sendResponse,
) => {
  const load = extractionLoaders[/** @type {keyof typeof extractionLoaders} */ (msg?.type)];
  if (!load) return false;
  if (!isTrustedSender(sender)) {
    sendResponse({ ok: false, error: 'untrusted-sender' });
    return false;
  }
  if (rejectWithoutLease('dom-host', sendResponse)) return false;
  load().then((handle) => handle(msg)).then(sendResponse, (cause) => sendResponse({
    ok: false,
    error: cause?.name ? `${cause.name}: ${cause.message}` : (cause?.message ?? String(cause)),
  }));
  return true;
}));

// Toolbox parsing is an operation-lazy Acorn/resolver feature. The loader owns
// the exact SW sender check so the rich parser module never needs a cold
// listener or authority of its own.
browser.runtime.onMessage.addListener(/** @type {any} */ ((
  /** @type {any} */ msg,
  /** @type {any} */ sender,
  /** @type {(value:any)=>void} */ sendResponse,
) => {
  if (msg?.type !== 'toolbox/parse-check') return false;
  if (!isServiceWorkerSender(sender)) {
    sendResponse({ ok: false, error: 'unauthorized-command-sender' });
    return false;
  }
  if (rejectWithoutLease('dom-host', sendResponse)) return false;
  import('./toolbox-parse.js')
    .then(({ handleToolboxParseCheck }) => handleToolboxParseCheck(msg))
    .then(sendResponse, (cause) => sendResponse({
      ok: false, error: cause instanceof Error ? cause.message : String(cause),
    }));
  return true;
}));

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

/** @type {ReturnType<import('/peerd-runtime/voice/transcriber-picker.js').createBestTranscriber> | null} */
let transcriber = null;
/** @type {Promise<typeof import('/peerd-voice-host/index.js')> | null} */
let voiceHostPromise = null;
const loadVoiceHost = () => (voiceHostPromise ??= import('/peerd-voice-host/index.js'));

// Lazy model-store for reading the Moonshine bytes the side panel already
// downloaded + SRI-verified + cached. They live in the shared origin IDB
// (same origin as the side panel), so we read them here rather than
// receiving them over the message bridge — chrome.runtime.sendMessage
// JSON-serializes, which silently drops ArrayBuffers on Chrome.
/** @type {Promise<ReturnType<typeof import('/peerd-runtime/offscreen.js').createModelStore>> | null} */
let voiceModelStore = null;
const getVoiceModelStore = () => (voiceModelStore ??= import('/peerd-runtime/offscreen.js')
  .then(({ createModelStore }) => createModelStore()));

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
 * @param {import('webextension-polyfill').Runtime.MessageSender} sender
 * @param {(response: any) => void} sendResponse
 */
const onVoiceMessage = (msg, sender, sendResponse) => {
  if (!msg?.type?.startsWith?.('voice/')) return undefined;
  // Side panel/options originate these commands, but the service worker owns
  // the media lease and forwards the same command after acquisition. Decline
  // the original page message without responding so it cannot race the
  // authority response; accept only the worker-forwarded copy.
  if (!isServiceWorkerSender(sender)) return undefined;
  if (rejectWithoutLease('media-host', sendResponse)) return true;
  (async () => {
    try {
      switch (msg.type) {
        case 'voice/init': {
          let activeTranscriber = transcriber;
          if (!activeTranscriber) {
            const { createBestTranscriber } = await loadVoiceHost();
            activeTranscriber = createBestTranscriber({}, msg.engine);
            transcriber = activeTranscriber;
          }
          // why: Moonshine needs model bytes; Web Speech doesn't. The
          // bytes can't ride the message (sendMessage drops ArrayBuffers
          // on Chrome), so we read them from the shared origin IDB the
          // side panel just populated — a cache hit, no re-download.
          if (activeTranscriber.engine === 'moonshine') {
            const { files } = await (await getVoiceModelStore()).getModel(msg.variant, { dev: true });
            await activeTranscriber.init({ files });
          } else {
            await activeTranscriber.init();
          }
          sendResponse({ ok: true, engine: activeTranscriber.engine });
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

// --- headless JS jobs (script tool → engine.runJob) ---
// Spawns the sealed Worker here and relays its egress/actor bridges back to
// the SW's audited routes. A separate listener so voice is untouched.
/** @type {Promise<{
 * runJob: typeof import('./job-runner.js').runJob,
 * abortJob: typeof import('./job-runner.js').abortJob,
 * abortAllJobs: typeof import('./job-runner.js').abortAllJobs,
 * extractMarkdownLocal: typeof import('./web-extract-core.js').extractMarkdownLocal,
 * }> | null} */
let jobHostPromise = null;
const loadJobHost = () => (jobHostPromise ??= Promise.all([
  import('./job-runner.js'), import('./web-extract-core.js'),
]).then(([jobs, web]) => ({
  runJob: jobs.runJob, abortJob: jobs.abortJob, abortAllJobs: jobs.abortAllJobs,
  extractMarkdownLocal: web.extractMarkdownLocal,
})));
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
  if (!isServiceWorkerSender(sender)) { sendResponse({ ok: false, error: 'unauthorized-command-sender' }); return true; }
  if (rejectWithoutLease('dom-host', sendResponse)) return true;
  loadJobHost().then(({ runJob, extractMarkdownLocal }) => runJob({
      code: msg.code, timeoutMs: msg.timeoutMs, startedAt: msg.startedAt, deadlineAt: msg.deadlineAt,
      a2a: msg.a2a === true, actors: msg.actors === true,
      // DESIGN-19: the pinned origin for a site-client run (trusted job param, SW-set).
      siteFetch: typeof msg.siteFetch === 'string' ? msg.siteFetch : '',
      // design 06: may this job resolve peerd:toolbox modules (script lane only;
      // trusted job param — job-runner still refuses it for a2a/site-client runs).
      toolbox: msg.toolbox === true,
      // caps + ownerSessionId ride from the SW's job/run message (trusted: the
      // sender gate above). The WORKER never supplies either — job-runner
      // attaches them from these params and ignores anything in the worker's
      // own messages.
      caps: msg.caps,
      ownerSessionId: msg.ownerSessionId, ownerToolUseId: msg.ownerToolUseId, runId: msg.runId,
      // The durable-workspace mount (trusted job param, SW-set — the sender
      // gate above is what makes it trustworthy; _runJob validates the shape).
      workspaceSessionId: msg.workspaceSessionId,
    }, {
      sendToSW: (type, payload) => browser.runtime.sendMessage({ type, ...payload }),
      // Run settlement is a control signal, separate from the capability relay
      // lane: the SW aborts pending confirmations/tool work before job-runner
      // releases that lane for reuse.
      abortRun: (runId, ownerSessionId) => browser.runtime.sendMessage({
        type: 'script-run/abort', runId, ownerSessionId,
      }),
      // The bridged fetch's extract:'markdown' post-step — the local pipeline
      // adapter (see shared/fetch-extract.js for the why + posture).
      extractMarkdown: extractMarkdownLocal,
    }))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) }));
  return true;     // async sendResponse contract
};
browser.runtime.onMessage.addListener(/** @type {any} */ (onJobMessage));

// Stop plumbing for a runId-carrying headless job (the actors-enabled script
// path): terminate the worker so an aborted turn doesn't leave a script
// running to its wall-clock. Sync response — abortJob is fire-and-forget.
/**
 * @param {any} msg
 * @param {import('webextension-polyfill').Runtime.MessageSender} sender
 * @param {(response: any) => void} sendResponse
 */
const onJobAbort = (msg, sender, sendResponse) => {
  if (msg?.type !== 'job/abort') return undefined;
  if (!isServiceWorkerSender(sender)) { sendResponse({ ok: false, error: 'unauthorized-command-sender' }); return true; }
  if (rejectWithoutLease('dom-host', sendResponse)) return true;
  if (typeof msg.runId !== 'string' || !msg.runId) {
    sendResponse({ ok: true });
    return true;
  }
  loadJobHost().then(({ abortJob }) => {
    abortJob(msg.runId, typeof msg.ownerSessionId === 'string' ? msg.ownerSessionId : undefined);
    sendResponse({ ok: true });
  }, (cause) => sendResponse({
    ok: false, error: cause instanceof Error ? cause.message : String(cause),
  }));
  return true;
};
browser.runtime.onMessage.addListener(/** @type {any} */ (onJobAbort));

// Local WebGPU inference (FEATURE-LOCAL-WEBGPU B). The SW's local-webgpu adapter
// drives this: status/probe/init/teardown are request→response; generate STREAMS
// tokens back as local-model/delta messages (the SW collects them into the
// adapter's async-generator) and ends with local-model/done.
// `local-model/host/*` are the SW→offscreen COMMANDS (distinct from the SW's own
// dispatcher routes so the harness's local-model/status hits the SW, not also
// here). Pushes BACK to the SW use local-model/delta|done|progress.

// Live per-generation abort handles, keyed by the SW's genId (see the
// generate + abort handlers below).
/** @type {Map<string, AbortController>} */
const localGenerationControllers = new Map();
/** @type {Promise<typeof import('./local-model.js')> | null} */
let localModelHostPromise = null;
const loadLocalModelHost = () => (localModelHostPromise ??= import('./local-model.js'));

/**
 * @param {any} msg
 * @param {import('webextension-polyfill').Runtime.MessageSender} sender
 * @param {(response: any) => void} sendResponse
 */
const onLocalModelMessage = (msg, sender, sendResponse) => {
  if (typeof msg?.type !== 'string' || !msg.type.startsWith('local-model/host/')) return undefined;
  if (!isServiceWorkerSender(sender)) { sendResponse({ ok: false, error: 'unauthorized-command-sender' }); return true; }
  if (rejectWithoutLease('model-host', sendResponse)) return true;
  (async () => {
    const local = await loadLocalModelHost();
    switch (msg.type) {
      case 'local-model/host/status':
        // The status reply carries its own ok (false for an unknown model id).
        sendResponse(await local.localModelStatus({ model: msg.model, includeSupport: !!msg.includeSupport }));
        return;
      case 'local-model/host/catalog':
        // Every shipped model in one round-trip - what the Settings cards render.
        sendResponse(await local.localModelCatalog({ includeSupport: msg.includeSupport !== false }));
        return;
      case 'local-model/host/probe':
        // probeWebgpu always carries its own `ok` (true/false) — spread it as-is.
        sendResponse(await local.probeWebgpu());
        return;
      case 'local-model/host/init': {
        // Kick off the (minutes-long, ONE-TIME) load fire-and-forget — progress
        // streams via local-model/progress, status reflects completion. Respond
        // immediately so the SW route doesn't block for the whole download; the
        // caller polls local-model/status.
        // why the pre-flight await: an unknown id / unsupported architecture /
        // a load already in flight for another model must come back as a REFUSAL
        // on this response, not as a progress event the caller may never see.
        const pre = await local.localModelStatus({ model: msg.model, includeSupport: true });
        if (!pre.ok) { sendResponse(pre); return; }
        // Only a DEFINITE 'unsupported' blocks the download. 'unknown' means we
        // could not read the model's config, which is a reason to try and report
        // honestly, not to refuse on a guess.
        if (pre.supportState === 'unsupported') {
          sendResponse({ ok: false, error: pre.supportReason, model: pre.model, supportState: 'unsupported' });
          return;
        }
        const busy = local.loadingModelId();
        if (busy && busy !== pre.model) {
          sendResponse({ ok: false, error: `another model is still downloading (${busy}) - wait for it to finish first.`, model: pre.model });
          return;
        }
        local.initLocalModel({ model: pre.model }, (p) => { try { browser.runtime.sendMessage({ type: 'local-model/progress', progress: p }); } catch { /* SW asleep */ } })
          .catch((e) => {
            try { browser.runtime.sendMessage({ type: 'local-model/progress', progress: { status: 'error', message: /** @type {{ message?: string }} */ (e)?.message ?? String(e), model: pre.model } }); } catch { /* SW asleep */ }
          });
        sendResponse({ ...(await local.localModelStatus({ model: pre.model })), started: true });
        return;
      }
      case 'local-model/host/teardown':
        // Never destroy the GPU device under a live stream - the caller can
        // retry once the turn settles.
        if (local.generationInFlight()) {
          sendResponse({ ok: false, error: 'a local generation is in progress - stop it first.' });
          return;
        }
        await local.teardownLocalModel();
        sendResponse({ ok: true });
        return;
      case 'local-model/host/generate': {
        const { genId } = msg;
        // Per-generation abort handle: the SW's abort route (below) ends this
        // run early so the engine's generation lease is released instead of
        // running out a multi-thousand-token budget after the user hit Stop.
        const controller = new AbortController();
        if (typeof genId === 'string') localGenerationControllers.set(genId, controller);
        try {
          await local.generateLocal(msg, (token) => { try { browser.runtime.sendMessage({ type: 'local-model/delta', genId, token }); } catch { /* SW asleep */ } }, { signal: controller.signal });
          try { browser.runtime.sendMessage({ type: 'local-model/done', genId }); } catch { /* SW asleep */ }
        } catch (e) {
          try { browser.runtime.sendMessage({ type: 'local-model/done', genId, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) }); } catch { /* SW asleep */ }
        } finally {
          if (typeof genId === 'string') localGenerationControllers.delete(genId);
        }
        sendResponse({ ok: true });
        return;
      }
      case 'local-model/host/abort':
        // Idempotent: aborting a settled/unknown genId is a no-op.
        localGenerationControllers.get(msg.genId)?.abort();
        sendResponse({ ok: true });
        return;
      default:
        sendResponse({ ok: false, error: `unknown local-model message: ${msg.type}` });
    }
  })().catch((e) => { try { sendResponse({ ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) }); } catch { /* response gone */ } });
  return true; // async sendResponse contract
};
browser.runtime.onMessage.addListener(/** @type {any} */ (onLocalModelMessage));

const stopControllerFeature = async () => {
  for (const actorPort of actorPorts) {
    try { actorPort.close(); } catch { /* already closed */ }
  }
  actorPorts.clear();
  if (repositoryHostPromise) {
    try { (await repositoryHostPromise).abortRepositoryHostCalls(); }
    catch { repositoryHostPromise = null; }
  }
  if (controllerBootstrapPromise) {
    try {
      const bootstrap = /** @type {any} */ (await controllerBootstrapPromise);
      bootstrap.retireControllerHost?.();
    } catch { controllerBootstrapPromise = null; }
  }
  return { stopped: true };
};

const stopModelFeature = async () => {
  for (const controller of localGenerationControllers.values()) controller.abort();
  localGenerationControllers.clear();
  if (localModelHostPromise) {
    try { await (await localModelHostPromise).teardownLocalModel(); }
    catch { /* a broken model host still loses its lease */ }
  }
  return { stopped: true };
};

const stopDomFeature = async () => {
  const aborted = jobHostPromise ? (await jobHostPromise).abortAllJobs() : 0;
  return { stopped: true, aborted };
};

const stopMediaFeature = async () => {
  clearNoSpeechTimer();
  try {
    if (transcriber) {
      await transcriber.teardown();
      transcriber = null;
    }
  } finally {
    // A broken engine is never allowed to retain OS microphone custody.
    releaseMicTracks();
  }
  return { stopped: true };
};

const stopVaultAuthorityFeature = async () => {
  const workers = [...vaultAuthorityWorkers];
  vaultAuthorityWorkers.clear();
  for (const worker of workers) {
    try { worker.terminate(); } catch { /* already stopped */ }
  }
  return { stopped: true, workers: workers.length };
};

const OFFSCREEN_BUILD_ID = `${EXTENSION_VERSION}:${CONTROLLER_BUILD_DIGEST}`;
featureLeaseHost = createOffscreenFeatureLeaseHost({
  expectedBuildId: OFFSCREEN_BUILD_ID,
  connectPort: () => browser.runtime.connect({ name: FEATURE_LEASE_KEEPALIVE_PORT }),
  startScope: async (scope, lease) => {
    if (scope === 'dweb') return (await loadDwebHost()).startDwebFeatureLease(lease);
    return { ready: true, scope };
  },
  adoptScope: async (scope, _prior, lease) => {
    if (scope === 'dweb') return (await loadDwebHost()).adoptDwebFeatureLease(lease);
    return { adopted: true, scope };
  },
  stopScope: async (scope) => {
    if (scope === 'dweb') return (await loadDwebHost()).stopDwebFeatureLease();
    if (scope === 'controller') return stopControllerFeature();
    if (scope === 'model-host') return stopModelFeature();
    if (scope === 'dom-host') return stopDomFeature();
    if (scope === 'media-host') return stopMediaFeature();
    if (scope === 'vault-authority') return stopVaultAuthorityFeature();
    throw new Error('feature-lease-scope-invalid');
  },
});

// This is the only runtime-message lifecycle authority in the document. The
// ordinary feature handlers above merely consume already-active leases.
browser.runtime.onMessage.addListener(/** @type {any} */ ((
  /** @type {any} */ message,
  /** @type {any} */ sender,
  /** @type {(value:any)=>void} */ sendResponse,
) => {
  if (typeof message?.type !== 'string'
      || !message.type.startsWith('feature-lease/host-')) return false;
  if (!isServiceWorkerSender(sender)) {
    sendResponse({
      ok: false,
      protocol: FEATURE_LEASE_HOST_PROTOCOL,
      error: 'feature-lease-host-sender-invalid',
    });
    return false;
  }
  featureLeaseHost.handleMessage(message).then(sendResponse, (cause) => sendResponse({
    ok: false,
    protocol: FEATURE_LEASE_HOST_PROTOCOL,
    error: cause instanceof Error ? cause.message : String(cause),
  }));
  return true;
}));

globalThis.addEventListener('pagehide', () => { void featureLeaseHost?.close(); }, { once: true });
