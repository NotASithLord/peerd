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

export const KERNEL_SEMANTIC_DIRECT_ROUTE_NAMES = Object.freeze([
  'contacts/forget', 'contacts/list', 'contacts/set', 'memory/export',
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
    ready: deps.ready, memory,
  });
  const localRoutes = {
    ...makeContactsRoutes({
      vault: deps.vault,
      auditLog: deps.auditLog,
      contacts,
      appRegistry: {
        list: async () => kernelAppCatalogRows(await deps.idb.get('apps', 'apps.v1')),
      },
      mergeContacts,
    }),
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
      ...turnAuthority,
      retireHost: deps.retireHost,
      withControllerLease: deps.withControllerLease,
      withDirectLifetime: deps.withDirectLifetime,
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
  const routes = Object.freeze({ ...control.routes, ...turnRoutes });
  return Object.freeze({
    routes,
    get controller() { return controllerClient(); },
    actorCount: () => typeof deps.loadTurnRuntime === 'function'
      ? ensureTurnOwner().actorCount() : deps.actorCount(),
    actorOverview: () => typeof deps.loadTurnRuntime === 'function'
      ? ensureTurnOwner().actorOverview() : deps.actorOverview(),
    get relays() { return turnOwner?.relays ?? null; },
    getRelays: () => ensureTurnOwner().getRelays(),
    close: () => turnOwner?.close() ?? controller?.close?.(),
  });
};
