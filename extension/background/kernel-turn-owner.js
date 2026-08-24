// @ts-check

import { makeControllerTurnBridge } from './controller-turn-bridge.js';
import {
  KERNEL_SESSION_TURN_ROUTE_NAMES,
  makeKernelSessionTurnRoutes,
} from './kernel-session-turn-routes.js';
import {
  makeBoundedModuleLoader,
  STARTUP_UNAVAILABLE_USER_FAILURE,
} from '../shared/bounded-module-load.js';

const TURN_RUNTIME_LOAD_TIMEOUT_MS = 15_000;

/** @param {unknown} cause */
const startupFailure = (cause) => ({
  ok: false,
  error: STARTUP_UNAVAILABLE_USER_FAILURE,
  code: typeof /** @type {{code?:unknown}} */ (cause)?.code === 'string'
    ? /** @type {{code:string}} */ (cause).code : 'kernel-turn-runtime-load-failed',
  outcomeKnown: true,
  phase: 'startup',
  retryable: true,
});

const closedFailure = () => ({
  ok: false,
  error: STARTUP_UNAVAILABLE_USER_FAILURE,
  code: 'kernel-turn-owner-closed',
  outcomeKnown: true,
  phase: 'startup',
  retryable: false,
});

/**
 * @param {Object} deps
 * @param {(authority:{authorizeTurnCall:Function,handleTurnKernelCall:Function})=>{
 *   callTurn:(payload:unknown,options?:any)=>Promise<any>,
 *   callSemantic:(payload:unknown)=>Promise<any>,
 *   renderSystemPrompt:(ctx:Record<string,unknown>)=>Promise<string>,
 *   withRun:(operation:()=>Promise<void>)=>Promise<void>,
 *   close?:()=>void,
 * }} deps.createController
 * @param {(seams:{
 *   runUserTurn:Function,
 *   renderSystemPrompt:Function,
 *   withRun:Function,
 * })=>Promise<{
 *   turnDeps:Record<string,any>,
 *   sessionDeps:Record<string,any>,
 *   isolationDeps:Record<string,any>,
 *   actorCount:()=>Promise<{activeActors:number}>|{activeActors:number},
 *   actorOverview:()=>Promise<{roots:any[]}>|{roots:any[]},
 *   relays?:Record<string,any>,
 *   close?:()=>Promise<void>|void,
 * }>} deps.loadRuntime
 * @param {number} [deps.loadTimeoutMs]
 * @param {()=>string} [deps.newId]
 */
export const createKernelTurnOwner = ({
  createController, loadRuntime,
  loadTimeoutMs = TURN_RUNTIME_LOAD_TIMEOUT_MS,
  newId,
}) => {
  if (typeof createController !== 'function' || typeof loadRuntime !== 'function') {
    throw new TypeError('kernel-turn-owner-config-invalid');
  }
  /** @type {ReturnType<typeof createController>|null} */
  let controller = null;
  const bridge = makeControllerTurnBridge({
    getClient: async () => ({
      call: (capability, payload, options) => {
        const live = controller;
        if (capability !== 'turn.run') return Promise.resolve({
          ok: false, code: 'controller-capability-denied', outcomeKnown: true,
        });
        return live ? live.callTurn(payload, options) : Promise.resolve({
          ok: false, code: 'controller-not-ready', outcomeKnown: true,
        });
      },
    }),
    ...(newId ? { newId } : {}),
  });
  controller = createController({
    authorizeTurnCall: bridge.authorize,
    handleTurnKernelCall: bridge.handleKernelCall,
  });
  if (typeof controller?.callTurn !== 'function'
      || typeof controller.callSemantic !== 'function'
      || typeof controller.renderSystemPrompt !== 'function'
      || typeof controller.withRun !== 'function') {
    bridge.close();
    throw new TypeError('kernel-turn-controller-invalid');
  }

  let closed = false;
  let stopEpoch = 0;
  /** @type {{close?:()=>Promise<void>|void,relays?:Record<string,any>}|null} */
  let runtime = null;
  /** @type {Record<string,(message?:any,sender?:any)=>Promise<any>>|null} */
  let liveRoutes = null;
  const load = makeBoundedModuleLoader(async () => {
    const loaded = await loadRuntime(Object.freeze({
      runUserTurn: bridge.runUserTurn,
      renderSystemPrompt: controller.renderSystemPrompt.bind(controller),
      withRun: controller.withRun.bind(controller),
    }));
    if (closed) {
      await loaded?.close?.();
      throw new Error('kernel-turn-owner-closed');
    }
    if (!loaded || typeof loaded !== 'object'
        || !loaded.turnDeps || !loaded.sessionDeps || !loaded.isolationDeps
        || typeof loaded.actorCount !== 'function'
        || typeof loaded.actorOverview !== 'function') {
      throw new TypeError('kernel-turn-runtime-invalid');
    }
    const routes = makeKernelSessionTurnRoutes({
      ...loaded,
      turnDeps: {
        ...loaded.turnDeps,
        admitSend: (/** @type {any} */ context) => context?.stopEpoch === stopEpoch,
      },
    });
    runtime = loaded;
    liveRoutes = routes;
    return { routes, runtime: loaded };
  }, {
    timeoutMs: loadTimeoutMs,
    loadCode: 'kernel-turn-runtime-load-failed',
    timeoutCode: 'kernel-turn-runtime-load-timeout',
  });

  const routes = Object.freeze(Object.fromEntries(
    KERNEL_SESSION_TURN_ROUTE_NAMES.map((name) => [name, async (
      /** @type {any} */ message = {}, /** @type {any} */ sender = undefined,
    ) => {
      if (closed) return closedFailure();
      if (name === 'agent/stop') {
        stopEpoch += 1;
        const stop = liveRoutes?.[name];
        return stop ? stop(message, sender) : { ok: true };
      }
      const ingressStopEpoch = stopEpoch;
      let live;
      try { live = await load(); }
      catch (cause) { return closed ? closedFailure() : startupFailure(cause); }
      return live.routes[name](message, name === 'agent/send'
        ? Object.freeze({ stopEpoch: ingressStopEpoch }) : sender);
    }]),
  ));
  const projection = async (/** @type {'actorCount'|'actorOverview'} */ method) => {
    if (closed) return closedFailure();
    try {
      const live = await load();
      return live.runtime[method]();
    } catch (cause) {
      return closed ? closedFailure() : startupFailure(
        Object.assign(new Error('actor projection unavailable'), {
          code: /** @type {{code?:string}} */ (cause)?.code
            ?? 'kernel-actor-projection-unavailable',
        }),
      );
    }
  };

  return Object.freeze({
    routes,
    controller,
    activeTurns: bridge.activeCount,
    actorCount: () => projection('actorCount'),
    actorOverview: () => projection('actorOverview'),
    get relays() { return runtime?.relays ?? null; },
    getRelays: async () => (await load()).runtime.relays ?? {},
    close: async () => {
      if (closed) return;
      closed = true;
      load.reset();
      const live = runtime;
      runtime = null;
      liveRoutes = null;
      try { await live?.close?.(); }
      finally {
        bridge.close();
        controller?.close?.();
      }
    },
  });
};
