// @ts-check

import { CHANNEL_DEFAULTS } from '/shared/channel-config.js';
import { createKernelDwebRouteRuntime } from './kernel-dweb-route-runtime.js';
import { createKernelRichRuntime } from './kernel-rich-runtime.js';

const REASONING_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** @param {Record<string,any>} deps */
export const createKernelProductionRuntime = async (deps) => {
  const networkFunctions = [
    deps?.ensureBrowserNetworkGuard,
    deps?.acquireBrowserNetworkGuardLease,
    deps?.releaseBrowserNetworkGuardLease,
    deps?.updateBrowserNetworkGuardOrigin,
    deps?.syncDenylistNetwork,
    deps?.updateBrowserSourceProjection,
  ];
  if (!deps?.seams || !deps.browser || !deps.featureHost || !deps.denylist
      || !deps.appCatalog || !deps.providerProjection || typeof deps.canWrite !== 'function'
      || !deps.networkCustody || !deps.turnCustody
      || typeof deps.createTurnFactories !== 'function'
      || networkFunctions.some((value) => typeof value !== 'function')
      || (deps.dwebEnabled && typeof deps.ensureDwebFeature !== 'function')) {
    throw new TypeError('kernel-production-runtime-config-invalid');
  }
  /** @type {Record<string,any>|null} */
  let liveRelays = null;
  const makeRichRuntime = deps.makeRichRuntime ?? createKernelRichRuntime;
  /** @type {Array<[string, any[]]>} */
  const pendingRelays = [];
  /** @param {string} name @param {...any} args */
  const relay = (name, ...args) => {
    const handler = liveRelays?.[name];
    if (typeof handler === 'function') return handler(...args);
    pendingRelays.push([name, args]);
    return undefined;
  };
  const trackerNote = (/** @type {string} */ kind) => (
    /** @type {number} */ tabId, /** @type {any} */ value,
  ) => relay('noteAgentTab', tabId, { kind, ...value });
  const engine = {
    idb: deps.idb,
    browser: deps.browser,
    vault: deps.vault,
    auditLog: deps.auditLog,
    pushState: deps.pushState,
    settingsStore: deps.settingsStore,
    sessionCache: deps.sessionCache,
    repositories: deps.repositories,
    denylist: deps.denylist,
    dwebEnabled: deps.dwebEnabled,
    firefox: deps.firefox,
    offscreenUrl: deps.offscreenUrl,
    bindAppRegistry: deps.bindAppRegistry,
    canWrite: deps.canWrite,
    confirm: deps.confirmation.confirm,
    fetchFn: globalThis.fetch.bind(globalThis),
    archiveOrphanedActor: (/** @type {string} */ sessionId) =>
      relay('archiveOrphanedActor', sessionId),
    noteVmTab: trackerNote('WebVM'),
    noteJsTab: trackerNote('Notebook'),
    notePodTab: trackerNote('Pod'),
    noteAppTab: trackerNote('App'),
    onVmTabAdopt: (/** @type {string} */ id, /** @type {number} */ tabId) =>
      relay('onEngineAdopt', 'vm', id, tabId),
    onJsTabAdopt: (/** @type {string} */ id, /** @type {number} */ tabId) =>
      relay('onEngineAdopt', 'notebook', id, tabId),
    onPodTabAdopt: (/** @type {string} */ id, /** @type {number} */ tabId) =>
      relay('onEngineAdopt', 'pod', id, tabId),
    onAppTabAdopt: (/** @type {string} */ id, /** @type {number} */ tabId) =>
      relay('onEngineAdopt', 'app', id, tabId),
    onVmTabDrop: (/** @type {string} */ id) => relay('onEngineDrop', 'vm', id),
    onJsTabDrop: (/** @type {string} */ id) => relay('onEngineDrop', 'notebook', id),
    onPodTabDrop: (/** @type {string} */ id) => relay('onEngineDrop', 'pod', id),
    onAppTabDrop: (/** @type {string} */ id) => relay('onEngineDrop', 'app', id),
    onAppManifestMutation: (/** @type {string} */ appId) =>
      relay('onAppManifestMutation', appId),
    resolveAppOwnerRoot: (/** @type {string} */ appId) =>
      relay('resolveAppOwnerRoot', appId),
    onAppDeleted: (/** @type {string} */ appId) => relay('onAppDeleted', appId),
    withArtifactLease: (/** @type {()=>Promise<any>} */ operation) =>
      deps.featureHost.runtime.runWithLease('dom-host', operation, {
        reason: 'artifact-codec-demand',
      }),
    withDomLease: (/** @type {()=>Promise<any>} */ operation) =>
      deps.featureHost.runtime.runWithLease('dom-host', operation, { reason: 'dom-demand' }),
    withDirectLifetime: (/** @type {()=>Promise<any>} */ operation, /** @type {any} */ options) =>
      deps.firefoxActorLifetime ? deps.firefoxActorLifetime.run(operation, options) : operation(),
    ensureOffscreen: deps.featureHost.ensureOffscreen,
    retireHost: (/** @type {string} */ reason) => deps.featureHost.runtime.retireActiveHost(reason),
    importLocalArtifact: deps.importArtifactCodec,
  };
  const transfer = {
    idb: deps.idb,
    kv: deps.kv,
    vault: deps.vault,
    auditLog: deps.auditLog,
    pushState: deps.pushState,
    settingsStore: deps.settingsStore,
    normalizeSettingsPatch: deps.normalizeSettingsPatch,
    reasoningEffortLevels: REASONING_EFFORT_LEVELS,
    dwebEnabled: deps.dwebEnabled,
    defaultSettings: CHANNEL_DEFAULTS,
    channel: deps.channel,
    canWrite: deps.canWrite,
    ensureSettingsReady: () => deps.ready,
    loadUserEndpoints: () => relay('loadUserEndpoints'),
    getDwebTransfer: async () => (await deps.getDwebLive?.())?.dwebTransfer ?? null,
    normalizeImportedSettings: (/** @type {any} */ patch) => deps.normalizeSettingsPatch(patch, {
      knownProviderNames: deps.knownProviderNames,
      reasoningEffortLevels: REASONING_EFFORT_LEVELS,
      dwebEnabled: deps.dwebEnabled,
      autoUpdateAvailable: Object.hasOwn(CHANNEL_DEFAULTS, 'autoUpdateEnabled'),
    }),
    onSettingsChanging: deps.onSettingsChanging,
    onSettingsChanged: async (/** @type {any} */ patch) => {
      await deps.onSettingsChanged?.(patch);
      await relay('onSettingsChanged', patch);
      if (Object.hasOwn(patch ?? {}, 'dwebEnabled')
          || Object.hasOwn(patch ?? {}, 'dwebAgentEnabled')) {
        await relay('syncDwebAgentRoom');
      }
    },
    onProviderConfigChanged: () => deps.providerProjection.bumpRevision(),
    isWriteRefusal: (/** @type {unknown} */ cause) =>
      /** @type {{name?:unknown}} */ (cause)?.name === 'StoreReadOnlyError',
  };
  const turn = {
    custody: deps.turnCustody,
    seams: deps.seams,
    browser: deps.browser,
    idb: deps.idb,
    kv: deps.kv,
    sessionCache: deps.sessionCache,
    vault: deps.vault,
    auditLog: deps.auditLog,
    settingsStore: deps.settingsStore,
    uiPorts: deps.uiPorts,
    pushState: deps.pushState,
    postChatNote: deps.postChatNote,
    ensureReady: () => deps.ready,
    onAbort: (/** @type {string} */ sessionId) => deps.confirmation.declineSession?.(sessionId),
    goal: {
      kv: deps.kv,
      beforeStart: (/** @type {any} */ request) => relay('beforeGoalStart', request),
      hasUnresolvedSideEffects: (/** @type {string} */ sessionId) =>
        relay('hasUnresolvedSideEffects', sessionId),
      onEvent: (/** @type {any} */ event) => deps.uiPorts.broadcast(event),
      onRunEnd: (/** @type {string} */ sessionId, /** @type {any} */ info) =>
        relay('onGoalRunEnd', sessionId, info),
      bind: (/** @type {any} */ runner) => relay('bindGoalRunner', runner),
    },
  };
  const rich = await makeRichRuntime({
    engine,
    turn,
    transfer,
    createTurnFactories: (
      /** @type {{engine:Record<string,any>}} */ { engine: sharedEngine },
    ) => deps.createTurnFactories({ ...deps, engine: sharedEngine }),
    createDwebRoutes: deps.dwebEnabled ? async (
      /** @type {{engine:Record<string,any>,relays:Record<string,any>,transferLive:Record<string,any>}} */
      { engine: sharedEngine, relays, transferLive },
    ) => {
      const dweb = await deps.getDwebLive?.();
      if (!dweb?.withIdentityMutation) throw new Error('kernel-dweb-live-unavailable');
      return createKernelDwebRouteRuntime({
        enabled: true,
        engine: sharedEngine,
        relays,
        transfer: transferLive,
        withIdentityMutation: dweb.withIdentityMutation,
        ensureDwebFeature: deps.ensureDwebFeature,
        disableDweb: () => deps.settingsStore.update({ dwebEnabled: false }),
        ensureSettingsReady: () => deps.ready,
        ensureAppTrackerReady: () => relays.engineReady,
        getCurrentSessionId: () => deps.sessionCache.sessionGet('currentSessionId'),
        isOffscreenSender: deps.isOffscreenSender,
        settingsStore: deps.settingsStore,
        vault: deps.vault,
        auditLog: deps.auditLog,
        kv: deps.kv,
        browser: deps.browser,
        pushState: deps.pushState,
      });
    } : undefined,
  });
  liveRelays = rich.relays;
  const settledRelays = /** @type {Record<string,any>} */ (liveRelays);
  for (const [name, args] of pendingRelays.splice(0)) {
    const handler = settledRelays[name];
    if (typeof handler !== 'function') continue;
    Promise.resolve(handler(...args)).catch(() => {});
  }
  return rich;
};
