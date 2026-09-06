// @ts-check

import { CHANNEL_DEFAULTS } from '/shared/channel-config.js';
import { createKernelDwebRouteOwner } from './kernel-dweb-route-runtime.js';
import { createKernelRichRuntime } from './kernel-rich-runtime.js';

const REASONING_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const REQUIRED_RELAY_NAMES = Object.freeze([
  'archiveOrphanedActor', 'noteAgentTab', 'onEngineAdopt', 'onEngineDrop',
  'onAppManifestMutation', 'resolveAppOwnerRoot', 'onAppDeleted', 'loadUserEndpoints',
  'onSettingsChanged', 'syncDwebAgentRoom', 'beforeGoalStart',
  'hasUnresolvedSideEffects', 'onGoalRunEnd', 'bindGoalRunner',
]);
/** @typedef {'vm'|'notebook'|'pod'|'app'} EngineKind */
/** @typedef {{action:'adopt',kind:EngineKind,id:string,tabId:number}
 *   | {action:'drop',kind:EngineKind,id:string}} PendingLiveness */

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
  const makeRichRuntime = deps.makeRichRuntime ?? createKernelRichRuntime;
  /** @type {any} */
  let liveRelays;
  /** @type {PendingLiveness[]} */
  const pendingLiveness = [];
  /** @type {any} */
  let pendingGoal = null;
  const trackerNote = (/** @type {string} */ kind) => (
    /** @type {number} */ tabId, /** @type {any} */ value,
  ) => liveRelays.noteAgentTab(tabId, { kind, ...value });
  const onEngineAdopt = (/** @type {EngineKind} */ kind, /** @type {string} */ id,
    /** @type {number} */ tabId) => {
    // why: tracker bootstrap runs before the turn owner exists.
    if (liveRelays) return liveRelays.onEngineAdopt(kind, id, tabId);
    pendingLiveness.push({ action: 'adopt', kind, id, tabId });
  };
  const onEngineDrop = (/** @type {EngineKind} */ kind, /** @type {string} */ id) => {
    // why: an App can fail after its pre-bind pending adoption.
    if (liveRelays) return liveRelays.onEngineDrop(kind, id);
    pendingLiveness.push({ action: 'drop', kind, id });
  };
  const bindGoalRunner = (/** @type {any} */ runner) => {
    // why: goal construction binds before the turn owner can be published.
    if (liveRelays) return liveRelays.bindGoalRunner(runner);
    if (pendingGoal) throw new Error('kernel-production-goal-runner-already-pending');
    pendingGoal = runner;
  };
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
      liveRelays.archiveOrphanedActor(sessionId),
    noteVmTab: trackerNote('WebVM'),
    noteJsTab: trackerNote('Notebook'),
    notePodTab: trackerNote('Pod'),
    noteAppTab: trackerNote('App'),
    onVmTabAdopt: (/** @type {string} */ id, /** @type {number} */ tabId) =>
      onEngineAdopt('vm', id, tabId),
    onJsTabAdopt: (/** @type {string} */ id, /** @type {number} */ tabId) =>
      onEngineAdopt('notebook', id, tabId),
    onPodTabAdopt: (/** @type {string} */ id, /** @type {number} */ tabId) =>
      onEngineAdopt('pod', id, tabId),
    onAppTabAdopt: (/** @type {string} */ id, /** @type {number} */ tabId) =>
      onEngineAdopt('app', id, tabId),
    onVmTabDrop: (/** @type {string} */ id) => onEngineDrop('vm', id),
    onJsTabDrop: (/** @type {string} */ id) => onEngineDrop('notebook', id),
    onPodTabDrop: (/** @type {string} */ id) => onEngineDrop('pod', id),
    onAppTabDrop: (/** @type {string} */ id) => onEngineDrop('app', id),
    onAppManifestMutation: (/** @type {string} */ appId) =>
      liveRelays.onAppManifestMutation(appId),
    resolveAppOwnerRoot: (/** @type {string} */ appId) =>
      liveRelays.resolveAppOwnerRoot(appId),
    onAppDeleted: (/** @type {string} */ appId) => liveRelays.onAppDeleted(appId),
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
    ensureHostRetirement: () => deps.featureHost.runtime.ensureHostRetirement(),
    armHostRetirement: (/** @type {string} */ hostEpoch) =>
      deps.featureHost.runtime.armHostRetirement(hostEpoch),
    disarmHostRetirement: (/** @type {string} */ hostEpoch) =>
      deps.featureHost.runtime.disarmHostRetirement(hostEpoch),
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
    loadUserEndpoints: () => liveRelays.loadUserEndpoints(),
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
      await liveRelays.onSettingsChanged(patch);
      if (Object.hasOwn(patch ?? {}, 'dwebEnabled')
          || Object.hasOwn(patch ?? {}, 'dwebAgentEnabled')) {
        await liveRelays.syncDwebAgentRoom();
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
      beforeStart: (/** @type {any} */ request) =>
        liveRelays.beforeGoalStart(request),
      hasUnresolvedSideEffects: (/** @type {string} */ sessionId) =>
        liveRelays.hasUnresolvedSideEffects(sessionId),
      onEvent: (/** @type {any} */ event) => deps.uiPorts.broadcast(event),
      onRunEnd: (/** @type {string} */ sessionId, /** @type {any} */ info) =>
        liveRelays.onGoalRunEnd(sessionId, info),
      bind: bindGoalRunner,
    },
  };
  const rich = await makeRichRuntime({
    engine,
    turn,
    transfer,
    createTurnFactories: (
      /** @type {{engine:Record<string,any>}} */ { engine: sharedEngine },
    ) => deps.createTurnFactories({ ...deps, engine: sharedEngine }),
    createDwebOwner: deps.dwebEnabled ? async (
      /** @type {{engine:Record<string,any>,relays:Record<string,any>,transferLive:Record<string,any>}} */
      { engine: sharedEngine, relays, transferLive },
    ) => {
      const dweb = await deps.getDwebLive?.();
      if (!dweb?.withIdentityMutation) throw new Error('kernel-dweb-live-unavailable');
      return createKernelDwebRouteOwner({
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
        currentDwebHostEpoch: () => {
          const lease = deps.featureHost.runtime.snapshot().leases.dweb;
          return lease?.status === 'active' ? lease.hostEpoch : null;
        },
        pushState: deps.pushState,
      });
    } : undefined,
  });
  const candidateRelays = rich.relays;
  const missingRelay = REQUIRED_RELAY_NAMES.find(
    (name) => typeof candidateRelays?.[name] !== 'function',
  );
  try {
    if (missingRelay) throw new TypeError(`kernel-production-relay-${missingRelay}-invalid`);
    let nextLiveness = 0;
    const drainLiveness = async (/** @type {boolean} */ publish = false) => {
      while (nextLiveness < pendingLiveness.length) {
        const transition = pendingLiveness[nextLiveness++];
        if (transition.action === 'adopt') {
          await candidateRelays.onEngineAdopt(
            transition.kind, transition.id, transition.tabId,
          );
        } else {
          await candidateRelays.onEngineDrop(transition.kind, transition.id);
        }
      }
      // why: publish before this async frame resolves, leaving no microtask
      // gap in which one last transition could enter the drained queue.
      if (publish) liveRelays = candidateRelays;
    };
    await drainLiveness();
    if (pendingGoal) await candidateRelays.bindGoalRunner(pendingGoal);
    await drainLiveness(true);
  } catch (cause) {
    try { await rich.close?.(); } catch { /* preserve the binding failure */ }
    throw cause;
  }
  return rich;
};
