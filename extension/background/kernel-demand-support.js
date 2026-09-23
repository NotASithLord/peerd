// @ts-check

import { createKernelAppCatalog } from './kernel-app-catalog.js';
import {
  createDeferredRepositoryClient,
  createOffscreenRepositoryClient,
  makeRepositoryKernelFetch,
} from './repository-client.js';
import { createKernelKeyedOriginAuthority } from './kernel-keyed-origin-authority.js';
import {
  createKernelAppFileReader,
  createKernelSiteClientRoutes,
  makeKernelAppEditorRoutes,
  makeKernelOpfsPostureRoute,
  makeKernelVmMetaRoute,
  makeKernelVoiceAuditRoute,
} from './kernel-utility-routes.js';
import { makeKernelComposerRoutes } from './kernel-composer-routes.js';
import {
  makeKernelGitCredentialRoutes,
  makeKernelOriginCredentialRoutes,
} from './kernel-credential-routes.js';
import { makeKernelProviderSetKeyRoute } from './kernel-provider-key-route.js';
import { makeKernelSettingsRoutes, normalizeSettingsPatch } from './settings-patch.js';
import { KERNEL_DEMAND_SUPPORT_ROUTE_NAMES } from '../shared/kernel-feature-route-inventory.js';
import { createOriginPacingStore } from '/peerd-runtime/pacing-authority.js';
import { normalizeApiOrigin } from '../shared/api-origin.js';
import { makePacedOriginRoutes } from './routes/paced-origins.js';

/** @param {Record<string,any>} deps */
export const createKernelDemandSupport = (deps) => {
  // why: one kernel-generation owner serves both browser actions and network
  // requests. Controller/actor recreation must never create a fresh empty lane.
  const originPacing = createOriginPacingStore({
    kv: deps.kv,
    onAudit: (event) => { void deps.auditLog.append(event).catch(() => {}); },
    onWait: (info) => {
      void deps.sessionCache.sessionGet('currentSessionId').then((/** @type {string|null} */ sessionId) => {
        if (sessionId) deps.uiPorts.broadcast({ type: 'turn/pacing-wait', sessionId, ...info });
      }).catch(() => {});
    },
  });
  void originPacing.hydrate();
  const appCatalog = createKernelAppCatalog({ idb: deps.idb });
  const keyedOriginAuthority = createKernelKeyedOriginAuthority(deps.vault);
  const repositoryKernelFetch = makeRepositoryKernelFetch({
    webFetch: deps.repositoryWebFetch,
    getSecret: (/** @type {string} */ name) => deps.vault.getSecret(name),
    audit: deps.repositoryAudit,
  });
  const repositories = /** @type {any} */ (createDeferredRepositoryClient(async () => {
    if (deps.firefox) {
      return deps.createFirefoxRepositoryClient({
        webFetch: deps.repositoryWebFetch,
        getSecret: (/** @type {string} */ name) => deps.vault.getSecret(name),
        audit: deps.repositoryAudit,
        withLifetime: deps.withFirefoxLifetime,
      });
    }
    return createOffscreenRepositoryClient({
      withHost: deps.withRepositoryHost,
      offscreenUrl: deps.offscreenUrl,
      kernelFetch: repositoryKernelFetch,
      retireHost: deps.retireRepositoryHost,
    });
  }));
  const appFiles = createKernelAppFileReader({
    idb: deps.idb,
    sessionCache: deps.sessionCache,
    appFiles: /** @type {any} */ (repositories.appFiles),
  });
  const directRoutes = Object.freeze({
    ...makePacedOriginRoutes({ originPacing, normalizeApiOrigin }),
    'debug/pacing': async (/** @type {any} */ message = {}) => {
      const origin = normalizeApiOrigin(message.origin);
      if (deps.settingsStore.get().devMode === true && origin && typeof message.status === 'number') {
        await originPacing.observe({ origin, responseAtMs: Date.now(),
          status: message.status, retryAfter: message.retryAfter });
      }
      return { ok: true, origins: await originPacing.list() };
    },
    ...makeKernelAppEditorRoutes({
      vault: deps.vault,
      catalog: appCatalog,
      files: appFiles,
      repositories,
      withAppDwebAuthority: deps.withAppDwebAuthority,
      isAppSender: deps.isAppSender,
      reloadApp: deps.reloadApp,
    }),
    'lifecycle/assert-opfs-writable': makeKernelOpfsPostureRoute({
      ready: deps.ready,
      assertWritable: () => deps.canWrite('opfs-workspaces'),
      isAllowed: (/** @type {unknown} */ sender) =>
        deps.isNotebookSender(sender) || deps.isOffscreenSender(sender),
    }),
    'vm/get-meta': makeKernelVmMetaRoute({
      ready: deps.ready,
      idb: deps.idb,
      settingsStore: deps.settingsStore,
      isAllowed: deps.isTrustedSender,
    }),
    ...createKernelSiteClientRoutes({ isAllowed: deps.isOptionsSender }),
    'audit/voice-fetch': makeKernelVoiceAuditRoute({
      auditLog: deps.auditLog,
      isAllowed: deps.isVoiceSender,
    }),
    ...makeKernelComposerRoutes({
      browser: deps.browser,
      kv: deps.kv,
      idb: deps.idb,
      sessionCache: deps.sessionCache,
      vault: deps.vault,
      denylist: deps.denylist,
      appFiles,
    }),
    ...makeKernelSettingsRoutes({
      ready: deps.ready,
      settingsStore: deps.settingsStore,
      defaults: deps.settingsDefaults,
      knownProviderNames: deps.knownProviderNames,
      dwebEnabled: deps.dwebEnabled,
      normalizeVariant: deps.normalizeVariant,
      normalizeEngine: deps.normalizeEngine,
      onChanging: deps.onSettingsChanging,
      onChanged: deps.onSettingsChanged,
      pushState: deps.pushState,
    }),
  });
  if (Object.keys(directRoutes).sort().join('\0')
      !== [...KERNEL_DEMAND_SUPPORT_ROUTE_NAMES].sort().join('\0')) {
    throw new TypeError('kernel-demand-support-routes-invalid');
  }
  const providerKeyRoutes = Object.freeze({
    'provider/setKey': makeKernelProviderSetKeyRoute({
      vault: deps.vault,
      settingsStore: deps.settingsStore,
      auditLog: deps.auditLog,
      testProvider: deps.testProvider,
      pushState: async () => {
        deps.providerProjection.bumpRevision();
        await deps.pushState();
      },
    }),
  });
  const credentialRoutes = Object.freeze({
    ...makeKernelGitCredentialRoutes({
      vault: deps.vault,
      auditLog: deps.auditLog,
      isLockedError: deps.isLockedError,
    }),
    ...makeKernelOriginCredentialRoutes({
      vault: deps.vault,
      auditLog: deps.auditLog,
      idb: deps.idb,
      isLockedError: deps.isLockedError,
      learnKeyedOrigin: keyedOriginAuthority.add,
      forgetKeyedOrigin: keyedOriginAuthority.remove,
    }),
  });
  return Object.freeze({
    directRoutes,
    providerKeyRoutes,
    credentialRoutes,
    appCatalog,
    appFiles,
    repositories,
    keyedOriginAuthority,
    normalizeSettingsPatch,
    originPacing,
  });
};
