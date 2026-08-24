// @ts-check
import {
  makeKernelAppDeleteRoutes,
  makeKernelArtifactRoutes,
  makeKernelPodRoutes,
  makeKernelWebFetchRoutes,
} from './kernel-engine-route-owners.js';
import {
  makeKernelAppActorChatRoutes,
  makeKernelAppCallRoutes,
} from './kernel-direct-route-owners.js';
import { makeKernelTransferRoutes } from './kernel-transfer-routes.js';
import {
  KERNEL_EXECUTABLE_ROUTE_NAMES,
  KERNEL_RELAY_ROUTE_NAMES,
  KERNEL_TRANSFER_ROUTE_NAMES,
} from './kernel-executable-inventory.js';
import {
  makeBoundedModuleLoader,
  STARTUP_UNAVAILABLE_USER_FAILURE,
} from '../shared/bounded-module-load.js';

const DEFAULT_FACTORIES = Object.freeze({
  makeKernelAppDeleteRoutes,
  makeKernelArtifactRoutes,
  makeKernelPodRoutes,
  makeKernelWebFetchRoutes,
  makeKernelAppActorChatRoutes,
  makeKernelAppCallRoutes,
  makeKernelTransferRoutes,
});

/** @param {Record<string,any>} deps */
export const createKernelExecutableRuntime = (deps) => {
  if (typeof deps.admit !== 'function' || !deps.engine || !deps.actorChat
      || !deps.appCall || !deps.relay || !deps.transfer) {
    throw new TypeError('kernel-executable-runtime-config-invalid');
  }
  const factories = { ...DEFAULT_FACTORIES, ...deps.factories };
  /** @type {Promise<Record<string,any>>|null} */
  let engineLive = null;
  const loadEngine = () => {
    engineLive ??= Promise.resolve().then(() => deps.engine.load?.())
      .then((live) => live ?? deps.engine)
      .catch((cause) => { engineLive = null; throw cause; });
    return engineLive;
  };
  const engine = typeof deps.engine.load === 'function'
    ? { ...deps.engine, load: loadEngine } : deps.engine;
  /** @type {Promise<Record<string,any>>|null} */
  let transferLive = null;
  const transferDeps = typeof deps.transfer.load !== 'function' ? deps.transfer : {
    ...deps.transfer,
    load: () => {
      transferLive ??= Promise.resolve().then(() => deps.transfer.load())
        .then((live) => live ?? deps.transfer)
        .catch((cause) => { transferLive = null; throw cause; });
      return transferLive;
    },
  };
  const isAllowed = (/** @type {string} */ route, /** @type {any} */ message,
    /** @type {any} */ sender) => deps.admit(route, message, sender) === true;
  const loadAppCall = makeBoundedModuleLoader(async () => {
    const appCall = typeof deps.appCall.load === 'function'
      ? { ...deps.appCall, ...await deps.appCall.load() } : deps.appCall;
    const makeHandler = factories.makeAppCallHandler
      ?? (await (deps.importAppCall
        ?? (() => import('/peerd-runtime/background.js')))()).makeAppCallHandler;
    if (typeof makeHandler !== 'function') {
      throw new TypeError('kernel-app-call-handler-invalid');
    }
    return makeHandler({
      dispatchToolCall: appCall.dispatchToolCall,
      buildActorContext: appCall.buildActorContext,
    });
  }, {
    timeoutMs: deps.appCallLoadTimeoutMs ?? 15_000,
    loadCode: 'kernel-app-call-handler-load-failed',
    timeoutCode: 'kernel-app-call-handler-load-timeout',
  });
  const callApp = async (/** @type {any} */ request) => {
    try { return (await loadAppCall())(request); }
    catch (cause) {
      return {
        ok: false,
        error: STARTUP_UNAVAILABLE_USER_FAILURE,
        code: /** @type {{code?:string}} */ (cause)?.code
          ?? 'kernel-app-call-handler-load-failed',
        outcomeKnown: true,
        phase: 'startup',
        retryable: true,
      };
    }
  };
  const loadRelays = makeBoundedModuleLoader(async () => {
    const live = typeof deps.relay.load === 'function'
      ? await deps.relay.load() : deps.relay;
    const routes = live?.relayRoutes ?? live;
    if (KERNEL_RELAY_ROUTE_NAMES.some((name) => typeof routes?.[name] !== 'function')) {
      throw new TypeError('kernel-relay-routes-invalid');
    }
    return routes;
  }, {
    timeoutMs: deps.relayLoadTimeoutMs ?? 15_000,
    loadCode: 'kernel-relay-routes-load-failed',
    timeoutCode: 'kernel-relay-routes-load-timeout',
  });
  const relayRoutes = Object.fromEntries(KERNEL_RELAY_ROUTE_NAMES.map((name) => [name, async (
    /** @type {any} */ message = {}, /** @type {any} */ sender = undefined,
  ) => {
    if (!isAllowed(name, message, sender)) {
      return { ok: false, error: 'kernel-relay-unauthorized', outcomeKnown: true };
    }
    try { return (await loadRelays())[name](message, sender); }
    catch (cause) {
      return {
        ok: false,
        error: STARTUP_UNAVAILABLE_USER_FAILURE,
        code: /** @type {{code?:string}} */ (cause)?.code ?? 'kernel-relay-routes-load-failed',
        outcomeKnown: true,
        phase: 'startup',
        retryable: true,
      };
    }
  }]));
  const routes = Object.freeze({
    ...factories.makeKernelPodRoutes({ ...engine, isAllowed }),
    ...factories.makeKernelWebFetchRoutes({ ...engine, isAllowed }),
    ...factories.makeKernelArtifactRoutes({ ...engine, isAllowed }),
    ...factories.makeKernelAppDeleteRoutes({ ...engine, isAllowed }),
    ...factories.makeKernelAppActorChatRoutes({
      ...deps.actorChat,
      isAllowed: (/** @type {any} */ sender, /** @type {any} */ message) =>
        isAllowed('app/actor-chat', message, sender),
      isTrustedSender: (/** @type {any} */ sender) =>
        isAllowed('app/actor-chat', {}, sender),
    }),
    ...factories.makeKernelAppCallRoutes({
      ...deps.appCall,
      isRelay: (/** @type {any} */ sender) => isAllowed('app/call', {}, sender),
      callApp,
    }),
    ...relayRoutes,
  });
  if (KERNEL_EXECUTABLE_ROUTE_NAMES.some((name) => typeof routes[name] !== 'function')) {
    throw new TypeError('kernel-executable-runtime-routes-invalid');
  }
  const makeTransferRoutes = (/** @type {symbol} */ authorization) => {
    const transfer = factories.makeKernelTransferRoutes({
      ...transferDeps, privateTransferAuthorization: authorization,
    });
    if (KERNEL_TRANSFER_ROUTE_NAMES.some((name) => typeof transfer[name] !== 'function')) {
      throw new TypeError('kernel-executable-runtime-transfer-invalid');
    }
    return transfer;
  };
  return Object.freeze({ routes, makeTransferRoutes });
};
