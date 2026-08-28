// @ts-check

import { createKernelSemanticAuthority } from './kernel-semantic-authority.js';
import { createKernelContactsAuthority } from './kernel-contacts-authority.js';
import { createKernelSemanticControl } from './kernel-semantic-control.js';
import { createKernelSkillsAuthority } from './kernel-skills-authority.js';
import { createKernelMemoryAuthority } from './kernel-memory-authority.js';
import { makeContactsRoutes } from './routes/contacts.js';
import { mergeContacts } from '/peerd-runtime/contacts/aggregate.js';
import { kernelAppCatalogRows } from './kernel-app-catalog.js';
import { createKernelTurnOwner } from './kernel-turn-owner.js';
import { KERNEL_SESSION_TURN_ROUTE_NAMES } from './kernel-session-turn-routes.js';
import { createKernelRuntimeControl } from './kernel-runtime-control.js';
import { createKernelRepositoryControl } from './kernel-repository-control.js';
import { createKernelLocalControl } from './kernel-local-control.js';

export const KERNEL_SEMANTIC_DIRECT_ROUTE_NAMES = Object.freeze([
  'apps/list', 'contacts/list', 'memory/export',
  'skills/list', 'skills/remove', 'skills/setEnabled',
]);

/** @param {Record<string,any>} deps */
export const createKernelSemanticRuntime = (deps) => {
  const gateway = deps.controllerGateway;
  if (!gateway || typeof gateway.bindSemantic !== 'function'
      || typeof gateway.bindTurn !== 'function' || typeof gateway.bindRuntime !== 'function'
      || typeof gateway.bindCompose !== 'function' || typeof gateway.bindFeature !== 'function') {
    throw new TypeError('kernel-semantic-controller-gateway-invalid');
  }
  const skills = createKernelSkillsAuthority({
    idbFactory: deps.idbFactory,
    canWrite: () => deps.canWrite('skills'),
    audit: deps.auditLog.append,
    pushState: deps.pushState,
  });
  const memory = createKernelMemoryAuthority({
    idb: deps.idb, kv: deps.kv, auditLog: deps.auditLog,
  });
  const contacts = createKernelContactsAuthority({ idb: deps.idb });
  const authority = createKernelSemanticAuthority({
    idb: deps.idb, kv: deps.kv, auditLog: deps.auditLog, vault: deps.vault,
    ready: deps.ready, memory, contacts,
    appCatalog: deps.appCatalog,
    reloadApp: deps.reloadApp,
    browser: deps.browser,
    appTabUrl: deps.appTabUrl,
    sessionCache: deps.sessionCache,
  });
  const localRoutes = {
    'apps/list': async () => {
      try { return { ok: true, apps: await deps.appCatalog.list() }; }
      catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    'contacts/list': makeContactsRoutes({
      vault: deps.vault,
      auditLog: deps.auditLog,
      contacts,
      appRegistry: {
        list: async () => kernelAppCatalogRows(await deps.idb.get('apps', 'apps.v1')),
      },
      mergeContacts,
    })['contacts/list'],
    'memory/export': memory.routes['memory/export'],
    'skills/list': skills.routes['skills/list'],
    'skills/setEnabled': skills.routes['skills/setEnabled'],
    'skills/remove': skills.routes['skills/remove'],
  };
  const directNames = Object.keys(localRoutes).sort();
  if (directNames.join('\0') !== [...KERNEL_SEMANTIC_DIRECT_ROUTE_NAMES].sort().join('\0')) {
    throw new TypeError('kernel-semantic-direct-routes-invalid');
  }
  /** @type {Record<string,any>|null} */
  let semanticBinding = null;
  /** @type {Record<string,any>|null} */
  let runtimeBinding = null;
  /** @type {Record<string,any>|null} */
  let repositoryBinding = null;
  /** @type {Record<string,any>|null} */
  let localBinding = null;
  /** @type {Record<string,any>|null} */
  let administrativeBinding = null;
  /** @type {ReturnType<typeof createKernelTurnOwner>|null} */
  let turnOwner = null;
  const repository = deps.repositories ? createKernelRepositoryControl({
    callFeature: (/** @type {unknown} */ payload, /** @type {any} */ options) =>
      ensureRepositoryBinding().callFeature(payload, options),
    repositories: deps.repositories,
    catalog: deps.appCatalog,
    appFiles: deps.appFiles,
    vault: deps.vault,
    browser: deps.browser,
    auditLog: deps.auditLog,
    appTabUrl: deps.appTabUrl,
    sessionCache: deps.sessionCache,
    allowDweb: deps.dwebEnabled,
  }) : null;
  const local = deps.settingsStore && deps.featureHost ? createKernelLocalControl({
    callFeature: (/** @type {unknown} */ payload, /** @type {any} */ options) =>
      ensureLocalBinding().callFeature(payload, options),
    vault: deps.vault,
    settingsStore: deps.settingsStore,
    sessions: deps.sessions,
    browser: deps.browser,
    auditLog: deps.auditLog,
    ready: deps.ready,
    featureHost: deps.featureHost,
    offscreenUrl: deps.offscreenUrl,
    localModels: deps.localModels,
    providerProjection: deps.providerProjection,
    providerEgress: deps.providerEgress,
    pushState: deps.pushState,
    fetchFn: deps.fetchFn,
  }) : null;
  const runtime = createKernelRuntimeControl({
    readBootstrap: () => Object.freeze({
      schema: 1,
      target: deps.firefox === true ? 'firefox' : 'chrome',
      dwebEnabled: deps.dwebEnabled === true,
    }),
    call: (/** @type {unknown} */ payload,
      /** @type {{timeoutMs?:number}} */ options = {}) =>
      ensureRuntimeBinding().callRuntime(payload, options),
    handleRichKernelCall: deps.handleRichKernelCall,
  });
  const control = createKernelSemanticControl({
    callSemantic: (/** @type {any} */ payload) =>
      ensureSemanticBinding().callSemantic(payload),
    isHomeSender: deps.isHomeSender,
    vault: deps.vault,
    authority,
    localRoutes,
    actorCount: () => typeof deps.loadTurnRuntime === 'function'
      ? ensureTurnOwner().actorCount() : deps.actorCount(),
    actorOverview: () => typeof deps.loadTurnRuntime === 'function'
      ? ensureTurnOwner().actorOverview() : deps.actorOverview(),
    awaitReady: () => deps.ready,
  });
  const ensureGateway = () => gateway;
  const ensureSemanticBinding = () => semanticBinding ??= ensureGateway().bindSemantic({
    authorize: control.authorize,
    handle: control.handleKernelCall,
  });
  const ensureRuntimeBinding = () => runtimeBinding ??= ensureGateway().bindRuntime({
    authorize: runtime.authorize,
    handle: runtime.handleKernelCall,
  });
  const ensureRepositoryBinding = () => {
    if (!repository) throw new Error('kernel-repository-owner-unavailable');
    return repositoryBinding ??= ensureGateway().bindFeature('repository', {
      authorize: repository.authorize,
      handle: repository.handleKernelCall,
    });
  };
  const ensureLocalBinding = () => {
    if (!local) throw new Error('kernel-local-owner-unavailable');
    return localBinding ??= ensureGateway().bindFeature('local', {
      authorize: local.authorize,
      handle: local.handleKernelCall,
    });
  };
  const ensureAdministrativeBinding = () => {
    if (typeof deps.authorizeFeatureCall !== 'function'
        || typeof deps.handleFeatureKernelCall !== 'function') {
      throw new Error('kernel-administrative-owner-unavailable');
    }
    return administrativeBinding ??= ensureGateway().bindFeature('administrative', {
      authorize: deps.authorizeFeatureCall,
      handle: deps.handleFeatureKernelCall,
    });
  };
  const appMetaRoute = async (/** @type {any} */ message = {},
    /** @type {unknown} */ sender = undefined) => {
    const { appId } = message;
    if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
    if (!deps.isAppSender(sender, appId)) {
      return { ok: false, error: 'app-meta-unauthorized' };
    }
    const app = await deps.appCatalog.get(appId);
    if (!app) return { ok: false, error: 'app-not-found' };
    let manifestText = null;
    let paths = [];
    if (deps.appFiles) {
      try {
        manifestText = await deps.appFiles.readText(appId, 'peerd.json');
        paths = await deps.appFiles.listApp(appId);
      } catch (cause) {
        if (/** @type {{name?:unknown}} */ (cause)?.name !== 'NotFoundError') {
          return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
        }
      }
    }
    return control.dispatchProjected('app/get-meta', {
      app: {
        id: app.id, name: app.name, entryFile: app.entryFile,
        fileKinds: app.fileKinds ?? {}, dweb: app.dweb ?? null,
      },
      manifestText,
      paths,
      dwebEnabled: deps.dwebEnabled === true,
    }, 'app');
  };
  const ensureTurnOwner = () => {
    if (turnOwner) return turnOwner;
    if (typeof deps.loadTurnRuntime !== 'function') {
      throw new Error('kernel-turn-runtime-loader-missing');
    }
    turnOwner = createKernelTurnOwner({
      createController: (/** @type {any} */ turnAuthority) => {
        const turnBinding = ensureGateway().bindTurn({
          authorize: turnAuthority.authorizeTurnCall,
          handle: turnAuthority.handleTurnKernelCall,
        });
        let composeBinding;
        try {
          composeBinding = ensureGateway().bindCompose({
            authorize: turnAuthority.authorizeComposeCall,
            handle: turnAuthority.handleComposeKernelCall,
          });
        } catch (cause) {
          // why: the turn and compose slots form one logical owner. A compose
          // conflict must not strand the turn slot and poison every retry.
          turnBinding.release();
          throw cause;
        }
        return Object.freeze({
          ...turnBinding,
          composeTurn: composeBinding.composeTurn,
          ...(typeof deps.withProductionRun === 'function'
            ? { withRun: deps.withProductionRun } : {}),
          release: () => {
            turnBinding.release();
            composeBinding.release();
          },
        });
      },
      loadRuntime: deps.loadTurnRuntime,
      onLoaded: deps.onTurnRuntimeLoaded,
      providerEgress: deps.providerEgress,
      authorityScheduler: deps.authorityScheduler,
      ...(deps.turnLoadTimeoutMs === undefined ? {} : { loadTimeoutMs: deps.turnLoadTimeoutMs }),
    });
    return turnOwner;
  };
  const turnRoutes = typeof deps.loadTurnRuntime === 'function'
    ? Object.fromEntries(KERNEL_SESSION_TURN_ROUTE_NAMES.map((name) => [name, (
      /** @type {any} */ message = {}, /** @type {any} */ sender = undefined,
    ) => ensureTurnOwner().routes[name](message, sender)])) : {};
  /** @type {Readonly<Record<string,(message?:any,sender?:any)=>any>>} */
  const routes = Object.freeze({
    ...control.routes,
    'app/get-meta': appMetaRoute,
    ...(repository?.routes ?? {}),
    ...(local?.routes ?? {}),
    ...turnRoutes,
  });
  return Object.freeze({
    routes,
    callFeature: (/** @type {unknown} */ payload, /** @type {any} */ options = {}) =>
      ensureAdministrativeBinding().callFeature(payload, options),
    actorCount: () => typeof deps.loadTurnRuntime === 'function'
      ? ensureTurnOwner().actorCount() : deps.actorCount(),
    actorOverview: () => typeof deps.loadTurnRuntime === 'function'
      ? ensureTurnOwner().actorOverview() : deps.actorOverview(),
    get relays() { return turnOwner?.relays ?? null; },
    getRelays: () => ensureTurnOwner().getRelays(),
    abortProviderTests: () => local?.abort(),
    runtime,
    close: async () => {
      await turnOwner?.close();
      semanticBinding?.release();
      runtimeBinding?.release();
      repositoryBinding?.release();
      localBinding?.release();
      administrativeBinding?.release();
    },
  });
};
