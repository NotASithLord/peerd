// @ts-check

import browser from '/shared/browser-api.js';
import { CHANNEL, CONTROLLER_BUILD_DIGEST, EXTENSION_VERSION } from '/shared/build-config.js';
import {
  FEATURE_LEASE_HOST_PROTOCOL,
  FEATURE_LEASE_KEEPALIVE_PORT,
} from '/shared/feature-lease-protocol.js';
import { makeBoundedModuleLoader } from '/shared/bounded-module-load.js';
import { isServiceWorkerSender } from './sender-checks.js';

/** @type {ReturnType<typeof import('./feature-lease-host.js').createOffscreenFeatureLeaseHost> | null} */
let featureLeaseHost = null;
/** @type {typeof import('./controller-bootstrap.js')|null} */
let controllerBootstrap = null;
const loadControllerBootstrap = makeBoundedModuleLoader(
  () => import('./controller-bootstrap.js').then((module) => (controllerBootstrap = module)),
  { loadCode: 'controller-host-load-failed', timeoutCode: 'controller-host-load-timeout' },
);
/** @type {typeof import('./repository-host.js')|null} */
let repositoryHost = null;
const loadRepositoryHost = makeBoundedModuleLoader(
  () => import('./repository-host.js').then((module) => (repositoryHost = module)),
  { loadCode: 'repository-host-load-failed', timeoutCode: 'repository-host-load-timeout' },
);
/** @type {typeof import('./voice-channel-host.js')|null} */
let voiceChannelHost = null;
const loadVoiceChannelHost = makeBoundedModuleLoader(
  () => import('./voice-channel-host.js').then((module) => (voiceChannelHost = module)),
  { loadCode: 'voice-host-load-failed', timeoutCode: 'voice-host-load-timeout' },
);
const loadDwebHost = makeBoundedModuleLoader(
  () => import('./dweb-base.js'),
  { loadCode: 'dweb-host-load-failed', timeoutCode: 'dweb-host-load-timeout' },
);
const errorResponse = (/** @type {any} */ cause) => cause?.phase === 'startup'
  ? {
    ok: false, code: cause.code, error: 'Feature unavailable. Try again.',
    outcomeKnown: true, retryable: true, phase: 'startup',
  }
  : {
    ok: false,
    error: cause?.name ? `${cause.name}: ${cause.message}` : (cause?.message ?? String(cause)),
  };
const claimLease = (/** @type {string} */ scope,
  /** @type {(value:any)=>void} */ sendResponse) => {
  const lease = featureLeaseHost?.activeLease(scope) ?? null;
  if (lease) return lease;
  sendResponse(featureLeaseHost?.requireActive(scope)
    ?? { ok: false, error: 'feature-lease-host-not-ready', scope });
  return null;
};
const rejectStaleClaim = (/** @type {string} */ scope, /** @type {unknown} */ lease,
  /** @type {(value:any)=>void} */ sendResponse) => {
  if (featureLeaseHost?.ownsLease(scope, lease) === true) return false;
  sendResponse(featureLeaseHost?.requireActive(scope)
    ?? { ok: false, error: 'feature-lease-required', scope });
  return true;
};

/** @type {Set<MessagePort>} */
const actorPorts = new Set();
/** @type {Set<Worker>} */
const vaultAuthorityWorkers = new Set();
const loadServiceWorkerChannels = makeBoundedModuleLoader(
  () => Promise.all([
    import('./supervisor-channels.js'),
    String(CHANNEL) === 'store' ? Promise.resolve({ contributorChannelAddon: {} })
      : import('./contributor-channel-addon.js'),
  ]).then(([{ createServiceWorkerChannels }, { contributorChannelAddon }]) => (
    createServiceWorkerChannels({
      getFeatureLeaseHost: () => featureLeaseHost,
      loadControllerBootstrap,
      loadRepositoryHost,
      loadVoiceHost: loadVoiceChannelHost,
      ...contributorChannelAddon,
      actorPorts,
      vaultAuthorityWorkers,
    }).onMessage
  )),
  {
    loadCode: 'offscreen-channel-host-load-failed',
    timeoutCode: 'offscreen-channel-host-load-timeout',
  },
);
navigator.serviceWorker?.addEventListener('message', (event) => {
  loadServiceWorkerChannels().then(
    (onMessage) => onMessage(event),
    () => { for (const port of event.ports ?? []) try { port.close(); } catch {} },
  );
});
navigator.serviceWorker?.startMessages?.();

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
  const claim = claimLease('dweb', sendResponse);
  if (!claim) return false;
  loadDwebHost()
    .then(({ handleDwebBaseMessage }) => {
      if (rejectStaleClaim('dweb', claim, sendResponse)) return;
      const handled = handleDwebBaseMessage(msg, sender, sendResponse);
      if (handled !== true) sendResponse({ ok: false, error: 'unknown-dweb-host-message' });
    }, (cause) => sendResponse(errorResponse(cause)));
  return true;
}));

/** @typedef {(message: any) => Promise<any>} ExtractionHandler */
/** @type {Readonly<Record<string, () => Promise<ExtractionHandler>>>} */
const extractionLoaders = Object.freeze({
  'doc/extract': makeBoundedModuleLoader(() => import('./doc-extract.js')
    .then((module) => /** @type {ExtractionHandler} */ (module.handleDocExtract))),
  'web/extract': makeBoundedModuleLoader(() => import('./web-extract.js')
    .then((module) => /** @type {ExtractionHandler} */ (module.handleWebExtract))),
});
browser.runtime.onMessage.addListener(/** @type {any} */ ((
  /** @type {any} */ msg,
  /** @type {any} */ sender,
  /** @type {(value:any)=>void} */ sendResponse,
) => {
  const load = extractionLoaders[/** @type {keyof typeof extractionLoaders} */ (msg?.type)];
  if (!load) return false;
  if (!isServiceWorkerSender(sender)) {
    sendResponse({ ok: false, error: 'untrusted-sender' });
    return false;
  }
  const claim = claimLease('dom-host', sendResponse);
  if (!claim) return false;
  load().then((handle) => rejectStaleClaim('dom-host', claim, sendResponse)
    ? undefined : handle(msg)).then(
    sendResponse, (cause) => sendResponse(errorResponse(cause)),
  );
  return true;
}));

// --- headless JS jobs (script tool → engine.runJob) ---
// Spawns the sealed Worker here and relays its egress/actor bridges back to
// the SW's audited routes. A separate listener so voice is untouched.
/** @type {{
 * runJob: typeof import('./job-runner.js').runJob,
 * abortJob: typeof import('./job-runner.js').abortJob,
 * abortAllJobs: typeof import('./job-runner.js').abortAllJobs,
 * extractMarkdownLocal: typeof import('./web-extract-core.js').extractMarkdownLocal,
 * }|null} */
let jobHost = null;
const loadJobHost = makeBoundedModuleLoader(() => Promise.all([
  import('./job-runner.js'), import('./web-extract-core.js'),
]).then(([jobs, web]) => (jobHost = {
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
  const claim = claimLease('dom-host', sendResponse);
  if (!claim) return true;
  loadJobHost().then(({ runJob, extractMarkdownLocal }) => {
    if (rejectStaleClaim('dom-host', claim, sendResponse)) return undefined;
    return runJob({
      code: msg.code, timeoutMs: msg.timeoutMs, startedAt: msg.startedAt, deadlineAt: msg.deadlineAt,
      a2a: msg.a2a === true, actors: msg.actors === true,
      // DESIGN-19: the pinned origin for a site-client run (trusted job param, SW-set).
      siteFetch: typeof msg.siteFetch === 'string' ? msg.siteFetch : '',
      // caps + ownerSessionId ride from the SW's job/run message (trusted: the
      // sender gate above). The WORKER never supplies either — job-runner
      // attaches them from these params and ignores anything in the worker's
      // own messages.
      caps: msg.caps,
      ownerSessionId: msg.ownerSessionId, ownerToolUseId: msg.ownerToolUseId, runId: msg.runId,
      pageProgramSemanticToken: typeof msg.pageProgramSemanticToken === 'string'
        ? msg.pageProgramSemanticToken : undefined,
      // The durable-workspace mount (trusted job param, SW-set — the sender
      // gate above is what makes it trustworthy; _runJob validates the shape).
      workspaceSessionId: msg.workspaceSessionId,
    }, {
      sendToSW: (/** @type {string} */ type, /** @type {any} */ payload) =>
        browser.runtime.sendMessage({ type, ...payload }),
      // Run settlement is a control signal, separate from the capability relay
      // lane: the SW aborts pending confirmations/tool work before job-runner
      // releases that lane for reuse.
      abortRun: (/** @type {string} */ runId, /** @type {string} */ ownerSessionId) => browser.runtime.sendMessage({
        type: 'script-run/abort', runId, ownerSessionId,
      }),
      // The bridged fetch's extract:'markdown' post-step — the local pipeline
      // adapter (see shared/fetch-extract.js for the why + posture).
      extractMarkdown: extractMarkdownLocal,
    });
  })
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse(errorResponse(e)));
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
  const claim = claimLease('dom-host', sendResponse);
  if (!claim) return true;
  if (typeof msg.runId !== 'string' || !msg.runId) {
    sendResponse({ ok: true });
    return true;
  }
  loadJobHost().then(({ abortJob }) => {
    if (rejectStaleClaim('dom-host', claim, sendResponse)) return;
    abortJob(msg.runId, typeof msg.ownerSessionId === 'string' ? msg.ownerSessionId : undefined);
    sendResponse({ ok: true });
  }, (cause) => sendResponse(errorResponse(cause)));
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
/** @type {typeof import('./local-model.js')|null} */
let localModelHost = null;
const loadLocalModelHost = makeBoundedModuleLoader(
  () => import('./local-model.js').then((module) => (localModelHost = module)),
);

/**
 * @param {any} msg
 * @param {import('webextension-polyfill').Runtime.MessageSender} sender
 * @param {(response: any) => void} sendResponse
 */
const onLocalModelMessage = (msg, sender, sendResponse) => {
  if (typeof msg?.type !== 'string' || !msg.type.startsWith('local-model/host/')) return undefined;
  if (!isServiceWorkerSender(sender)) { sendResponse({ ok: false, error: 'unauthorized-command-sender' }); return true; }
  const claim = claimLease('model-host', sendResponse);
  if (!claim) return true;
  (async () => {
    const local = await loadLocalModelHost();
    if (rejectStaleClaim('model-host', claim, sendResponse)) return;
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
        local.initLocalModel({ model: pre.model }, (/** @type {any} */ p) => { try { browser.runtime.sendMessage({ type: 'local-model/progress', progress: p }); } catch { /* SW asleep */ } })
          .catch((/** @type {any} */ e) => {
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
          await local.generateLocal(msg, (/** @type {string} */ token) => { try { browser.runtime.sendMessage({ type: 'local-model/delta', genId, token }); } catch { /* SW asleep */ } }, { signal: controller.signal });
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
  })().catch((e) => { try { sendResponse(errorResponse(e)); } catch { /* response gone */ } });
  return true; // async sendResponse contract
};
browser.runtime.onMessage.addListener(/** @type {any} */ (onLocalModelMessage));

const stopControllerFeature = async () => {
  for (const actorPort of actorPorts) {
    try { actorPort.close(); } catch { /* already closed */ }
  }
  actorPorts.clear();
  try { repositoryHost?.abortRepositoryHostCalls(); } catch {}
  try { controllerBootstrap?.releaseControllerHost?.(); } catch {}
  return { stopped: true };
};

const stopModelFeature = async () => {
  for (const controller of localGenerationControllers.values()) controller.abort();
  localGenerationControllers.clear();
  try { await localModelHost?.teardownLocalModel(); } catch {}
  return { stopped: true };
};

const stopDomFeature = async () => {
  let aborted = 0;
  try { aborted = jobHost?.abortAllJobs() ?? 0; } catch {}
  return { stopped: true, aborted };
};

const stopMediaFeature = async () => {
  await voiceChannelHost?.stopVoiceHost();
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

const ensureFeatureLeaseHost = makeBoundedModuleLoader(
  () => import('./feature-lease-host.js').then(({ createOffscreenFeatureLeaseHost }) => {
    featureLeaseHost ??= createOffscreenFeatureLeaseHost({
      expectedBuildId: `${EXTENSION_VERSION}:${CONTROLLER_BUILD_DIGEST}`,
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
    return featureLeaseHost;
  }),
  {
    loadCode: 'feature-lease-host-load-failed',
    timeoutCode: 'feature-lease-host-load-timeout',
  },
);

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
  ensureFeatureLeaseHost()
    .then((host) => host.handleMessage(message))
    .then(sendResponse, (cause) => sendResponse({
      ok: false,
      protocol: FEATURE_LEASE_HOST_PROTOCOL,
      code: cause?.code ?? 'feature-lease-host-load-failed',
      error: 'Feature host unavailable. Try again.',
      outcomeKnown: true,
      retryable: true,
    }));
  return true;
}));

globalThis.addEventListener('pagehide', () => { void featureLeaseHost?.close(); }, { once: true });
