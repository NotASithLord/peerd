// @ts-check

import { createKernelIdentity } from '/shared/kernel-identity.js';
import {
  BROWSER, CHANNEL, CHANNEL_DEFAULTS, CONTROLLER_BUILD_DIGEST, DWEB_ENABLED,
} from '/shared/build-config.js';
import browser from '/shared/browser-api.js';
import { base64ToBytes } from '/shared/cold-util.js';
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
import {
  makeSerializedDnrSessionRules,
  makeStartupPopupNetworkGuard,
} from './startup-popup-network-guard.js';
import { createKernelBrowserNetworkRuntime } from './kernel-browser-network-runtime.js';
import {
  makeKernelLearnedOriginRoutes,
  makeSettingsStore,
} from './settings-store.js';
import { makeKernelSettingsRoutes, normalizeSettingsPatch } from './settings-patch.js';
import { createKernelAppCatalog } from './kernel-app-catalog.js';
import {
  createKernelDenylistPolicy,
  makeKernelComposerRoutes,
  makeKernelDenylistRoutes,
} from './kernel-composer-routes.js';
import {
  attachKernelFrontDoor,
  attachKernelTabEvents,
  attachKernelLifecycleEvents,
  createKernelColdReceipts,
  createKernelBrowserChildOutcomes,
  createKernelConfirmation,
  createKernelBrowserEventOwners,
  createKernelBrowserNetworkOwner,
  createKernelTabCustody,
  createKernelDwebCustodyOwner,
  createKernelExecutableControl,
  createKernelFeatureHost,
  INERT_CHILD_REQUEST_GUARD,
  createKernelPortOwners,
  createKernelPortRouter,
  createKernelSenderPolicy,
  createKernelUiPortOwner,
  makeKernelGenerationLifecycle,
  makeKernelDemandRoutes,
} from './kernel-control-plane.js';
import {
  createKernelAppFileReader,
  createKernelSiteClientRoutes,
  makeKernelAppEditorRoutes,
  makeKernelOpfsPostureRoute,
  makeKernelVmMetaRoute,
  makeKernelVoiceAuditRoute,
} from './kernel-utility-routes.js';
import { createKernelProviderProjection } from './kernel-provider-projection.js';
import {
  createDeferredRepositoryClient,
  createOffscreenRepositoryClient,
  makeRepositoryKernelFetch,
} from './repository-client.js';
import { createKernelKeyedOriginAuthority } from './kernel-keyed-origin-authority.js';
import { createKernelAdministrativeControl } from './kernel-administrative-control.js';
import { createKernelSkillPersistence } from './kernel-skill-persistence.js';
import { createKernelMemoryInitProbe } from './kernel-memory-init-probe.js';
import { makeKernelProviderSetKeyRoute } from './kernel-provider-key-route.js';
import {
  makeKernelGitCredentialRoutes,
  makeKernelOriginCredentialRoutes,
} from './kernel-credential-routes.js';
import { createKernelSemanticRuntime } from './kernel-semantic-runtime.js';
import { createKernelExecutableRuntime } from './kernel-executable-runtime.js';
import {
  createVaultKernelAssemblyReport,
  SEMANTIC_CUTOVER_SUMMARY,
} from './vault-kernel-assembly.js';
import {
  makeKernelRouteProvenance,
  makeVaultKernelMessageHandler,
  makeVaultKernelRoutes,
  makeKernelSessionRoutes,
  makeSystemReadRoutes,
  prepareVaultKernel,
  createVaultPostureIndex,
  createKernelSessionReader,
  createKernelProfileAuthority,
  buildVaultKernelState,
  resolveKernelPermission,
} from './vault-kernel-core.js';
import { openHome } from '/shared/open-home.js';
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
    || typeof targetAddon.update !== 'function' || typeof targetAddon.contributor !== 'function')) {
  throw new Error('kernel-target-addon-invalid');
}
const dwebAddon = /** @type {any} */ (globalThis)[Symbol.for('peerd.kernel.dweb-addon.v1')];
if (DWEB_ENABLED !== !!dwebAddon
    || dwebAddon && typeof dwebAddon.createKernelDwebCustodyRuntime !== 'function') {
  throw new Error('kernel-dweb-addon-invalid');
}
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
  notebookUi, toolboxUi, appUi, offscreenUi, sidepanelPortUi,
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
const vault = featureHost.vault;
const keyedOriginAuthority = createKernelKeyedOriginAuthority(vault);
const kernelSessions = createKernelSessionReader(idb);
const kernelProfile = createKernelProfileAuthority({ idb, sessions: kernelSessions });
const contextSnapshots = Object.freeze({ snapshotsFor: () => [] });
const appCatalog = createKernelAppCatalog({ idb });

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
  const providerView = await providerProjection.view(
    authority.locked ? null : currentSession, authority.locked,
  );
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
  const delivered = { ...state, pendingConfirm };
  uiPorts.broadcast(generation.bind({ type: 'state', state: delivered }));
  if (pendingConfirm) uiPorts.broadcast({ type: 'confirm/request', prompt: pendingConfirm });
  return delivered;
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
const kernelSettingsRoutes = makeKernelSettingsRoutes({
  ready: kernelReady,
  settingsStore,
  defaults: CHANNEL_DEFAULTS,
  knownProviderNames: [...knownProviderNames],
  dwebEnabled: DWEB_ENABLED,
  normalizeVariant: () => 'base',
  normalizeEngine: normalizeVoiceEngine,
  onChanging: onKernelSettingsChanging,
  onChanged: onKernelSettingsChanged,
  pushState: () => { void pushState(); },
});

/** @type {Promise<any> | null} */
let featureLockInFlight = null;
const lockFeatureHost = () => {
  if (featureLockInFlight) return featureLockInFlight;
  const run = Promise.resolve(featureHost.vaultLocked()).finally(() => {
    if (featureLockInFlight === run) featureLockInFlight = null;
  });
  featureLockInFlight = run;
  return run;
};

const vaultRoutes = makeVaultKernelRoutes({
  ready: kernelReady,
  deps: {
    vault, auditLog, kv, idb, base64ToBytes, purgeVaultBlob, sessionCache,
    pushState,
    VaultAlreadyInitializedError, WrongPassphraseError, VaultNotInitializedError,
    RecoveryPassphraseNotSetError, PrfNotEnrolledError, PrfUnlockFailedError,
    VaultLockedError,
    onInitialized: featureHost.vaultInitialized,
    onUnlocked: featureHost.vaultUnlocked,
    onLocked: lockFeatureHost,
  },
});
const indexedVaultRoutes = Object.freeze(Object.fromEntries(
  Object.entries(vaultRoutes).map(([name, handler]) => [name, async (message = {}) => {
    const indexed = vaultPosture.snapshot() ?? await vaultPosture.read();
    if (name === 'vault/prfStatus' && indexed?.initialized === false
        && !vault.isInitialized()) {
      return { ok: true, enrolled: false };
    }
    const result = await handler(message);
    if (result?.ok === true && name !== 'vault/lock') {
      const status = await vault.status();
      await vaultPosture.write(status);
    }
    return result;
  }]),
));

const systemReadRoutes = makeSystemReadRoutes({
  vault,
  auditLog,
  sessions: kernelSessions,
  buildStateSnapshot: stateSnapshot,
  uiPorts,
});

const reloadOpenApp = async (/** @type {string} */ appId) => {
  const tabs = await browser.tabs?.query?.({ url: `${appTabUrl}*` }) ?? [];
  const tab = tabs.find((/** @type {any} */ candidate) => {
    if (typeof candidate?.url !== 'string') return false;
    try {
      return new URL(candidate.url).hash.slice(1).split('?', 1)[0] === appId;
    } catch { return false; }
  });
  if (typeof tab?.id !== 'number') return false;
  await browser.tabs.reload(tab.id);
  return true;
};

/** @template T @param {(lease:any)=>Promise<T>} operation */
const withRepositoryHost = async (operation) => {
  let entered = false;
  const result = await featureHost.runtime.runWithLease('controller', async (lease) => {
    entered = true;
    return operation(lease);
  }, { reason: 'repository-demand' });
  if (!entered) {
    const refusal = /** @type {any} */ (result);
    const error = /** @type {Error & {code?:string,outcomeKnown?:boolean}} */ (
      new Error(refusal?.code ?? 'repository host unavailable')
    );
    error.code = refusal?.code ?? 'repository-host-unavailable';
    error.outcomeKnown = refusal?.outcomeKnown === true;
    throw error;
  }
  return /** @type {T} */ (result);
};
const repositoryAudit = (/** @type {any} */ event) => { void auditLog.append(event).catch(() => {}); };
const repositoryWebFetch = async (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
  const policy = await denylistPolicy.ready();
  const target = new URL(url);
  if (!policy.ok || denylistPolicy.blocks(target.hostname)) {
    throw new Error('Git network request is blocked by the sensitive-origin policy');
  }
  const response = await globalThis.fetch(url, { ...init, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel('Git redirects are blocked').catch(() => {});
    throw new Error('Git redirects are blocked');
  }
  repositoryAudit({ type: 'web_fetch', details: {
    origin: target.origin, path: target.pathname, method: init.method ?? 'GET',
  } });
  return response;
};
const repositoryKernelFetch = makeRepositoryKernelFetch({
  webFetch: repositoryWebFetch,
  getSecret: (name) => vault.getSecret(name),
  audit: repositoryAudit,
});
const repositories = /** @type {any} */ (createDeferredRepositoryClient(async () => {
  if (kernelFirefox) {
    return makeFirefoxGuard.createFirefoxRepositoryClient({
      webFetch: repositoryWebFetch,
      getSecret: (/** @type {string} */ name) => vault.getSecret(name),
      audit: repositoryAudit,
      withLifetime: (/** @type {()=>Promise<any>} */ operation, /** @type {any} */ options) => firefoxActorLifetime
        ? firefoxActorLifetime.run(operation, options) : operation(),
    });
  }
  return createOffscreenRepositoryClient({
    withHost: withRepositoryHost,
    offscreenUrl,
    kernelFetch: repositoryKernelFetch,
    retireHost: (/** @type {string} */ reason) => featureHost.runtime.retireActiveHost(reason),
  });
}));
const providerKeyRoutes = Object.freeze({
  'provider/setKey': makeKernelProviderSetKeyRoute({
    vault, settingsStore, auditLog,
    pushState: async () => {
      providerProjection.bumpRevision();
      await pushState();
    },
  }),
});
const appFiles = createKernelAppFileReader({
  idb, sessionCache, appFiles: /** @type {any} */ (repositories.appFiles),
});
const appEditorRoutes = makeKernelAppEditorRoutes({
  vault,
  catalog: appCatalog,
  files: appFiles,
  repositories,
  isAppSender: appUi,
  reloadApp: reloadOpenApp,
});
const opfsPostureRoute = makeKernelOpfsPostureRoute({
  ready: vaultReady,
  assertWritable: () => writeGuard.assertWritable('opfs-workspaces'),
  isAllowed: (sender) => notebookUi(sender) || offscreenUi(sender),
});
const vmMetaRoute = makeKernelVmMetaRoute({
  ready: vaultReady, idb, settingsStore, isAllowed: trusted,
});
const siteClientRoutes = createKernelSiteClientRoutes({ isAllowed: optionsUi });
const voiceAuditRoute = makeKernelVoiceAuditRoute({ auditLog, isAllowed: voiceUi });
const repositoryRoutes = Object.freeze({
  ...makeKernelGitCredentialRoutes({
    vault, auditLog,
    isLockedError: (/** @type {unknown} */ cause) => cause instanceof VaultLockedError,
  }),
  ...makeKernelOriginCredentialRoutes({
    vault, auditLog, idb,
    isLockedError: (/** @type {unknown} */ cause) => cause instanceof VaultLockedError,
    learnKeyedOrigin: keyedOriginAuthority.add,
    forgetKeyedOrigin: keyedOriginAuthority.remove,
  }),
});
/** @type {ReturnType<typeof createKernelSemanticRuntime>|null} */
let controllerOwner = null;
/** @type {Promise<ReturnType<typeof createKernelSemanticRuntime>>|null} */
let controllerOwnerLoading = null;
/** @type {Promise<any>|null} */
let richOwnerLoading = null;
/** @type {ReturnType<typeof createKernelAdministrativeControl>|null} */
let administrativeControl = null;
const handleRichKernelCall = async (/** @type {string} */ operation,
  /** @type {unknown} */ payload, /** @type {any} */ context) => {
  const handler = controllerRelays()?.handleRichKernelCall;
  return typeof handler === 'function'
    ? handler(operation, payload, context)
    : {
      ok: false, code: 'kernel-rich-effect-unavailable',
      error: 'Feature unavailable. Try again.', outcomeKnown: true,
    };
};
const loadRichOwner = (/** @type {any} */ seams) => {
  richOwnerLoading ??= import('./kernel-production-runtime.js').then((module) =>
    module.createKernelProductionRuntime({
      seams, browser, idb, kv, sessionCache, vault, auditLog, settingsStore, uiPorts,
      pushState, postChatNote, confirmation: confirmation.coordinator,
      denylist: denylistPolicy, repositories, appCatalog,
      bindAppRegistry: appCatalog.bindLiveRegistry,
      getDwebLive: async () => dwebCustodyOwner?.getDwebLive() ?? null,
      ensureDwebFeature,
      ready: kernelReady, vaultReady, featureHost, firefoxActorLifetime,
      firefox: kernelFirefox, dwebEnabled: DWEB_ENABLED, channel: CHANNEL,
      kernelIdentity, offscreenUrl,
      canWrite: (/** @type {string} */ store) => writeGuard.assertWritable(store),
      isOffscreenSender: offscreenUi,
      isTrustedSender: trusted,
      isAppSender: appUi,
      normalizeSettingsPatch,
      knownProviderNames,
      onSettingsChanging: onKernelSettingsChanging,
      onSettingsChanged: onKernelSettingsChanged,
      providerProjection,
      ensureBrowserNetworkGuard,
      armBrowserChildQuarantine,
      acquireBrowserNetworkGuardLease,
      releaseBrowserNetworkGuardLease,
      updateBrowserNetworkGuardOrigin,
      syncDenylistNetwork: networkCustody.sync,
      networkCustody,
      consumeBrowserChildPolicyNotice: browserChildOutcomes.consume,
      waitForBrowserChildPolicyNotice: browserChildOutcomes.wait,
      hasPendingBrowserChildPolicy: browserChildOutcomes.has,
    })
  ).then((owner) => {
    networkOwner.bind(owner.relays);
    return owner;
  }).catch((cause) => {
    richOwnerLoading = null;
    throw cause;
  });
  return richOwnerLoading;
};
const loadControllerOwner = () => {
  if (controllerOwner) return Promise.resolve(controllerOwner);
  controllerOwnerLoading ??= Promise.resolve().then(() => {
    controllerOwner = createKernelSemanticRuntime({
      browser, idb, kv, auditLog, vault, ready: vaultReady, pushState,
      appCatalog, appFiles, reloadApp: reloadOpenApp, appTabUrl, sessionCache,
      repositories, settingsStore, sessions: kernelSessions, featureHost,
      localModels: !kernelFirefox, providerProjection,
      keyedOriginAuthority,
      authorizeFeatureCall: (/** @type {unknown} */ payload) =>
        administrativeControl?.authorize(payload) ?? null,
      handleFeatureKernelCall: (/** @type {string} */ operation,
        /** @type {unknown} */ payload, /** @type {any} */ context) =>
        administrativeControl?.handleKernelCall(operation, payload, context)
          ?? { ok: false, code: 'kernel-operation-denied', outcomeKnown: true },
      handleRichKernelCall,
      isAppSender: appUi,
      canWrite: (/** @type {string} */ store) => writeGuard.assertWritable(store),
      isHomeSender: homeUi,
      loadTurnRuntime: async (/** @type {any} */ seams) =>
        (await loadRichOwner(seams)).turnRuntime,
      ensureOffscreen: featureHost.ensureOffscreen,
      offscreenUrl, firefox: kernelFirefox, dwebEnabled: DWEB_ENABLED, kernelIdentity,
      retireHost: (/** @type {string} */ reason) =>
        featureHost.runtime.retireActiveHost(reason),
      withControllerLease: (/** @type {()=>any} */ operation) =>
        featureHost.runtime.runWithLease(
          'controller', operation, { reason: 'semantic-demand' },
        ),
      withDirectLifetime: (/** @type {()=>any} */ operation, /** @type {any} */ options) =>
        firefoxActorLifetime ? firefoxActorLifetime.run(operation, options) : operation(),
      connectDirectController: kernelFirefox
        ? makeFirefoxGuard.connectDirectController : undefined,
      fetchFn: packagedFetch,
    });
    return controllerOwner;
  }).catch((cause) => {
    controllerOwnerLoading = null;
    throw cause;
  });
  return controllerOwnerLoading;
};
const getControllerRelays = async () => (await loadControllerOwner()).getRelays();
const controllerRelays = () => controllerOwner?.relays;
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
  denylist: denylistPolicy, getRelays: controllerRelays,
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
    controllerRelays()?.webActorSessionForTab?.(tabId) ?? null,
  closeTab: (/** @type {number} */ tabId) => browser.tabs.remove(tabId),
  noteUnavailable: postChatNote,
}) ?? INERT_CHILD_REQUEST_GUARD;
const browserEventOwners = createKernelBrowserEventOwners({
  ready: kernelReady,
  resumeSchedules: async () => (await getControllerRelays()).resumeSchedules(),
  firefox: kernelFirefox,
  receipts: coldReceipts,
  tabCustody: createKernelTabCustody({
    browser, firefox: kernelFirefox, network: networkOwner, child: childGuard,
    getRelays: controllerRelays, loadRelays: getControllerRelays,
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
const semanticOwnerRoutes = Object.freeze([
  'actor-isolation/retry', 'actor/spawn', 'agent/send', 'agent/stop',
  'actors/count', 'actors/overview', 'app/get-meta', 'apps/favorite', 'apps/list',
  'apps/open', 'apps/rename', 'contacts/forget', 'contacts/list', 'contacts/set',
  'memory/delete', 'memory/deleteAll', 'memory/export', 'memory/suggestions',
  'memory/suggestions/approve', 'memory/suggestions/dismiss', 'memory/write',
  'provider/status', 'skills/list', 'skills/remove', 'skills/setEnabled',
  'provider/test', 'models/options', 'openrouter/models',
  'local-model/catalog', 'local-model/init', 'local-model/probe', 'local-model/status',
  'apps/repository/status', 'apps/repository/history', 'apps/repository/diff',
  'apps/repository/commit', 'apps/repository/restore', 'apps/repository/branch',
  'apps/repository/checkout', 'apps/repository/link', 'apps/repository/fetch',
  'apps/repository/push', 'apps/import-git',
  'session/archive', 'session/debugBundle', 'session/reset', 'session/switch',
  'toolbox/read', 'toolbox/record',
]);
const vaultOptionalControllerRoutes = new Set([
  'provider/test', 'models/options', 'openrouter/models',
  'local-model/catalog', 'local-model/init', 'local-model/probe', 'local-model/status',
]);
const semanticRoutes = Object.freeze({
  ...makeKernelDemandRoutes({
    names: semanticOwnerRoutes,
    loadCode: 'kernel-semantic-owner-load-failed',
    timeoutCode: 'kernel-semantic-owner-load-timeout',
    interrupt: {
      name: 'agent/stop', guards: ['agent/send'],
      refusal: () => ({
        ok: false,
        error: 'agent-send-stopped-before-dispatch',
        code: 'agent-send-stopped-before-dispatch',
        outcomeKnown: true,
        phase: 'pre-dispatch',
        retryable: false,
      }),
    },
    beforeLoad: async (name) => {
      if (name.startsWith('toolbox/') || vaultOptionalControllerRoutes.has(name)) return null;
      if (kernelFirefox && ['actor/spawn', 'agent/send'].includes(name)
          && !childGuard.ready()) {
        return {
          ok: false, error: 'Web automation paused. Retry.',
          code: 'firefox-child-custody-unavailable', outcomeKnown: true,
          retryable: true, phase: 'startup',
        };
      }
      try { await vaultReady; }
      catch {
        return {
          ok: false, error: 'Temporarily unavailable. Try again.',
          code: 'kernel-semantic-startup-failed', outcomeKnown: true,
          retryable: true, phase: 'startup',
        };
      }
      return vault.isLocked() ? { ok: false, error: 'vault-locked' } : null;
    },
    load: async () => (await loadControllerOwner()).routes,
  }),
  ...makeKernelDemandRoutes({
    names: ['debug/originLock'],
    loadCode: 'kernel-debug-owner-load-failed',
    timeoutCode: 'kernel-debug-owner-load-timeout',
    load: async () => {
      const relays = await getControllerRelays();
      return { 'debug/originLock': relays.debugOriginLock };
    },
  }),
  ...(targetAddon?.contributor({
    kv, optionsUi, offscreenUrl, featureHost,
  }) ?? {}),
});

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

const getRichOwner = async () => {
  await getControllerRelays();
  if (!richOwnerLoading) throw new Error('kernel-rich-owner-unavailable');
  return richOwnerLoading;
};
const executableOwner = createKernelExecutableControl({
  runtimeId,
  firefox: kernelFirefox,
  dweb: DWEB_ENABLED,
  createRuntime: createKernelExecutableRuntime,
  loadRich: getRichOwner,
  dispatchRuntimeRelay: async (/** @type {string} */ route, /** @type {unknown} */ message) =>
    (await loadControllerOwner()).runtime.relay(route, message),
  owns: {
    home: homeUi, options: optionsUi, offscreen: offscreenUi,
    app: appUi,
  },
  paths: {
    app: appTabUrl, notebook: notebookTabUrl, vm: vmTabUrl, pod: podTabUrl, options: optionsUrl,
  },
});

const skillPersistence = createKernelSkillPersistence({
  canWrite: () => writeGuard.assertWritable('skills'),
  audit: auditLog.append,
  pushState,
});
const memoryInitProbe = createKernelMemoryInitProbe({
  tabs: browser.tabs,
  scripting: browser.scripting,
  resolveTab: async (/** @type {any} */ tab) => {
    if (typeof tab?.id !== 'number') return null;
    const [identity] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => globalThis.location.href,
    });
    const current = await browser.tabs.get(tab.id);
    const documentId = /** @type {{documentId?:unknown}|undefined} */ (identity)?.documentId;
    if (typeof documentId !== 'string'
        || typeof identity?.result !== 'string'
        || identity.result !== current?.url) return null;
    return { ...current, peerdDocumentId: documentId };
  },
});
administrativeControl = createKernelAdministrativeControl({
  callFeature: async (payload, options) =>
    /** @type {any} */ ((await loadControllerOwner()).controller).callFeature(payload, options),
  kv,
  idb: /** @type {any} */ (idb),
  auditLog,
  canWrite: (store) => writeGuard.assertWritable(store),
  commitSkill: skillPersistence.commit,
  probeMemoryTab: memoryInitProbe.probeTab,
  listApps: () => appCatalog.list(),
  confirm: confirmation.coordinator.confirm,
  currentSessionId: () => sessionCache.sessionGet('currentSessionId'),
  assertMemoryInitAllowed: async () => {
    if (vault.isLocked()) throw new VaultLockedError();
    if (!(await denylistPolicy.ready()).ok) throw new Error('denylist policy unavailable');
  },
  postChatNote,
});

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
  'lifecycle/assert-opfs-writable': opfsPostureRoute,
  'vm/get-meta': vmMetaRoute,
  ...repositoryRoutes,
  ...appEditorRoutes,
  'repository/kernel-fetch': async () => ({
    ok: false, error: 'repository-private-channel-required', outcomeKnown: true,
  }),
  ...makeKernelLearnedOriginRoutes({ kv, auditLog }),
  'sidepanel/close': closeKernelPanel,
  ...kernelSettingsRoutes,
  ...indexedVaultRoutes,
  ...makeKernelSessionRoutes({
    vault, sessions: kernelSessions, contextSnapshots,
    ready: vaultReady, sessionCache, auditLog,
    resolvePermission: resolveKernelPermission, pushState,
  }),
  ...confirmation.routes,
  ...executableOwner.routes,
  ...semanticRoutes,
  ...siteClientRoutes,
  'onboarding/complete': async (message = {}) => {
    await vaultReady;
    if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
    const result = await kernelProfile.complete(message);
    if (result.ok) await pushState();
    return result;
  },
  'audit/voice-fetch': voiceAuditRoute,
  ...providerKeyRoutes,
  ...makeKernelComposerRoutes({
    browser, kv, idb, sessionCache, vault, denylist: denylistPolicy, appFiles,
  }),
  ...administrativeControl.routes,
  ...makeKernelDenylistRoutes({
    policy: denylistPolicy,
    networkCustody,
    auditLog,
  }),
};

const routeProvenance = makeKernelRouteProvenance({
  humanUi, homeUi, sidepanelUi, optionsUi, evalUi, appUi, voiceUi, toolboxUi,
  actorSpawnUi: notebookUi,
  vaultRoutes: Object.keys(indexedVaultRoutes),
});

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
  onQuiet: () => kernelUpdateCustody?.onQuiet(),
  getActiveTab: async () => (await browser.tabs.query({ active: true, currentWindow: true }))[0],
  showWebTabHint: (/** @type {number} */ tabId) =>
    controllerRelays()?.showWebTabHint?.(tabId),
});
const dwebCustodyOwner = DWEB_ENABLED ? createKernelDwebCustodyOwner({
  enabled: true,
  load: async () => dwebAddon.createKernelDwebCustodyRuntime({
      enabled: DWEB_ENABLED,
      ensureDwebFeature,
      active: () => settingsStore.get().dwebEnabled === true,
      vault,
      auditLog,
      listApps: () => appCatalog.list(),
      sendMessage: (/** @type {any} */ message) => browser.runtime.sendMessage(message),
    }),
}) : null;
const portOwners = createKernelPortOwners({
  firefox: kernelFirefox, dweb: DWEB_ENABLED,
  attachUi: uiPortOwner.attach,
  attachPrivateTransfer: executableOwner.attachPrivateTransfer ?? undefined,
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
    controllerOwner?.abortProviderTests?.();
    void lockFeatureHost().catch(() => {});
  }
});

void kernelReady.then(() => coldReceipts.recover()).catch((error) => {
  console.error('[kernel] cold receipt recovery failed', error);
});
void kernelUpdateCustody?.start().catch((/** @type {unknown} */ error) => {
  console.error('[kernel] update custody start failed', error);
});
