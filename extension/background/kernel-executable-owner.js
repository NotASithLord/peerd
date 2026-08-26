// @ts-check
import {
  makeBoundedModuleLoader,
  STARTUP_UNAVAILABLE_USER_FAILURE,
} from '../shared/bounded-module-load.js';
import {
  KERNEL_DWEB_ROUTE_NAMES,
  KERNEL_ENGINE_ATTACH_ROUTE_NAMES,
  KERNEL_EXECUTABLE_ROUTE_NAMES,
  KERNEL_PAGE_PROGRAM_ROUTE_NAMES,
  KERNEL_TRANSFER_ROUTE_NAMES,
} from '../shared/kernel-feature-route-inventory.js';
import { makePrivateTransferOpenRoute, makePrivateTransferPort } from './private-transfer-port.js';
import { makeKernelDemandRoutes } from './kernel-demand-routes.js';

const startupFailure = (/** @type {unknown} */ cause) => ({
  ok: false,
  error: STARTUP_UNAVAILABLE_USER_FAILURE,
  code: typeof /** @type {{code?:unknown}} */ (cause)?.code === 'string'
    ? /** @type {{code:string}} */ (cause).code : 'kernel-executable-runtime-load-failed',
  outcomeKnown: true,
  phase: 'startup',
  retryable: true,
});
const dispatchFailure = () => ({
  ok: false,
  error: 'The operation outcome could not be confirmed.',
  code: 'kernel-executable-dispatch-failed',
  outcomeKnown: false,
  outcomeKind: 'unknown',
  retryable: false,
});

const POD_ROUTES = new Set([
  'pod/cancel-io', 'pod/get-meta', 'pod/git', 'pod/web-fetch',
]);
const RELAY_ROUTES = new Set([
  'a2a/call', 'actors/call', 'app-code/observe', 'app-code/act', 'script/model-call',
  'script-run/abort', 'site-fetch/call',
  ...KERNEL_PAGE_PROGRAM_ROUTE_NAMES,
]);
const ENGINE_ATTACH_ROUTES = new Set(KERNEL_ENGINE_ATTACH_ROUTE_NAMES);
const DWEB_OFFSCREEN_ROUTES = new Set([
  'dweb/app-install', 'dweb/app-record-served', 'dweb/app-snapshot', 'dweb/app-update',
  'dweb/meta-admit', 'dweb/self-apply-surface', 'dweb/self-prepare-offer',
  'dweb/self-read-surface',
]);
const DWEB_APP_ROUTES = new Set(['dweb/audit', 'dweb/base/room']);
const EXECUTABLE_LIVE_LOADERS = Object.freeze([
  ['loadEngineLive', 'engine-live'],
  ['loadActorChatRelays', 'actor-chat-relays'],
  ['loadAppRuntimeRelays', 'app-runtime-relays'],
  ['loadRelayRoutes', 'relay-routes'],
  ['loadTransferLive', 'transfer-live'],
  ['loadDwebRoutes', 'dweb-routes'],
]);

const makeTabDocument = (/** @type {string} */ runtimeId) => (
  /** @type {any} */ sender, /** @type {string} */ expectedUrl,
  /** @type {string|null} */ expectedId = null,
) => {
  if (sender?.id !== runtimeId || typeof sender?.tab?.id !== 'number') return false;
  const raw = sender.url ?? sender.tab.url;
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw);
    const expected = new URL(expectedUrl);
    return url.origin === expected.origin && url.pathname === expected.pathname
      && url.search === '' && (expectedId === null
        || decodeURIComponent(url.hash.slice(1).split('?', 1)[0]) === expectedId);
  } catch { return false; }
};

/** @param {Record<string,((...args:any[])=>boolean)|undefined>} gates */
export const makeKernelExecutableAdmission = (gates) => (
  /** @type {string} */ route, /** @type {any} */ message, /** @type {any} */ sender,
) => {
  if (POD_ROUTES.has(route)) return gates.pod?.(sender, message) === true;
  if (route === 'sw/web-fetch' || route === 'sw/web-fetch-abort') {
    return gates.webFetch?.(sender, message) === true;
  }
  if (route === 'export/artifact') return gates.artifactExport?.(sender, message) === true;
  if (route === 'import/inspect' || route === 'import/apply') {
    return gates.options?.(sender, message) === true;
  }
  if (route === 'apps/delete') return gates.home?.(sender, message) === true;
  if (route === 'app/actor-chat') return gates.app?.(sender, message) === true;
  if (RELAY_ROUTES.has(route)) return gates.relay?.(sender, message) === true;
  if (ENGINE_ATTACH_ROUTES.has(route)) return gates.engine?.(route, sender, message) === true;
  return false;
};

/** @param {Record<string,(sender:any,message:any)=>boolean>} gates */
export const makeKernelDwebAdmission = (gates) => (
  /** @type {string} */ route, /** @type {any} */ message, /** @type {any} */ sender,
) => {
  if (DWEB_OFFSCREEN_ROUTES.has(route)) return gates.offscreen?.(sender, message) === true;
  if (DWEB_APP_ROUTES.has(route)) return gates.app?.(sender, message) === true;
  if (route === 'dweb/distributed/info') {
    return gates.home?.(sender, message) === true || gates.notebook?.(sender, message) === true;
  }
  return route.startsWith('dweb/') && gates.home?.(sender, message) === true;
};

/** @param {Record<string,any>} deps @param {(authorization:symbol)=>Record<string,any>} handlers */
const makePrivateTransfer = (deps, handlers) => {
  const authorization = Symbol('kernel-private-transfer');
  const privatePort = makePrivateTransferPort({
    handlers: handlers(authorization), authorization,
  });
  const attach = (/** @type {any} */ port, /** @type {any} */ context = {}) => {
    if (!deps.isOptionsSender(context.sender ?? port?.sender)) {
      try { port?.disconnect?.(); } catch {}
      try { port?.close?.(); } catch {}
      return false;
    }
    privatePort.attach(port);
    return true;
  };
  const routes = typeof deps.listWindowClients === 'function' ? {
    'private-transfer/open': makePrivateTransferOpenRoute({
      isOptionsSender: deps.isOptionsSender,
      listWindowClients: deps.listWindowClients,
      optionsUrl: deps.optionsUrl,
      attach: privatePort.attach,
      ...(deps.createChannel ? { createChannel: deps.createChannel } : {}),
    }),
  } : {};
  return { attach, routes };
};

/** @param {Record<string,any>} deps */
export const createKernelExecutableOwner = (deps) => {
  if (typeof deps.admit !== 'function'
      || typeof deps.createRuntime !== 'function'
      || (!deps.runtime && typeof deps.loadRuntimeDeps !== 'function')) {
    throw new TypeError('kernel-executable-owner-config-invalid');
  }
  const load = makeBoundedModuleLoader(async () => {
    const runtimeDeps = typeof deps.loadRuntimeDeps === 'function'
      ? await deps.loadRuntimeDeps() : deps.runtime;
    const runtime = await deps.createRuntime({
      ...runtimeDeps, admit: deps.admit,
    });
    if (!runtime || KERNEL_EXECUTABLE_ROUTE_NAMES.some(
      (name) => typeof runtime.routes?.[name] !== 'function',
    ) || typeof runtime.makeTransferRoutes !== 'function') {
      throw new TypeError('kernel-executable-runtime-invalid');
    }
    return runtime;
  }, {
    timeoutMs: deps.loadTimeoutMs ?? 15_000,
    loadCode: 'kernel-executable-runtime-load-failed',
    timeoutCode: 'kernel-executable-runtime-load-timeout',
  });
  /** @type {Record<string,(message?:any,sender?:any)=>Promise<any>|any>} */
  const routes = Object.fromEntries(KERNEL_EXECUTABLE_ROUTE_NAMES.map((name) => [name, async (
    /** @type {any} */ message = {}, /** @type {any} */ sender = undefined,
  ) => {
    if (deps.admit(name, message, sender) !== true) {
      return { ok: false, error: 'kernel-route-unauthorized', outcomeKnown: true };
    }
    let runtime;
    try { runtime = await load(); }
    catch (cause) { return startupFailure(cause); }
    try { return await runtime.routes[name](message, sender); }
    catch { return dispatchFailure(); }
  }]));
  let transferRoutes = null;
  const makeTransferRoutes = async (/** @type {symbol} */ authorization) => {
    transferRoutes ??= (await load()).makeTransferRoutes(authorization);
    return transferRoutes;
  };
  const privateTransfer = deps.privateTransfer ? makePrivateTransfer(
    deps.privateTransfer,
    (/** @type {symbol} */ authorization) => Object.fromEntries(
      KERNEL_TRANSFER_ROUTE_NAMES.map((name) => [name, async (message = {}) => {
        let privateRoutes;
        try {
          privateRoutes = await makeTransferRoutes(authorization);
        } catch (cause) { return startupFailure(cause); }
        try { return await privateRoutes[name](message); }
        catch { return dispatchFailure(); }
      }]),
    ),
  ) : null;
  /** @type {Record<string,(message?:any,sender?:any)=>Promise<any>|any>} */
  const ownedRoutes = { ...routes };
  for (const [name, handler] of Object.entries(privateTransfer?.routes ?? {})) {
    if (typeof handler === 'function') ownedRoutes[name] = handler;
  }
  return Object.freeze({
    routes: Object.freeze(ownedRoutes),
    attachPrivateTransfer: privateTransfer?.attach ?? null,
    makeTransferRoutes,
  });
};

/** @param {Record<string,any>} deps */
export const createKernelExecutableControl = (deps) => {
  if (EXECUTABLE_LIVE_LOADERS.some(([key]) => typeof deps?.[key] !== 'function')) {
    throw new TypeError('kernel-executable-control-config-invalid');
  }
  const { owns, paths } = deps;
  const liveLoader = (/** @type {string} */ key, /** @type {string} */ label) => {
    const load = makeBoundedModuleLoader(async () => {
      const value = await deps[key]();
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`kernel-executable-${label}-invalid`);
      }
      return value;
    }, {
      timeoutMs: deps.liveLoadTimeoutMs ?? 15_000,
      loadCode: `kernel-executable-${label}-load-failed`,
      timeoutCode: `kernel-executable-${label}-load-timeout`,
    });
    return async () => {
      try { return await load(); }
      catch (cause) { load.reset(); throw cause; }
    };
  };
  const live = Object.fromEntries(EXECUTABLE_LIVE_LOADERS.map(([key, label]) => [
    key, liveLoader(key, label),
  ]));
  const ownsTab = owns.tab ?? makeTabDocument(deps.runtimeId);
  const admit = makeKernelExecutableAdmission({
    pod: (sender, message) => typeof message?.podId === 'string'
      && ownsTab(sender, paths.pod, message.podId),
    webFetch: (sender, message) => owns.offscreen(sender)
      || ownsTab(sender, paths.vm)
      || (typeof message?.notebookId === 'string'
        && ownsTab(sender, paths.notebook, message.notebookId)),
    artifactExport: (sender, message) => owns.home(sender)
      || (message?.kind === 'app' && typeof message?.id === 'string'
        && owns.app(sender, message.id))
      || (message?.kind === 'vm' && typeof message?.id === 'string'
        && ownsTab(sender, paths.vm, message.id))
      || (message?.kind === 'notebook' && typeof message?.id === 'string'
        && ownsTab(sender, paths.notebook, message.id)),
    options: owns.options,
    home: owns.home,
    app: (sender, message) => typeof message?.appId === 'string'
      && owns.app(sender, message.appId),
    relay: owns.offscreen,
    engine: (/** @type {string} */ route, /** @type {any} */ sender,
      /** @type {any} */ message) => {
      if (route === 'vm/tab-ready') {
        return typeof message?.vmId === 'string'
          && ownsTab(sender, paths.vm, message.vmId);
      }
      if (route === 'js/tab-ready') {
        return typeof message?.notebookId === 'string'
          && ownsTab(sender, paths.notebook, message.notebookId);
      }
      if (route === 'pod/tab-adopt') {
        return typeof message?.podId === 'string'
          && ownsTab(sender, paths.pod, message.podId);
      }
      return typeof message?.appId === 'string' && owns.app(sender, message.appId);
    },
  });
  const owner = createKernelExecutableOwner({
    admit,
    createRuntime: deps.createRuntime,
    loadRuntimeDeps: async () => ({
      engine: { load: live.loadEngineLive },
      actorChat: { load: live.loadActorChatRelays },
      appRuntime: { load: live.loadAppRuntimeRelays },
      relay: {
        dispatch: deps.dispatchRuntimeRelay,
        load: live.loadRelayRoutes,
      },
      transfer: { load: live.loadTransferLive },
    }),
    ...(deps.privateTransfer === false ? {} : { privateTransfer: {
      isOptionsSender: owns.options,
      ...(deps.firefox ? {} : {
        optionsUrl: paths.options,
        listWindowClients: deps.listWindowClients ?? (async () => {
          const clientsApi = /** @type {any} */ (globalThis).clients;
          return clientsApi?.matchAll ? clientsApi.matchAll({ type: 'window' }) : [];
        }),
      }),
    } }),
  });
  const dwebAdmission = makeKernelDwebAdmission({
    offscreen: owns.offscreen,
    app: (sender, message) => typeof message?.appId === 'string'
      ? owns.app(sender, message.appId) : ownsTab(sender, paths.app),
    home: owns.home,
    notebook: (sender) => ownsTab(sender, paths.notebook),
  });
  const dwebRoutes = deps.dweb ? makeKernelDemandRoutes({
    names: KERNEL_DWEB_ROUTE_NAMES,
    loadCode: 'kernel-dweb-routes-load-failed',
    timeoutCode: 'kernel-dweb-routes-load-timeout',
    beforeLoad: (name, message, sender) => dwebAdmission(name, message, sender)
      ? null : { ok: false, error: 'kernel-route-unauthorized', outcomeKnown: true },
    load: live.loadDwebRoutes,
  }) : {};
  return Object.freeze({
    routes: Object.freeze({ ...owner.routes, ...dwebRoutes }),
    attachPrivateTransfer: owner.attachPrivateTransfer,
    makeTransferRoutes: owner.makeTransferRoutes,
  });
};
