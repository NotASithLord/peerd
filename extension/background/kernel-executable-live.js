// @ts-check

import {
  ArtifactTooLargeError,
  createAppRegistry,
  createNotebookRegistry,
  createPodRegistry,
  createVmRegistry,
  EnvelopeFormatError,
  EnvelopeIntegrityError,
  IMAGE_PIN_STORAGE_KEY,
  makeVmHttpFetch,
  NOTEBOOK_OPFS_ROOT,
  opfsHelpers,
  parseAppManifest,
  podGitRemoteOperation,
} from '/peerd-engine/background.js';
import { makeWebFetch, matchesDenylist } from '/peerd-egress/background.js';
import { applyFetchExtract } from '/shared/fetch-extract.js';
import { bytesToBase64 } from '/shared/cold-util.js';
import { createAppClient } from './app-client.js';
import { createAppQuiescence } from './app-quiescence.js';
import { createAppTabTracker } from './app-tab-tracker.js';
import { createDwebPublicationFence } from './dweb-publication-fence.js';
import { createJsClient } from './notebook-client.js';
import { createJsTabTracker } from './notebook-tab-tracker.js';
import { makeArtifactEngineClient } from './offscreen-artifact-client.js';
import { makeOffscreenWebClient } from './offscreen-web-client.js';
import { createPodClient } from './pod-client.js';
import { createPodTabTracker } from './pod-tab-tracker.js';
import { listOffscreenContexts } from './offscreen-contexts.js';
import { createVmClient } from './vm-client.js';
import { createVmTabTracker } from './vm-tab-tracker.js';

/** @param {Record<string,any>} deps */
export const createKernelEngineLive = async (deps) => {
  const idbKv = (/** @type {string} */ store) => ({
    get: async (/** @type {string} */ key) => (await deps.idb.get(store, key))?.value,
    set: async (/** @type {string} */ key, /** @type {any} */ value) =>
      deps.idb.put(store, { key, value }),
  });
  const registryDeps = (/** @type {string} */ store) => ({
    storage: idbKv(store),
    onActorArchive: deps.archiveOrphanedActor,
  });
  const vmRegistry = createVmRegistry(registryDeps('vms'));
  const jsRegistry = createNotebookRegistry(registryDeps('notebooks'));
  const podRegistry = createPodRegistry(registryDeps('pods'));
  const makeAppRegistry = async () => createAppRegistry(registryDeps('apps'));
  const appRegistry = typeof deps.bindAppRegistry === 'function'
    ? await deps.bindAppRegistry(makeAppRegistry)
    : await makeAppRegistry();
  await Promise.all([
    vmRegistry.load(), jsRegistry.load(), podRegistry.load(), appRegistry.load(),
  ]);
  const vmTabTracker = createVmTabTracker({
    tabs: deps.browser.tabs,
    announce: deps.noteVmTab,
    onAdopt: deps.onVmTabAdopt,
    onDrop: deps.onVmTabDrop,
  });
  const jsTabTracker = createJsTabTracker({
    announce: deps.noteJsTab,
    onAdopt: deps.onJsTabAdopt,
    onDrop: deps.onJsTabDrop,
    sendTabMessage: deps.browser.tabs.sendMessage.bind(deps.browser.tabs),
  });
  const podTabTracker = createPodTabTracker({
    tabs: deps.browser.tabs,
    announce: deps.notePodTab,
    onAdopt: deps.onPodTabAdopt,
    onDrop: deps.onPodTabDrop,
  });
  const appTabTracker = createAppTabTracker({
    tabs: deps.browser.tabs,
    sendTabMessage: deps.browser.tabs.sendMessage.bind(deps.browser.tabs),
    announce: deps.noteAppTab,
    onAdopt: deps.onAppTabAdopt,
    onDrop: deps.onAppTabDrop,
  });
  const [, , podBootstrap, appCandidates] = await Promise.all([
    vmTabTracker.bootstrap(),
    jsTabTracker.bootstrap(),
    podTabTracker.bootstrap(),
    appTabTracker.bootstrap(),
  ]);
  const vmClient = createVmClient({ registry: vmRegistry, tracker: vmTabTracker });
  const jsClient = createJsClient({ registry: jsRegistry, tracker: jsTabTracker });
  const podClient = createPodClient({
    registry: podRegistry,
    tracker: podTabTracker,
    sendTabMessage: deps.browser.tabs.sendMessage.bind(deps.browser.tabs),
  });
  const appClient = createAppClient({
    registry: appRegistry,
    tracker: appTabTracker,
    beforeOpfsMutation: () => deps.canWrite('app-manifests'),
    onManifestMutation: deps.onAppManifestMutation,
    resolveOwnerRoot: deps.resolveAppOwnerRoot,
    repositories: deps.repositories,
  });
  const policy = await deps.denylist.ready();
  if (!policy?.ok) {
    throw Object.assign(new Error('sensitive-origin policy unavailable'), {
      code: 'kernel-denylist-unavailable', outcomeKnown: true,
    });
  }
  const webFetch = makeWebFetch({
    getDenylist: () => deps.denylist.patterns(),
    matchDenylist: matchesDenylist,
    audit: deps.auditLog.append,
    fetchFn: deps.fetchFn,
  });
  const vmHttpFetch = makeVmHttpFetch({
    webFetch,
    getSecret: (/** @type {string} */ name) => deps.vault.getSecret(name),
    cacheGet: (/** @type {string} */ key) => deps.idb.get('vm_http_cache', key),
    cachePut: (/** @type {any} */ row) => deps.idb.put('vm_http_cache', row),
    confirm: deps.confirm,
    getCurrentSessionId: () => deps.sessionCache.sessionGet('currentSessionId'),
    bytesToBase64,
    audit: (/** @type {any} */ event) => { void deps.auditLog.append(event).catch(() => {}); },
  });
  const artifactEngine = makeArtifactEngineClient({
    offscreen: !deps.firefox,
    offscreenUrl: deps.offscreenUrl,
    withHost: deps.withArtifactLease,
    retireHost: deps.retireHost,
    withLocalLifetime: deps.withDirectLifetime,
    importLocal: deps.importLocalArtifact,
  });
  const webHost = !deps.firefox && typeof deps.withDomLease === 'function'
    ? makeOffscreenWebClient({
      ensureOffscreen: deps.ensureOffscreen,
      sendMessage: (/** @type {any} */ message) => deps.withDomLease(
        () => deps.browser.runtime.sendMessage(message),
      ),
    })
    : null;
  const appLifecycleTails = new Map();
  const withAppLifecycle = async (/** @type {string} */ appId, /** @type {()=>Promise<any>} */ operation) => {
    const prior = appLifecycleTails.get(appId) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(operation);
    appLifecycleTails.set(appId, current);
    try { return await current; }
    finally { if (appLifecycleTails.get(appId) === current) appLifecycleTails.delete(appId); }
  };
  const dwebPublicationFence = createDwebPublicationFence();
  const appQuiescence = createAppQuiescence({
    tracker: appTabTracker,
    withLifecycle: withAppLifecycle,
  });
  return Object.freeze({
    vault: deps.vault,
    auditLog: deps.auditLog,
    pushState: deps.pushState,
    browser: deps.browser,
    vmHttpFetch,
    appRegistry,
    vmRegistry,
    vmTabTracker,
    vmClient,
    jsRegistry,
    jsTabTracker,
    jsClient,
    podRegistry,
    podTabTracker,
    podClient,
    podBootstrap,
    appClient,
    appTabTracker,
    appCandidates,
    appQuiescence,
    opfsHelpers: (/** @type {string[]} */ root) => opfsHelpers(root, {
      beforeMutation: () => deps.canWrite('opfs-workspaces'),
    }),
    NOTEBOOK_OPFS_ROOT,
    IMAGE_PIN_STORAGE_KEY,
    artifactEngine,
    ArtifactTooLargeError,
    EnvelopeFormatError,
    EnvelopeIntegrityError,
    settingsStore: deps.settingsStore,
    DWEB_ENABLED: deps.dwebEnabled,
    applyWebExtract: (/** @type {any} */ response, /** @type {unknown} */ extract,
      /** @type {string} */ url) => applyFetchExtract(response, {
      extract,
      url,
      extractMarkdown: deps.extractMarkdown
        ?? (webHost ? (source) => webHost.extractMarkdown(source) : null),
    }),
    withDwebPublication: dwebPublicationFence.run,
    invalidateDwebPublications: dwebPublicationFence.invalidate,
    dwebPublicationGeneration: dwebPublicationFence.generation,
    withAppLifecycle,
    listOffscreenContexts,
    awaitDenylistPolicy: async () => {
      const current = await deps.denylist.ready();
      if (!current?.ok) throw new Error('sensitive-origin policy unavailable');
    },
    assertOpfsWritable: () => deps.canWrite('opfs-workspaces'),
    repositories: deps.repositories,
    parseAppManifest,
    podGitRemoteOperation,
    getCurrentSessionId: () => deps.sessionCache.sessionGet('currentSessionId'),
    onAppDeleted: deps.onAppDeleted,
    canWrite: () => deps.canWrite('engine-registries'),
  });
};

/** @param {Record<string,any>} deps */
export const createKernelExecutableLive = async (deps) => Object.freeze({
  ...(deps.engine ?? await createKernelEngineLive(deps)),
  scriptRuns: deps.relays.scriptRuns,
  isOffscreenSender: deps.isOffscreenSender,
});
