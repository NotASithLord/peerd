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
import { makeKernelSessionRoutes } from './kernel-session-routes.js';
import { KERNEL_DEMAND_SUPPORT_ROUTE_NAMES } from '../shared/kernel-feature-route-inventory.js';

/** @param {Record<string,any>} deps */
export const createKernelDemandSupport = (deps) => {
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
  const routes = Object.freeze({
    ...makeKernelAppEditorRoutes({
      vault: deps.vault,
      catalog: appCatalog,
      files: appFiles,
      repositories,
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
    ...makeKernelSessionRoutes({
      vault: deps.vault,
      sessions: deps.sessions,
      contextSnapshots: deps.contextSnapshots,
      ready: deps.ready,
      sessionCache: deps.sessionCache,
      auditLog: deps.auditLog,
      resolvePermission: deps.resolvePermission,
      pushState: deps.pushState,
    }),
  });
  if (Object.keys(routes).sort().join('\0')
      !== [...KERNEL_DEMAND_SUPPORT_ROUTE_NAMES].sort().join('\0')) {
    throw new TypeError('kernel-demand-support-routes-invalid');
  }
  const providerKeyRoutes = Object.freeze({
    'provider/setKey': makeKernelProviderSetKeyRoute({
      vault: deps.vault,
      settingsStore: deps.settingsStore,
      auditLog: deps.auditLog,
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
    routes,
    providerKeyRoutes,
    credentialRoutes,
    appCatalog,
    appFiles,
    repositories,
    keyedOriginAuthority,
    normalizeSettingsPatch,
  });
};
