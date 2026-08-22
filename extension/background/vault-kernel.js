// @ts-check

import {
  isEvalSender,
  isFirstPartySender,
  isHomeSender,
  isOffscreenSender,
  isOptionsSender,
  isSidepanelPortSender,
  isSidepanelSender,
} from '/shared/sender-trust.js';
import { createKernelIdentity } from '/shared/kernel-identity.js';
import {
  BROWSER, CHANNEL_DEFAULTS, CONTROLLER_BUILD_DIGEST, DWEB_ENABLED,
} from '/shared/build-config.js';
import browser from '/shared/browser-api.js';
import { base64ToBytes } from '/shared/cold-util.js';
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
  makeKernelLearnedOriginRoutes,
  makeSettingsStore,
} from './settings-store.js';
import { makeKernelSettingsRoutes } from './settings-patch.js';
import { makeKernelGenerationLifecycle } from './kernel-generation.js';
import { createKernelColdReceipts } from './kernel-cold-receipts.js';
import {
  createKernelAppCatalog,
  makeKernelAppCatalogRoutes,
} from './kernel-app-catalog.js';
import {
  createKernelDenylistNetworkCustody,
  createKernelDenylistPolicy,
  createKernelSkillsAuthority,
  makeKernelComposerRoutes,
  makeKernelDenylistRoutes,
} from './kernel-composer-routes.js';
import { createKernelFrontDoor } from './kernel-front-door.js';
import { attachKernelLifecycleEvents } from './kernel-lifecycle-events.js';
import { attachKernelTabEvents } from './kernel-tab-events.js';
import { createKernelFeatureHost } from './kernel-feature-host.js';
import { createKernelPortRouter } from './kernel-port-router.js';
import {
  makeKernelGitCredentialRoutes,
  makeKernelOriginCredentialRoutes,
  makeKernelRepositoryReadRoutes,
} from './kernel-repository-read-routes.js';
import {
  createKernelLocalRoutes,
  createKernelSemanticRoutes,
} from './kernel-local-routes.js';
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
const targetAddon = /** @type {any} */ (globalThis)[Symbol.for('peerd.kernel.target-addon.v1')];
if (targetAddon && (targetAddon.target !== 'preview-chrome'
    || typeof targetAddon.update !== 'function' || typeof targetAddon.contributor !== 'function')) {
  throw new Error('kernel-target-addon-invalid');
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
const offscreenPath = 'offscreen/offscreen.html';
const offscreenUrl = browser.runtime.getURL(offscreenPath);
const appTabUrl = browser.runtime.getURL('engine-tabs/app-tab/index.html');
const packagedFetch = (/** @type {string|URL|Request} */ input,
  /** @type {RequestInit|undefined} */ init = undefined) => globalThis.fetch(input, init);
const trusted = (/** @type {any} */ sender) => isFirstPartySender(sender, {
  runtimeId, extensionOrigin,
});
const sidepanelUi = (/** @type {any} */ sender) =>
  isSidepanelSender(sender, { runtimeId, extensionOrigin, sidepanelUrl });
const humanUi = (/** @type {any} */ sender) => sidepanelUi(sender)
  || isHomeSender(sender, { runtimeId, extensionOrigin, homeUrl });
const optionsUi = (/** @type {any} */ sender) => isOptionsSender(sender, {
  runtimeId, extensionOrigin, optionsUrl,
});
const voiceUi = (/** @type {any} */ sender) => sidepanelUi(sender) || optionsUi(sender);
const appUi = (/** @type {any} */ sender, /** @type {string} */ appId) => {
  if (sender?.id !== runtimeId || typeof sender?.tab?.id !== 'number') return false;
  const raw = sender.url ?? sender.tab.url;
  try {
    const url = new URL(raw);
    const expected = new URL(appTabUrl);
    return url.origin === expected.origin && url.pathname === expected.pathname
      && url.search === '' && decodeURIComponent(url.hash.slice(1).split('?', 1)[0]) === appId;
  } catch { return false; }
};

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
    ? () => import('./firefox-storage-keepalive.js') : undefined,
});
const vault = featureHost.vault;
const kernelSessions = createKernelSessionReader(idb);
const kernelProfile = createKernelProfileAuthority({ idb, sessions: kernelSessions });
const kernelActorRoutes = Object.freeze({
  'actors/count': (/** @type {any} */ _message = {}, /** @type {any} */ sender = undefined) => {
    if (!isHomeSender(sender, { runtimeId, extensionOrigin, homeUrl })) {
      return { ok: false, error: 'actor-overview-unauthorized' };
    }
    if (vault.isLocked()) return { ok: false, error: 'locked' };
    return { ok: true, activeActors: 0, observedAt: Date.now() };
  },
  'actors/overview': (/** @type {any} */ _message = {}, /** @type {any} */ sender = undefined) => {
    if (!isHomeSender(sender, { runtimeId, extensionOrigin, homeUrl })) {
      return { ok: false, error: 'actor-overview-unauthorized' };
    }
    if (vault.isLocked()) return { ok: false, error: 'locked' };
    return { ok: true, roots: [], observedAt: Date.now() };
  },
});
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
const unavailableColdOwner = (/** @type {string} */ event) => () =>
  Promise.reject(new Error(`kernel-owner-not-migrated:${event}`));
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

attachKernelLifecycleEvents({
  browser,
  registry: kernelEvents,
  firefox: false,
  selfHostedChrome: kernelSelfHostedChrome,
  onStartup: unavailableColdOwner('runtime.onStartup'),
  alarmName: 'peerd-schedule',
  onAlarm: unavailableColdOwner('alarms.onAlarm'),
  onUpdateAvailable: kernelSelfHostedChrome
    ? kernelUpdateCustody?.onUpdateAvailable
      ?? unavailableColdOwner('runtime.onUpdateAvailable')
    : undefined,
});
attachKernelTabEvents({
  browser,
  registry: kernelEvents,
  firefox: false,
  onCreated: unavailableColdOwner('tabs.onCreated'),
  onUpdated: unavailableColdOwner('tabs.onUpdated'),
  onRemoved: unavailableColdOwner('tabs.onRemoved'),
  onActivated: unavailableColdOwner('tabs.onActivated'),
  onNavigationTarget: unavailableColdOwner('webNavigation.onCreatedNavigationTarget'),
});

const closeKernelPanel = async () => {
  try {
    if (browser.sidebarAction?.close) {
      await browser.sidebarAction.close();
      return { ok: true };
    }
    const sidePanel = /** @type {any} */ (browser).sidePanel;
    if (sidePanel?.setOptions) {
      await sidePanel.setOptions({ enabled: false });
      setTimeout(() => {
        sidePanel.setOptions({
          enabled: true, path: 'sidepanel/sidepanel.html',
        }).catch(() => {});
      }, 250);
      return { ok: true };
    }
    return { ok: false, error: 'no-sidepanel' };
  } catch (error) {
    return {
      ok: false,
      error: /** @type {{message?:string}} */ (error)?.message ?? String(error),
    };
  }
};
const frontDoor = createKernelFrontDoor({
  browser,
  coldEvent: (key, event) => kernelEvents.event(key, event, 'kernel-front-door'),
  isHomeOpen: () => uiPorts.hasNamed('home'),
  isPanelOpen: () => uiPorts.hasNamed('sidepanel'),
  getFrontDoorView: () => settingsStore.get().frontDoorView === 'home' ? 'home' : 'panel',
  closePanel: closeKernelPanel,
  openHome,
});
coldReceipts.registerRecovery({
  event: 'windows.onFocusChanged',
  owner: 'kernel-front-door',
  reconcile: () => frontDoor.refreshFocus(),
});
void vaultReady.then(() => frontDoor.syncNativeBehavior()).catch(() => {});

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
  uiPorts.broadcast(generation.bind({ type: 'state', state }));
  return state;
};

const normalizeVoiceEngine = (/** @type {string} */ value) =>
  ['auto', 'web-speech', 'moonshine'].includes(value) ? value : 'auto';
const kernelSettingsRoutes = makeKernelSettingsRoutes({
  ready: kernelReady,
  settingsStore,
  defaults: CHANNEL_DEFAULTS,
  knownProviderNames: [
    'anthropic', 'openai', 'openrouter', 'ollama', 'glm', 'local-webgpu',
  ],
  dwebEnabled: DWEB_ENABLED,
  normalizeVariant: () => 'base',
  normalizeEngine: normalizeVoiceEngine,
  onChanging: (patch) => {
    if (patch.dwebEnabled === false) void featureHost.runtime.disable('dweb');
  },
  onChanged: async (patch) => {
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
  },
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
const repositories = /** @type {any} */ (kernelFirefox
  ? createDeferredRepositoryClient(async () => {
    const { createFirefoxRepositoryClient } = await import('./repository-local-client.js');
    return createFirefoxRepositoryClient({
      webFetch: repositoryWebFetch,
      getSecret: (name) => vault.getSecret(name),
      audit: repositoryAudit,
      withLifetime: (operation, options) => firefoxActorLifetime
        ? firefoxActorLifetime.run(operation, options) : operation(),
    });
  })
  : createOffscreenRepositoryClient({
    withHost: withRepositoryHost,
    offscreenUrl,
    kernelFetch: repositoryKernelFetch,
    retireHost: (/** @type {string} */ reason) => featureHost.runtime.retireActiveHost(reason),
  }));
const kernelLocal = createKernelLocalRoutes({
  vault, auditLog, pushState,
  ready: vaultReady, settingsStore, fetchFn: globalThis.fetch.bind(globalThis),
  sessions: kernelSessions, browser, localModels: !kernelFirefox,
  featureHost, offscreenUrl, providerProjection,
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
  isAllowed: (sender) => {
    const source = /** @type {any} */ (sender);
    const senderUrl = source?.url ?? source?.tab?.url;
    const notebook = typeof source?.tab?.id === 'number' && typeof senderUrl === 'string'
      && senderUrl.split(/[?#]/, 1)[0] === notebookTabUrl;
    return notebook || isOffscreenSender(source, {
      runtimeId, extensionOrigin, offscreenUrl,
    });
  },
});
const vmMetaRoute = makeKernelVmMetaRoute({
  ready: vaultReady, idb, settingsStore, isAllowed: trusted,
});
const siteClientRoutes = createKernelSiteClientRoutes({ isAllowed: optionsUi });
const voiceAuditRoute = makeKernelVoiceAuditRoute({ auditLog, isAllowed: voiceUi });
const semanticRoutes = Object.freeze({
  ...createKernelSemanticRoutes({
    idb, kv, auditLog, vault, ready: vaultReady,
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
    eventOwners: kernelEvents.owners(),
    eventReadiness: {
      'runtime.onMessage': SEMANTIC_CUTOVER_SUMMARY.ready,
      'runtime.onConnect': !kernelFirefox && !kernelSelfHostedChrome,
      'runtime.onInstalled': true,
      'runtime.onStartup': false,
      'runtime.onUpdateAvailable': !!kernelUpdateCustody,
      'alarms.onAlarm': false,
      'storage.session.onChanged': !!firefoxActorLifetime,
      'tabs.onCreated': false,
      'tabs.onUpdated': false,
      'tabs.onRemoved': false,
      'tabs.onActivated': false,
      'webNavigation.onCreatedNavigationTarget': false,
      'webRequest.onBeforeRequest': false,
      'windows.onFocusChanged': true,
      'action.onClicked': true,
      'commands.onCommand': true,
    },
    portReadiness: {
      sidepanel: false,
      home: false,
      eval: false,
      'feature-lease-keepalive': !kernelFirefox,
    },
  }),
  semantic: SEMANTIC_CUTOVER_SUMMARY,
});

/** @type {Record<string, (message?: any, sender?: any) => Promise<any>|any>} */
const routes = {
  'bootstrap/ready': async () => {
    const replyFromWorkerTimeOriginMs = kernelClockNow();
    return {
      ok: true,
      kernel: true,
      assembly: assemblyReport(),
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
  ...makeKernelAppCatalogRoutes({
    vault, idb, catalog: appCatalog, reloadApp: reloadOpenApp,
    browser, appTabUrl, sessionCache, isAppSender: appUi,
    appFiles, dwebEnabled: DWEB_ENABLED,
  }),
  'vm/get-meta': vmMetaRoute,
  ...makeKernelRepositoryReadRoutes({
    browser,
    vault,
    catalog: appCatalog,
    repositories,
    auditLog,
    appTabUrl,
    appFiles,
    sessionCache,
    allowDweb: DWEB_ENABLED,
  }),
  ...makeKernelGitCredentialRoutes({
    vault, auditLog, isLockedError: (/** @type {unknown} */ cause) => cause instanceof VaultLockedError,
  }),
  ...makeKernelOriginCredentialRoutes({
    vault, auditLog, idb,
    isLockedError: (/** @type {unknown} */ cause) => cause instanceof VaultLockedError,
  }),
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
  'provider/setKey': kernelLocal.providerSetKey,
  'provider/test': kernelLocal.providerTest,
  'models/options': kernelLocal.modelOptions,
  'openrouter/models': kernelLocal.openRouterModels,
  ...kernelLocal.localModelRoutes,
  ...kernelActorRoutes,
  ...makeKernelComposerRoutes({
    browser, kv, idb, sessionCache, vault, denylist: denylistPolicy, appFiles,
  }),
  ...createKernelSkillsAuthority({
    canWrite: () => writeGuard.assertWritable('skills'),
    audit: auditLog.append,
    pushState,
  }).routes,
  ...makeKernelDenylistRoutes({
    policy: denylistPolicy,
    networkCustody: createKernelDenylistNetworkCustody({
      dnr: /** @type {any} */ (browser).declarativeNetRequest,
    }),
    auditLog,
  }),
};

const routeProvenance = makeKernelRouteProvenance({
  humanUi, optionsUi, appUi, voiceUi, vaultRoutes: Object.keys(indexedVaultRoutes),
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

const attachUiPort = (/** @type {any} */ port) => {
  uiPorts.add(port);
  port.onDisconnect.addListener(() => {
    uiPorts.remove(port);
    void kernelUpdateCustody?.onQuiet().catch(() => {});
  });
  void pushState().catch(() => {});
  void kernelUpdateCustody?.onUiConnect().catch(() => {});
};
const portRouter = createKernelPortRouter({
  identity: kernelIdentity,
  provenance: {
    'private-transfer': (sender) => isOptionsSender(sender, {
      runtimeId, extensionOrigin, optionsUrl,
    }),
    sidepanel: (sender) => isSidepanelPortSender(sender, {
      runtimeId, extensionOrigin, sidepanelUrl,
    }),
    home: (sender) => isHomeSender(sender, {
      runtimeId, extensionOrigin, homeUrl,
    }),
    eval: (sender) => isEvalSender(sender, {
      runtimeId, extensionOrigin, homeUrl, evalRunnerUrl,
    }),
    'feature-lease-keepalive': (sender) => isOffscreenSender(sender, {
      runtimeId, extensionOrigin, offscreenUrl,
    }),
    'dweb-custody': (sender) => isOffscreenSender(sender, {
      runtimeId, extensionOrigin, offscreenUrl,
    }),
  },
  handlers: {
    sidepanel: attachUiPort,
    home: attachUiPort,
    eval: attachUiPort,
    'feature-lease-keepalive': featureHost.handleKeepalive,
  },
});
kernelEvents.event(
  'runtime.onConnect', browser.runtime.onConnect, 'kernel-port-router',
)?.addListener((/** @type {any} */ port) => {
  portRouter.route(port);
});

vault.subscribe((event) => {
  void pushState().catch(() => {});
  if (event?.type === 'locked') {
    kernelLocal.abortProviderTests();
    void lockFeatureHost().catch(() => {});
  }
});

void kernelReady.then(() => coldReceipts.recover()).catch((error) => {
  console.error('[kernel] cold receipt recovery failed', error);
});
void kernelUpdateCustody?.start().catch((/** @type {unknown} */ error) => {
  console.error('[kernel] update custody start failed', error);
});
