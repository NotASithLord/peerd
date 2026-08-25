// @ts-check

import { makeSemanticControllerClient } from './offscreen-controller-client.js';
import { createKernelSemanticAuthority } from './kernel-semantic-authority.js';
import { createKernelContactsAuthority } from './kernel-contacts-authority.js';
import { createKernelSemanticControl } from './kernel-semantic-control.js';
import { createKernelToolboxStore } from './kernel-toolbox-store.js';
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
  'skills/list', 'skills/remove', 'skills/setEnabled', 'toolbox/read', 'toolbox/record',
]);

/** @param {Record<string,any>} deps */
export const createKernelSemanticRuntime = (deps) => {
  const makeController = deps.makeController ?? makeSemanticControllerClient;
  const skills = createKernelSkillsAuthority({
    idbFactory: deps.idbFactory,
    canWrite: () => deps.canWrite('skills'),
    audit: deps.auditLog.append,
    pushState: deps.pushState,
  });
  const toolbox = createKernelToolboxStore({ idbFactory: deps.idbFactory });
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
  const directNames = ['toolbox/read', 'toolbox/record', ...Object.keys(localRoutes)].sort();
  if (directNames.join('\0') !== [...KERNEL_SEMANTIC_DIRECT_ROUTE_NAMES].sort().join('\0')) {
    throw new TypeError('kernel-semantic-direct-routes-invalid');
  }
  /** @type {ReturnType<typeof makeSemanticControllerClient>|null} */
  let controller = null;
  /** @type {ReturnType<typeof createKernelTurnOwner>|null} */
  let turnOwner = null;
  const repository = deps.repositories ? createKernelRepositoryControl({
    callFeature: (/** @type {unknown} */ payload, /** @type {any} */ options) =>
      /** @type {any} */ (controllerClient()).callFeature(payload, options),
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
      /** @type {any} */ (controllerClient()).callFeature(payload, options),
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
      /** @type {{timeoutMs?:number}} */ options = {}) => {
      const client = /** @type {ReturnType<typeof makeSemanticControllerClient>} */ (
        controllerClient()
      );
      return client.callRuntime(payload, options);
    },
    handleRichKernelCall: deps.handleRichKernelCall,
  });
  const makeSharedController = (turnAuthority = {}) => {
    if (controller) return controller;
    controller = makeController({
      browser: deps.browser,
      ensureOffscreen: deps.ensureOffscreen,
      offscreenUrl: deps.offscreenUrl,
      firefoxDirect: deps.firefox,
      dwebEnabled: deps.dwebEnabled,
      kernelIdentity: deps.kernelIdentity,
      authorizeSemanticCall: control.authorize,
      handleSemanticKernelCall: control.handleKernelCall,
      authorizeRuntimeCall: runtime.authorize,
      handleRuntimeKernelCall: runtime.handleKernelCall,
      authorizeFeatureCall: (/** @type {unknown} */ payload) =>
        repository?.authorize(payload) ?? local?.authorize(payload)
        ?? deps.authorizeFeatureCall?.(payload),
      handleFeatureKernelCall: (/** @type {string} */ operation,
        /** @type {unknown} */ payload, /** @type {any} */ context) => {
        const target = context?.authority?.target;
        if (typeof target === 'string' && target.startsWith('kernel-feature:repository:')) {
          return repository?.handleKernelCall(operation, payload, context)
            ?? { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };
        }
        if (typeof target === 'string' && target.startsWith('kernel-feature:local:')) {
          return local?.handleKernelCall(operation, payload, context)
            ?? { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };
        }
        return deps.handleFeatureKernelCall?.(operation, payload, context)
          ?? { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };
      },
      ...turnAuthority,
      retireHost: deps.retireHost,
      withControllerLease: deps.withControllerLease,
      withDirectLifetime: deps.withDirectLifetime,
      connectDirectController: deps.connectDirectController,
      loadDirectController: deps.loadDirectController,
      fetchFn: deps.fetchFn,
    });
    return /** @type {NonNullable<typeof controller>} */ (controller);
  };
  const control = createKernelSemanticControl({
    callSemantic: (/** @type {any} */ payload) => controllerClient().callSemantic(payload),
    isHomeSender: deps.isHomeSender,
    vault: deps.vault,
    authority,
    toolboxStore: toolbox,
    localRoutes,
    actorCount: () => typeof deps.loadTurnRuntime === 'function'
      ? ensureTurnOwner().actorCount() : deps.actorCount(),
    actorOverview: () => typeof deps.loadTurnRuntime === 'function'
      ? ensureTurnOwner().actorOverview() : deps.actorOverview(),
    awaitReady: () => deps.ready,
  });
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
      createController: (/** @type {any} */ turnAuthority) => makeSharedController(turnAuthority),
      loadRuntime: deps.loadTurnRuntime,
      ...(deps.turnLoadTimeoutMs === undefined ? {} : { loadTimeoutMs: deps.turnLoadTimeoutMs }),
    });
    return turnOwner;
  };
  const controllerClient = () => typeof deps.loadTurnRuntime === 'function'
    ? ensureTurnOwner().controller : makeSharedController();
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
    get controller() { return controllerClient(); },
    actorCount: () => typeof deps.loadTurnRuntime === 'function'
      ? ensureTurnOwner().actorCount() : deps.actorCount(),
    actorOverview: () => typeof deps.loadTurnRuntime === 'function'
      ? ensureTurnOwner().actorOverview() : deps.actorOverview(),
    get relays() { return turnOwner?.relays ?? null; },
    getRelays: () => ensureTurnOwner().getRelays(),
    abortProviderTests: () => local?.abort(),
    runtime,
    close: () => turnOwner?.close() ?? controller?.close?.(),
  });
};
