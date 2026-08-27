// @ts-check

import { createKernelIdentity } from '/shared/kernel-identity.js';
import {
  BROWSER, CHANNEL, CHANNEL_DEFAULTS, CONTROLLER_BUILD_DIGEST, DWEB_ENABLED,
} from '/shared/build-config.js';
import browser from '/shared/browser-api.js';
import { base64ToBytes } from '/shared/cold-util.js';
import { makeBoundedModuleLoader } from '/shared/bounded-module-load.js';
import {
  KERNEL_ADMINISTRATIVE_ROUTE_NAMES,
  KERNEL_CREDENTIAL_ROUTE_NAMES,
  KERNEL_DEMAND_SUPPORT_ROUTE_NAMES,
  KERNEL_DWEB_ROUTE_NAMES,
  KERNEL_EXECUTABLE_ROUTE_NAMES,
  KERNEL_SESSION_SUPPORT_ROUTE_NAMES,
  KERNEL_SEMANTIC_OWNER_ROUTE_NAMES,
  KERNEL_TRANSFER_ROUTE_NAMES,
} from '/shared/kernel-feature-route-inventory.js';
import {
  PRIVATE_NETWORK_RULE_DIGESTS,
  PRIVATE_NETWORK_RULE_IDS,
} from '/shared/private-network-rule-ids.js';
import {
  createAuditLog,
  DEFAULT_AUDIT_MAX_ENTRIES,
  DEFAULT_AUTO_LOCK_MS,
  idb as rawIdb,
  kv as rawKv,
  PrfNotEnrolledError,
  PrfUnlockFailedError,
  purgeVaultBlob,
  RecoveryPassphraseNotSetError,
  sessionCache,
  applyStoreBootPosture,
  makeWriteGuard,
  VERSION_STAMP_KEY,
  VaultAlreadyInitializedError,
  VaultLockedError,
  VaultNotInitializedError,
  WrongPassphraseError,
} from '/peerd-egress/kernel-storage.js';
import { makeUiPorts } from './ui-ports.js';
import { createKernelBrowserNetworkRuntime } from './kernel-browser-network-authority.js';
import { createKernelControllerGateway } from './kernel-controller-gateway.js';
import {
  makeSerializedDnrSessionRules,
  makeStartupPopupNetworkGuard,
} from './startup-popup-network-guard.js';
import {
  makeKernelLearnedOriginRoutes,
  makeSettingsStore,
} from './settings-store.js';
import {
  createKernelDenylistPolicy,
  makeKernelDenylistRoutes,
} from './kernel-denylist-policy.js';
import {
  attachKernelFrontDoor,
  attachKernelLifecycleEvents,
  attachKernelTabEvents,
  createKernelBrowserChildOutcomes,
  createKernelBrowserEventOwners,
  createKernelBrowserNetworkOwner,
  createKernelColdReceipts,
  createKernelConfirmation,
  createKernelFeatureHost,
  createKernelPortOwners,
  createKernelPortRouter,
  createKernelSenderPolicy,
  createKernelTabCustody,
  createKernelUiPortOwner,
  INERT_CHILD_REQUEST_GUARD,
  makeKernelDemandRoutes,
  makeKernelGenerationLifecycle,
} from './kernel-control-plane.js';
import { makePrivateTransferOpenRoute, makePrivateTransferPort } from './private-transfer-port.js';
import { createKernelProviderProjection } from './kernel-provider-projection.js';
import { createKernelRecoveryCustody } from './kernel-recovery-custody.js';
import { createContextSnapshots } from './context-snapshots.js';
import { createScriptRunRegistry } from './script-runs.js';
import {
  createVaultKernelAssemblyReport,
  SEMANTIC_CUTOVER_SUMMARY,
} from './vault-kernel-assembly.js';
import {
  makeKernelRouteProvenance,
  makeVaultKernelMessageHandler,
  makeIndexedVaultRoutes,
  makeVaultKernelRoutes,
  makeSystemReadRoutes,
  prepareVaultKernel,
  createVaultPostureIndex,
  createKernelSessionReader,
  createKernelProfileAuthority,
  buildVaultKernelState,
  LOCKED_PROVIDER_AUTHORITY_VIEW,
  resolveKernelPermission,
  makeSessionSupportPreflight,
} from './vault-kernel-core.js';
import { openHome } from '/shared/open-home.js';

const TARGET_RUNTIME_MODULE_KEYS = Object.freeze([
  'controllerClient',
  'demandPlane',
  'productionRuntime',
  'sessionAuthority',
  'supportControl',
  'turnFactories',
]);

/**
 * Install the shared authority kernel with one browser-exact module owner.
 * Chrome supplies static factories; Firefox supplies its supported demand
 * loaders. The exact keys prevent this composition seam becoming a function
 * bag or feature registry.
 * @param {Record<string,()=>Promise<any>>} runtimeModules
 */
export const installVaultKernel = (runtimeModules) => {
const requiredRuntimeModuleKeys = BROWSER === 'firefox'
  ? [...TARGET_RUNTIME_MODULE_KEYS, 'artifactCodec', 'directActorHost']
  : TARGET_RUNTIME_MODULE_KEYS;
const runtimeModuleKeys = Object.keys(runtimeModules ?? {}).sort();
if (runtimeModuleKeys.length !== requiredRuntimeModuleKeys.length
    || requiredRuntimeModuleKeys.some((name) => typeof runtimeModules?.[name] !== 'function')
    || runtimeModuleKeys.some((name) => !requiredRuntimeModuleKeys.includes(name))) {
  throw new TypeError('kernel-runtime-module-owner-invalid');
}
const kernelClockNow = () => globalThis.performance?.now?.() ?? Date.now();
const kernelBundleStartedAt = Number(
  /** @type {any} */ (globalThis)[Symbol.for('peerd.kernel.bundle-start.v1')],
);
const kernelModuleEvaluatedAt = kernelClockNow();
/** @type {number|null} */
let kernelVaultReadyAt = null;
/** @type {number|null} */
let kernelReadyAt = null;
const runtimeId = browser.runtime.id;
const kernelManifest = /** @type {any} */ (browser.runtime.getManifest());
const kernelFirefox = BROWSER === 'firefox';
const makeFirefoxGuard = /** @type {any} */ (
  globalThis)[Symbol.for('peerd.kernel.firefox-addon.v1')];
if (kernelFirefox !== !!makeFirefoxGuard) {
  throw new Error('kernel-firefox-addon-invalid');
}
const targetAddon = /** @type {any} */ (globalThis)[Symbol.for('peerd.kernel.target-addon.v1')];
if (targetAddon && (targetAddon.target !== 'preview-chrome'
    || typeof targetAddon.update !== 'function'
    || typeof targetAddon.dwebCustody !== 'function'
    || typeof targetAddon.contributor !== 'function')) {
  throw new Error('kernel-target-addon-invalid');
}
if (DWEB_ENABLED !== !!targetAddon) throw new Error('kernel-target-addon-mismatch');
const kernelSelfHostedChrome = !!kernelManifest.update_url
  && typeof browser.runtime.requestUpdateCheck === 'function';
const kernelBuild = `${kernelManifest.version}:${CONTROLLER_BUILD_DIGEST}`;
const kernelIdentity = createKernelIdentity({ buildId: kernelBuild });
const extensionOrigin = browser.runtime.getURL('');
const sidepanelUrl = browser.runtime.getURL('sidepanel/sidepanel.html');
const homeUrl = browser.runtime.getURL('home/home.html');
const optionsUrl = browser.runtime.getURL('options/options.html');
const evalRunnerUrl = browser.runtime.getURL('eval/runner.html');
const notebookTabUrl = browser.runtime.getURL('engine-tabs/notebook-tab/index.html');
const vmTabUrl = browser.runtime.getURL('engine-tabs/vm-tab/index.html');
const podTabUrl = browser.runtime.getURL('engine-tabs/pod-tab/index.html');
const offscreenPath = 'offscreen/offscreen.html';
const offscreenUrl = browser.runtime.getURL(offscreenPath);
const appTabUrl = browser.runtime.getURL('engine-tabs/app-tab/index.html');
const packagedFetch = (/** @type {string|URL|Request} */ input,
  /** @type {RequestInit|undefined} */ init = undefined) => globalThis.fetch(input, init);
const {
  trusted, sidepanelUi, homeUi, humanUi, optionsUi, evalUi, voiceUi,
  notebookUi, appUi, offscreenUi, sidepanelPortUi,
} = createKernelSenderPolicy({
  runtimeId, extensionOrigin, sidepanelUrl, homeUrl, optionsUrl, evalRunnerUrl,
  notebookTabUrl, offscreenUrl, appTabUrl,
});
const writeGuard = makeWriteGuard();
const kv = writeGuard.wrapKv(rawKv);
const idb = writeGuard.wrapIdb(rawIdb);
let autoLockMs = DEFAULT_AUTO_LOCK_MS;
const settingsStore = makeSettingsStore({
  kv, key: 'settings.v1', defaults: CHANNEL_DEFAULTS,
});
const vaultPosture = createVaultPostureIndex({ kv });
const auditLog = createAuditLog({ idb, maxEntries: DEFAULT_AUDIT_MAX_ENTRIES });
const uiPorts = makeUiPorts();
const postChatNote = (/** @type {string} */ text, /** @type {any} */ action = null,
  /** @type {string|null} */ sessionId = null) => {
  if (uiPorts.size < 1) return;
  uiPorts.broadcast({
    type: 'turn/system-note', text,
    ...(action ? { action } : {}), ...(sessionId ? { sessionId } : {}),
  });
};
const browserChildOutcomes = createKernelBrowserChildOutcomes({
  audit: (entry) => auditLog.append(entry),
  noteBlank: (tabId) => controllerRelays()?.noteAgentTab?.(tabId, {
    label: 'blank child', opened: true, protected: true,
  }),
});
const confirmation = createKernelConfirmation({
  browser,
  uiPorts,
  sessionCache,
  isSidepanelSender: sidepanelUi,
  isHomeSender: homeUi,
});
const denylistPolicy = createKernelDenylistPolicy({
  kv,
  readSeed: async () => {
    const response = await packagedFetch(
      browser.runtime.getURL('peerd-egress/denylist/default.json'),
    );
    if (!response.ok) throw new Error(`denylist seed fetch failed: ${response.status}`);
    return response.json();
  },
});
const generation = makeKernelGenerationLifecycle({
  session: sessionCache,
  identity: kernelIdentity,
});
/** @type {ReturnType<typeof featureHost.attachFirefoxActorLifetime>|null} */
let firefoxActorLifetime = null;
const featureHost = createKernelFeatureHost({
  browser,
  identity: kernelIdentity,
  vaultUnlocked: false,
  dwebEnabled: () => DWEB_ENABLED && settingsStore.get().dwebEnabled === true,
  vaultStorage: { kv, idb, sessionCache },
  vaultErrorTypes: {
    'already-initialized': VaultAlreadyInitializedError,
    'wrong-passphrase': WrongPassphraseError,
    'not-initialized': VaultNotInitializedError,
    'recovery-not-set': RecoveryPassphraseNotSetError,
    'prf-not-enrolled': PrfNotEnrolledError,
    'prf-unlock-failed': PrfUnlockFailedError,
    locked: VaultLockedError,
  },
  onError: (error) => {
    firefoxActorLifetime?.fail(error);
    console.error('[kernel] feature host recovery failed', error);
  },
  loadFirefoxLifetime: kernelFirefox
    ? () => Promise.resolve(makeFirefoxGuard.firefoxLifetime) : undefined,
});
const controllerGateway = createKernelControllerGateway({
  loadController: runtimeModules.controllerClient,
  controller: {
    browser,
    ensureOffscreen: featureHost.ensureOffscreen,
    offscreenUrl,
    firefoxDirect: kernelFirefox,
    dwebEnabled: DWEB_ENABLED,
    kernelIdentity,
    retireHost: (/** @type {string} */ reason) =>
      featureHost.runtime.retireActiveHost(reason),
    withControllerLease: (/** @type {()=>any} */ operation) =>
      featureHost.runtime.runWithLease('controller', operation, {
        reason: 'controller-demand',
      }),
    withDirectLifetime: (/** @type {()=>any} */ operation, /** @type {any} */ options) => {
      if (!kernelFirefox) return operation();
      if (!firefoxActorLifetime) {
        return Promise.reject(Object.assign(new Error('firefox controller lifetime unavailable'), {
          code: 'controller-firefox-lifetime-unavailable',
          outcomeKnown: true,
          phase: 'startup',
          retryable: true,
        }));
      }
      return firefoxActorLifetime.run(operation, options);
    },
    connectDirectController: kernelFirefox
      ? makeFirefoxGuard?.connectDirectController : undefined,
    fetchFn: packagedFetch,
  },
});
const vault = featureHost.vault;
const kernelSessions = createKernelSessionReader(idb);
const kernelProfile = createKernelProfileAuthority({ idb, sessions: kernelSessions });
const contextSnapshots = createContextSnapshots();
const scriptRuns = createScriptRunRegistry();

const vaultReady = prepareVaultKernel({
  applyPosture: () => applyStoreBootPosture({
    read: async () => (await kv.get(VERSION_STAMP_KEY)) ?? undefined,
    write: (map) => kv.set(VERSION_STAMP_KEY, map),
    block: (blocked) => writeGuard.block(blocked),
  }),
  readSettings: () => settingsStore.load(),
  setAutoLockMs: (/** @type {number} */ value) => { autoLockMs = value; },
  attemptResume: async () => {
    const indexed = await vaultPosture.loadForBoot();
    if (indexed?.initialized === false) return false;
    const boot = await vault.boot(autoLockMs);
    await vaultPosture.write(boot.status);
    return boot.resumed;
  },
  defaultAutoLockMs: DEFAULT_AUTO_LOCK_MS,
});
void vaultReady.then(() => { kernelVaultReadyAt = kernelClockNow(); });
const featureHostReady = vaultReady.then(({ resumed }) =>
  featureHost.settleVaultBoot({ resumed }));
const kernelReady = Promise.all([generation.ready(), vaultReady, featureHostReady]);
void kernelReady.then(() => { kernelReadyAt = kernelClockNow(); });
const ensureDwebFeature = () => featureHost.ensureDwebFeature(kernelReady);
const coldReceipts = createKernelColdReceipts({
  store: {
    get: async (key) => { await vaultReady; return kv.get(key); },
    set: async (key, value) => { await vaultReady; await kv.set(key, value); },
  },
  identity: kernelIdentity,
  firefox: kernelFirefox,
  selfHostedChrome: kernelSelfHostedChrome,
});
const kernelEvents = coldReceipts;
kernelEvents.event(
  'runtime.onInstalled', browser.runtime.onInstalled, 'kernel-vault-posture-install',
)?.addListener((/** @type {any} */ details) => {
  if (details?.reason === 'install') {
    void vaultPosture.markFreshInstall().catch((error) => {
      console.error('[kernel] fresh-install vault posture failed', error);
    });
  }
});
firefoxActorLifetime = kernelFirefox
  ? featureHost.attachFirefoxActorLifetime(kernelEvents)
  : null;
if (firefoxActorLifetime) {
  coldReceipts.registerRecovery({
    event: 'storage.session.onChanged',
    owner: 'kernel-firefox-actor-lifetime',
    reconcile: () => firefoxActorLifetime?.stop(),
  });
}

const kernelUpdateCustody = kernelSelfHostedChrome && targetAddon
  ? targetAddon.update({
    browser, kernelReady, settingsStore, uiPorts, featureHost, offscreenUrl,
  }) : null;
if (kernelUpdateCustody) {
  coldReceipts.registerRecovery({
    event: 'runtime.onUpdateAvailable',
    owner: 'kernel-update-custody',
    reconcile: kernelUpdateCustody.recover,
  });
}

const { closePanel: closeKernelPanel } = attachKernelFrontDoor({
  browser, events: kernelEvents, uiPorts, settingsStore, openHome, ready: vaultReady,
});

const providerProjection = createKernelProviderProjection({
  settingsStore,
  vault,
  browser,
  localModels: !kernelFirefox,
  projectSemantic: async (/** @type {Record<string,any>} */ snapshot) =>
    (await loadDemandPlane()).projectProviderState(snapshot),
  pushState: () => pushState(),
});
let stateProjectionGeneration = 0;
const stateSnapshot = async () => {
  const projectionGeneration = ++stateProjectionGeneration;
  await kernelReady;
  const current = await generation.reconcile();
  if (!current.ok) throw new Error(current.error);
  const indexed = vaultPosture.snapshot() ?? await vaultPosture.read();
  const authority = indexed?.initialized === false && !vault.isInitialized()
    ? {
      initialized: false, prfEnrolled: false, hasRecovery: false,
      locked: true, unlockedAt: 0, lockReason: null,
    }
    : await vault.status();
  if (authority.initialized || indexed?.initialized !== false) {
    await vaultPosture.write(authority);
  }
  const settings = settingsStore.get();
  let session = {
    sessionId: null, messages: [], cost: null,
    permission: { mode: 'act', confirmActions: false },
    provider: null, customSystemPrompt: null, toolManifest: null,
  };
  let profile = null;
  let currentSession = null;
  if (!authority.locked) {
    const sessionId = await sessionCache.sessionGet('currentSessionId');
    currentSession = typeof sessionId === 'string'
      ? await kernelSessions.get(sessionId) : null;
    const mode = await sessionCache.sessionGet('currentPermissionMode');
    const cachedConfirm = await sessionCache.sessionGet('currentConfirmActions');
    const permission = resolveKernelPermission(currentSession, mode, cachedConfirm);
    session = {
      sessionId: currentSession?.sessionId ?? null,
      messages: currentSession?.messages ?? [],
      cost: currentSession?.cost ?? null,
      permission,
      provider: currentSession?.provider ?? null,
      customSystemPrompt: currentSession?.customSystemPrompt ?? null,
      toolManifest: currentSession?.toolManifest ?? null,
    };
    const durableProfile = await kernelProfile.reconcile();
    profile = {
      id: durableProfile.id,
      peerName: durableProfile.peerName,
      onboardingComplete: durableProfile.onboardingComplete,
    };
  }
  const providerView = authority.locked
    ? LOCKED_PROVIDER_AUTHORITY_VIEW
    : await providerProjection.view(currentSession, false);
  return buildVaultKernelState({
    kernel: generation.identity,
    status: {
      initialized: authority.initialized,
      prfEnrolled: authority.prfEnrolled,
      hasRecovery: authority.hasRecovery,
    },
    locked: authority.locked,
    unlockedAt: authority.unlockedAt,
    lockReason: authority.lockReason,
    autoLockMs,
    settings,
    session,
    providers: providerView.providers,
    composer: providerView.composer,
    profile,
    generation: projectionGeneration,
    actorHost: kernelFirefox ? 'background-page-worker' : 'offscreen-document-worker',
  });
};

const pushState = async () => {
  const state = await stateSnapshot();
  const ownerSessionId = typeof state.session?.sessionId === 'string'
    ? state.session.sessionId : null;
  const pendingConfirm = confirmation.coordinator.getPendingForOwner(ownerSessionId);
  uiPorts.broadcast(generation.bind({ type: 'state', state }));
  if (pendingConfirm) uiPorts.broadcast({ type: 'confirm/request', prompt: pendingConfirm });
  return state;
};

const normalizeVoiceEngine = (/** @type {string} */ value) =>
  ['auto', 'web-speech', 'moonshine'].includes(value) ? value : 'auto';
const knownProviderNames = Object.freeze([
  'anthropic', 'openai', 'openrouter', 'ollama', 'glm', 'local-webgpu',
]);
const onKernelSettingsChanging = (/** @type {Record<string,any>} */ patch) => {
  if (patch.dwebEnabled === false) void featureHost.runtime.disable('dweb');
};
const onKernelSettingsChanged = async (/** @type {Record<string,any>} */ patch) => {
  if (Object.hasOwn(patch, 'providerName') || Object.hasOwn(patch, 'providerModel')) {
    providerProjection.bumpRevision();
  }
  if (Object.hasOwn(patch, 'vaultAutoLockMs')) {
    autoLockMs = settingsStore.get().vaultAutoLockMs ?? DEFAULT_AUTO_LOCK_MS;
    if (vault.isInitialized()) await vault.setAutoLockMs(autoLockMs);
  }
  if (patch.voiceEnabled === false) await featureHost.runtime.disable('media');
  if (Object.hasOwn(patch, 'autoUpdateEnabled')) {
    await kernelUpdateCustody?.onSettingsChanged();
  }
  if (patch.dwebEnabled === false) await featureHost.runtime.disable('dweb');
  else if (patch.dwebEnabled === true && !vault.isLocked()) {
    await featureHost.runtime.resume({ dwebEnabled: true });
  }
};
/** @type {Promise<any> | null} */
let featureLockInFlight = null;
const lockFeatureHost = () => {
  if (featureLockInFlight) return featureLockInFlight;
  controllerGateway.retire();
  const run = Promise.resolve(featureHost.vaultLocked()).finally(() => {
    if (featureLockInFlight === run) featureLockInFlight = null;
  });
  featureLockInFlight = run;
  return run;
};
const recoveryCustody = createKernelRecoveryCustody({
  kv,
  alarms: browser.alarms,
  dwebActive: () => DWEB_ENABLED
    && settingsStore.get().dwebEnabled === true
    && settingsStore.get().dwebAgentEnabled === true,
  load: async () => (await getControllerRelays()).resumeSchedules(),
});

const vaultRoutes = makeVaultKernelRoutes({
  ready: kernelReady,
  deps: {
    vault, auditLog, kv, idb, base64ToBytes, purgeVaultBlob, sessionCache,
    pushState,
    VaultAlreadyInitializedError, WrongPassphraseError, VaultNotInitializedError,
    RecoveryPassphraseNotSetError, PrfNotEnrolledError, PrfUnlockFailedError,
    VaultLockedError,
    onInitialized: featureHost.vaultInitialized,
    onUnlocked: async () => {
      await featureHost.vaultUnlocked();
      await recoveryCustody.resume();
    },
    onLocked: lockFeatureHost,
  },
});
const indexedVaultRoutes = makeIndexedVaultRoutes({
  routes: vaultRoutes, posture: vaultPosture, vault, pushState,
});
const routeProvenance = makeKernelRouteProvenance({
  humanUi, homeUi, sidepanelUi, optionsUi, evalUi, appUi, voiceUi,
  actorSpawnUi: notebookUi,
  vaultRoutes: Object.keys(indexedVaultRoutes),
});

const systemReadRoutes = makeSystemReadRoutes({
  vault,
  auditLog,
  sessions: kernelSessions,
  buildStateSnapshot: stateSnapshot,
  uiPorts,
});
const loadProductionRuntimeModule = makeBoundedModuleLoader(
  runtimeModules.productionRuntime,
  {
    timeoutMs: 15_000,
    loadCode: 'kernel-production-runtime-load-failed',
    timeoutCode: 'kernel-production-runtime-load-timeout',
  },
);
/** @type {any} */
let demandPlane = null;
const loadDemandPlane = makeBoundedModuleLoader(async () => {
  const createKernelDemandPlane = await runtimeModules.demandPlane();
  demandPlane = createKernelDemandPlane({
    createProductionRuntime: async (/** @type {any} */ deps) => {
      const [createKernelProductionRuntime, createKernelTurnLiveFactories] = await Promise.all([
        loadProductionRuntimeModule(), runtimeModules.turnFactories(),
      ]);
      return createKernelProductionRuntime({
        ...deps,
        createTurnFactories: createKernelTurnLiveFactories,
      });
    },
    browser, idb, kv, sessionCache, vault, auditLog, settingsStore, uiPorts,
    denylist: denylistPolicy,
    firefox: kernelFirefox,
    dwebEnabled: DWEB_ENABLED,
    firefoxAddon: makeFirefoxGuard,
    loadDirectActorHost: kernelFirefox ? runtimeModules.directActorHost : undefined,
    importArtifactCodec: kernelFirefox ? runtimeModules.artifactCodec : undefined,
    getFirefoxLifetime: () => firefoxActorLifetime,
    featureHost,
    offscreenUrl,
    appTabUrl, notebookTabUrl, vmTabUrl, podTabUrl, optionsUrl,
    isAppSender: appUi,
    isHomeSender: homeUi,
    isNotebookSender: notebookUi,
    isOffscreenSender: offscreenUi,
    isTrustedSender: trusted,
    isOptionsSender: optionsUi,
    isVoiceSender: voiceUi,
    ready: vaultReady,
    vaultReady,
    kernelReady,
    providerProjection,
    pushState,
    postChatNote,
    confirmation: confirmation.coordinator,
    isLockedError: (/** @type {unknown} */ cause) => cause instanceof VaultLockedError,
    settingsDefaults: CHANNEL_DEFAULTS,
    knownProviderNames: [...knownProviderNames],
    normalizeVariant: () => 'base',
    normalizeEngine: normalizeVoiceEngine,
    onSettingsChanging: onKernelSettingsChanging,
    onSettingsChanged: onKernelSettingsChanged,
    sessions: kernelSessions,
    contextSnapshots,
    scriptRuns,
    resolvePermission: resolveKernelPermission,
    runtimeId,
    channel: CHANNEL,
    kernelIdentity,
    controllerGateway,
    fetchFn: packagedFetch,
    ensureDwebFeature,
    getDwebLive: () => dwebCustodyOwner?.getDwebLive() ?? null,
    canWrite: (/** @type {string} */ store) => writeGuard.assertWritable(store),
    ensureBrowserNetworkGuard,
    armBrowserChildQuarantine,
    acquireBrowserNetworkGuardLease,
    releaseBrowserNetworkGuardLease,
    updateBrowserNetworkGuardOrigin,
    networkCustody: () => networkCustody,
    bindNetwork: (/** @type {string} */ projectionGeneration) =>
      networkOwner.bind(projectionGeneration),
    updateBrowserSourceProjection: (/** @type {unknown} */ bindings,
      /** @type {unknown} */ projection, /** @type {any} */ identity) =>
      networkOwner.updateSourceProjection(bindings, projection, identity),
    consumeBrowserChildPolicyNotice: browserChildOutcomes.consume,
    waitForBrowserChildPolicyNotice: browserChildOutcomes.wait,
    hasPendingBrowserChildPolicy: browserChildOutcomes.has,
    childGuard: () => childGuard,
    VaultLockedError,
  });
  return demandPlane;
}, {
  timeoutMs: 15_000,
  loadCode: 'kernel-demand-plane-load-failed',
  timeoutCode: 'kernel-demand-plane-load-timeout',
});
const controllerRelays = () => demandPlane?.controllerRelays() ?? null;
const getControllerRelays = async () => (await loadDemandPlane()).getControllerRelays();
const supportAdmitted = (/** @type {string} */ name, /** @type {any} */ message,
  /** @type {any} */ sender) => routeProvenance.get(name)?.(sender, message) === true;
const loadSessionSupport = makeBoundedModuleLoader(async () => {
  const [createKernelSessionAuthority, createKernelSupportControl] = await Promise.all([
    runtimeModules.sessionAuthority(),
    runtimeModules.supportControl(),
  ]);
  const authority = createKernelSessionAuthority({
    ready: vaultReady,
    vault,
    sessions: kernelSessions,
    contextSnapshots,
    sessionCache,
    auditLog,
    resolvePermission: resolveKernelPermission,
    pushState,
    admitRoute: supportAdmitted,
  });
  /** @type {ReturnType<typeof controllerGateway.bindFeature>|null} */
  let binding = null;
  const control = createKernelSupportControl({
    callFeature: (/** @type {unknown} */ payload, /** @type {any} */ options) => {
      if (!binding) throw new Error('kernel-session-support-binding-unavailable');
      return binding.callFeature(payload, options);
    },
    admit: authority.admit,
    effectAllowed: authority.effectAllowed,
    effects: authority.effects,
  });
  binding = controllerGateway.bindFeature('support', {
    authorize: control.authorize,
    handle: control.handleKernelCall,
  });
  return control;
}, {
  timeoutMs: 15_000,
  loadCode: 'kernel-session-support-load-failed',
  timeoutCode: 'kernel-session-support-load-timeout',
});
const sessionSupportRoutes = makeKernelDemandRoutes({
  names: KERNEL_SESSION_SUPPORT_ROUTE_NAMES,
  loadCode: 'kernel-session-support-routes-load-failed',
  timeoutCode: 'kernel-session-support-routes-load-timeout',
  beforeLoad: makeSessionSupportPreflight({ admit: supportAdmitted, vault, ready: vaultReady }),
  load: async () => (await loadSessionSupport()).routes,
});
const demandRouteNames = Object.freeze([
  ...KERNEL_DEMAND_SUPPORT_ROUTE_NAMES,
  'provider/setKey',
  ...KERNEL_CREDENTIAL_ROUTE_NAMES,
  ...KERNEL_SEMANTIC_OWNER_ROUTE_NAMES,
  ...KERNEL_EXECUTABLE_ROUTE_NAMES,
  ...(DWEB_ENABLED ? KERNEL_DWEB_ROUTE_NAMES : []),
  ...KERNEL_ADMINISTRATIVE_ROUTE_NAMES,
  'debug/originLock',
]);
const demandRoutes = makeKernelDemandRoutes({
  names: demandRouteNames,
  loadCode: 'kernel-demand-routes-load-failed',
  timeoutCode: 'kernel-demand-routes-load-timeout',
  interrupt: {
    name: 'agent/stop', guards: ['agent/send'],
    refusal: () => ({
      ok: false, error: 'agent-send-stopped-before-dispatch',
      code: 'agent-send-stopped-before-dispatch', outcomeKnown: true,
      phase: 'pre-dispatch', retryable: false,
    }),
  },
  load: async () => (await loadDemandPlane()).routes,
});
const disabledDwebRoute = async () => ({
  ok: false, error: 'dweb-disabled', outcomeKnown: true,
});
const disabledDwebRoutes = DWEB_ENABLED ? {} : Object.fromEntries(
  KERNEL_DWEB_ROUTE_NAMES.map((name) => [name, disabledDwebRoute]),
);
const browserDnr = /** @type {any} */ (
  /** @type {any} */ (globalThis).chrome?.declarativeNetRequest
  ?? /** @type {any} */ (browser).declarativeNetRequest
);
const serializedBrowserDnr = browserDnr?.updateSessionRules
  ? makeSerializedDnrSessionRules(browserDnr) : browserDnr;
const startupPopupNetworkGuard = makeStartupPopupNetworkGuard(
  serializedBrowserDnr, PRIVATE_NETWORK_RULE_IDS, {
    loadPending: () => sessionCache.sessionGet('startupPopupCleanup'),
    savePending: (/** @type {{tabId:number,sourceTabId:number}[]} */ rows) =>
      sessionCache.sessionSet('startupPopupCleanup', rows),
    loadTabs: () => browser.tabs.query({}),
    ruleDigests: PRIVATE_NETWORK_RULE_DIGESTS,
  },
);
const networkOwner = createKernelBrowserNetworkOwner({
  firefox: kernelFirefox, browser, dnr: serializedBrowserDnr, sessionCache,
  denylist: denylistPolicy, kernelIdentity, appTabUrl,
  createAuthority: createKernelBrowserNetworkRuntime,
  startupGuard: startupPopupNetworkGuard,
  onPopupBlocked: browserChildOutcomes.recordBlocked,
  onPopupFailed: browserChildOutcomes.recordFailed,
  onPopupBlank: browserChildOutcomes.recordUnverified,
  beginOutcome: browserChildOutcomes.begin,
  containOutcome: browserChildOutcomes.contain,
  settleOutcome: browserChildOutcomes.settle,
  releaseOutcome: browserChildOutcomes.release,
  audit: (/** @type {any} */ entry) => { void auditLog.append(entry).catch(() => {}); },
  releaseChild: (/** @type {number} */ tabId) => childGuard.release(tabId),
  onError: (/** @type {unknown} */ error) => {
    console.error('[kernel] browser network authority failed', error);
  },
});
const {
  custody: networkCustody,
  ensureBrowserNetworkGuard,
  armBrowserChildQuarantine,
  acquireBrowserNetworkGuardLease,
  releaseBrowserNetworkGuardLease,
  updateBrowserNetworkGuardOrigin,
} = networkOwner;
const childGuard = makeFirefoxGuard?.({
  isDrivenSource: (/** @type {number} */ tabId) =>
    networkOwner.relays()?.isDrivenSource?.(tabId) ?? false,
  isSourceReady: () => networkOwner.sourceProjectionReady?.() === true,
  waitForSourceEvidence: (/** @type {number} */ tabId) =>
    startupPopupNetworkGuard.sourceEvidence(tabId),
  waitForSourceAuthority: async (/** @type {number} */ tabId) => {
    if (!await networkOwner.waitForSourceProjection()) {
      throw new Error('kernel-firefox-source-projection-unavailable');
    }
    return networkOwner.relays()?.isDrivenSource?.(tabId) === true;
  },
  ensureSourceAuthority: async (/** @type {number} */ tabId) => {
    if (!await networkOwner.ensureSourceProjection()) {
      throw new Error('kernel-firefox-source-projection-unavailable');
    }
    return networkOwner.relays()?.isDrivenSource?.(tabId) === true;
  },
  onBlocked: (/** @type {any} */ event) => {
    if (typeof event?.flowToken === 'symbol') {
      browserChildOutcomes.recordRequestBlocked(event);
      return;
    }
    const token = browserChildOutcomes.begin(event.sourceTabId, event.tabId);
    browserChildOutcomes.recordRequestBlocked({ ...event, flowToken: token });
    browserChildOutcomes.settle(event.sourceTabId, event.tabId, token);
  },
  isSensitiveHost: (/** @type {string} */ hostname) => denylistPolicy.blocks(hostname),
  isPolicyReady: denylistPolicy.isReady,
  waitForPolicyReady: async () => (await denylistPolicy.ready()).ok === true,
  turnSlots: () => controllerRelays()?.turnSlots,
  webActorSessionForTab: (/** @type {number} */ tabId) =>
    networkOwner.relays()?.webActorSessionForTab?.(tabId) ?? null,
  closeTab: (/** @type {number} */ tabId) => browser.tabs.remove(tabId),
  noteUnavailable: postChatNote,
}) ?? INERT_CHILD_REQUEST_GUARD;
const browserEventOwners = createKernelBrowserEventOwners({
  ready: kernelReady,
  resumeRecovery: recoveryCustody.resume,
  firefox: kernelFirefox,
  receipts: coldReceipts,
  tabCustody: createKernelTabCustody({
    browser, firefox: kernelFirefox, network: networkOwner, child: childGuard,
    getRelays: controllerRelays,
  }),
});
attachKernelLifecycleEvents({
  browser,
  registry: kernelEvents,
  firefox: kernelFirefox,
  selfHostedChrome: kernelSelfHostedChrome,
  onStartup: browserEventOwners.lifecycle.onStartup,
  alarmName: 'peerd-schedule',
  onAlarm: browserEventOwners.lifecycle.onAlarm,
  onUpdateAvailable: kernelSelfHostedChrome
    ? kernelUpdateCustody?.onUpdateAvailable
      ?? (() => Promise.reject(new Error('kernel-update-custody-unavailable')))
    : undefined,
});
attachKernelTabEvents({
  browser,
  registry: kernelEvents,
  firefox: kernelFirefox,
  ...browserEventOwners.tabs,
});
if (kernelFirefox) {
  void browser.tabs.query({}).then((tabs) => childGuard.reconcile(tabs))
    .catch(() => { /* restored exact markers remain fail-closed */ });
}
const targetContributorRoutes = targetAddon?.contributor({
  kv, optionsUi, offscreenUrl, featureHost,
}) ?? {};

const assemblyReport = () => Object.freeze({
  ...createVaultKernelAssemblyReport({
    identity: kernelIdentity,
    firefox: kernelFirefox,
    selfHostedChrome: kernelSelfHostedChrome,
    dweb: DWEB_ENABLED,
    eventOwners: kernelEvents.owners(),
    eventReadiness: {
      ...browserEventOwners.readiness,
      ...(kernelFirefox && !childGuard.ready()
        ? { 'webRequest.onBeforeRequest': false } : {}),
      'runtime.onMessage': SEMANTIC_CUTOVER_SUMMARY.ready,
      'runtime.onConnect': true,
      'runtime.onInstalled': true,
      'runtime.onUpdateAvailable': !!kernelUpdateCustody,
      'storage.session.onChanged': !!firefoxActorLifetime,
      'windows.onFocusChanged': true,
      'action.onClicked': true,
      'commands.onCommand': true,
    },
    portOwners: portOwners.owners,
    portReadiness: portOwners.readiness,
    failClosedPorts: portOwners.failClosedPorts,
  }),
  semantic: SEMANTIC_CUTOVER_SUMMARY,
});

const transferAuthorization = Symbol('kernel-private-transfer');
const privateTransfer = makePrivateTransferPort({
  authorization: transferAuthorization,
  handlers: Object.fromEntries(KERNEL_TRANSFER_ROUTE_NAMES.map((name) => [name, async (
    /** @type {any} */ message = {},
  ) => {
    let routes;
    try {
      routes = await (await loadDemandPlane()).makeTransferRoutes(transferAuthorization);
    } catch (cause) {
      return {
        ok: false,
        error: 'Temporarily unavailable. Try again.',
        code: /** @type {{code?:string}} */ (cause)?.code
          ?? 'kernel-executable-runtime-load-failed',
        outcomeKnown: true,
        phase: 'startup',
        retryable: true,
      };
    }
    try { return await routes[name](message); }
    catch {
      return {
        ok: false,
        error: 'The operation outcome could not be confirmed.',
        code: 'kernel-executable-dispatch-failed',
        outcomeKnown: false,
        outcomeKind: 'unknown',
        retryable: false,
      };
    }
  }])),
});
const attachPrivateTransfer = (/** @type {any} */ port, /** @type {any} */ context = {}) => {
  if (!optionsUi(context.sender ?? port?.sender)) {
    try { port?.disconnect?.(); } catch {}
    try { port?.close?.(); } catch {}
    return false;
  }
  privateTransfer.attach(port);
  return true;
};
const privateTransferRoutes = kernelFirefox ? {} : {
  'private-transfer/open': makePrivateTransferOpenRoute({
    isOptionsSender: optionsUi,
    listWindowClients: async () => {
      const clientsApi = /** @type {any} */ (globalThis).clients;
      return clientsApi?.matchAll ? clientsApi.matchAll({ type: 'window' }) : [];
    },
    optionsUrl,
    attach: privateTransfer.attach,
  }),
};

/** @type {Record<string, (message?: any, sender?: any) => Promise<any>|any>} */
const routes = {
  'bootstrap/ready': async () => {
    const replyFromWorkerTimeOriginMs = kernelClockNow();
    return {
      ok: true,
      kernel: true,
      assembly: assemblyReport(),
      browserCustody: childGuard.status(),
      timing: Object.freeze({
        clock: 'worker-performance-now-diagnostic',
        moduleEvaluationMs: Math.max(0, kernelModuleEvaluatedAt),
        bundleExecutionBeforeKernelMs: Number.isFinite(kernelBundleStartedAt)
          ? Math.max(0, kernelModuleEvaluatedAt - kernelBundleStartedAt) : null,
        vaultReadyAfterModuleMs: kernelVaultReadyAt === null
          ? null : Math.max(0, kernelVaultReadyAt - kernelModuleEvaluatedAt),
        kernelReadyAfterModuleMs: kernelReadyAt === null
          ? null : Math.max(0, kernelReadyAt - kernelModuleEvaluatedAt),
        replyAfterModuleMs: Math.max(0, replyFromWorkerTimeOriginMs - kernelModuleEvaluatedAt),
        replyAfterBundleStartMs: Number.isFinite(kernelBundleStartedAt)
          ? Math.max(0, replyFromWorkerTimeOriginMs - kernelBundleStartedAt) : null,
        replyFromWorkerTimeOriginMs: Math.max(0, replyFromWorkerTimeOriginMs),
      }),
    };
  },
  ...systemReadRoutes,
  ...sessionSupportRoutes,
  ...demandRoutes,
  ...disabledDwebRoutes,
  ...targetContributorRoutes,
  'repository/kernel-fetch': async () => ({
    ok: false, error: 'repository-private-channel-required', outcomeKnown: true,
  }),
  ...makeKernelLearnedOriginRoutes({ kv, auditLog }),
  'sidepanel/close': closeKernelPanel,
  ...indexedVaultRoutes,
  ...confirmation.routes,
  ...privateTransferRoutes,
  'onboarding/complete': async (message = {}) => {
    await vaultReady;
    if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
    const result = await kernelProfile.complete(message);
    if (result.ok) await pushState();
    return result;
  },
  ...makeKernelDenylistRoutes({
    policy: denylistPolicy,
    networkCustody,
    auditLog,
  }),
};

kernelEvents.event(
  'runtime.onMessage', browser.runtime.onMessage, 'vault-kernel-message-router',
)
  .addListener(/** @type {any} */ (makeVaultKernelMessageHandler({
  routes,
  trusted,
  humanUi,
  humanRoutes: new Set(),
  routeProvenance,
  bindReply: generation.bindCurrent,
})));

const broadcastSurfaces = () => {
  const sidePanelOpen = uiPorts.hasNamed('sidepanel');
  uiPorts.broadcast({ type: 'surfaces', sidePanelOpen });
  try {
    void browser.runtime.sendMessage({ type: 'surfaces/changed', sidePanelOpen }).catch(() => {});
  } catch {}
};
const uiPortOwner = createKernelUiPortOwner({
  uiPorts,
  pushState,
  broadcastSurfaces,
  broadcastAgentTab: () => {
    const replay = controllerRelays()?.broadcastAgentTab;
    if (typeof replay === 'function') replay();
    else uiPorts.broadcast({ type: 'agent/tab', tab: null });
  },
  activeGoalStates: () => {
    const replay = controllerRelays()?.activeGoalStates;
    if (typeof replay !== 'function') return [];
    const states = replay();
    return Array.isArray(states) ? states : [];
  },
  onUiConnect: async (/** @type {any} */ port) => {
    await kernelUpdateCustody?.onUiConnect();
    await controllerRelays()?.onUiConnect?.(port);
  },
  onQuiet: async () => {
    await kernelUpdateCustody?.onQuiet();
  },
  getActiveTab: async () => (await browser.tabs.query({ active: true, currentWindow: true }))[0],
  showWebTabHint: (/** @type {number} */ tabId) =>
    controllerRelays()?.showWebTabHint?.(tabId),
});
const dwebCustodyOwner = DWEB_ENABLED ? targetAddon.dwebCustody({
  enabled: true,
  ensureDwebFeature,
  retireDwebHost: () => featureHost.runtime.retireActiveHost('dweb-custody-unknown'),
  active: () => settingsStore.get().dwebEnabled === true,
  vault,
  auditLog,
  listApps: async () => (await loadDemandPlane()).listApps(),
}) : null;
const portOwners = createKernelPortOwners({
  firefox: kernelFirefox, dweb: DWEB_ENABLED,
  attachUi: uiPortOwner.attach,
  attachPrivateTransfer,
  attachFeatureLease: featureHost.handleKeepalive,
  attachDwebCustody: dwebCustodyOwner?.attachDwebCustody,
});
const portRouter = createKernelPortRouter({
  identity: kernelIdentity,
  provenance: {
    'private-transfer': optionsUi,
    sidepanel: sidepanelPortUi,
    home: homeUi,
    eval: evalUi,
    'feature-lease-keepalive': offscreenUi,
    'dweb-custody': offscreenUi,
  },
  handlers: portOwners.handlers,
});
kernelEvents.event(
  'runtime.onConnect', browser.runtime.onConnect, 'kernel-port-router',
)?.addListener((/** @type {any} */ port) => {
  portRouter.route(port);
});

vault.subscribe((event) => {
  void pushState().catch(() => {});
  if (event?.type === 'locked') {
    demandPlane?.abortProviderTests();
    void lockFeatureHost().catch(() => {});
  }
});

void kernelReady.then(() => coldReceipts.recover()).catch((error) => {
  console.error('[kernel] cold receipt recovery failed', error);
});
void kernelUpdateCustody?.start().catch((/** @type {unknown} */ error) => {
  console.error('[kernel] update custody start failed', error);
});
};
