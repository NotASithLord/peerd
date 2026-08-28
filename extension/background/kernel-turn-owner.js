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
 * @param {(authority:{authorizeTurnCall:Function,handleTurnKernelCall:Function,
 *   authorizeComposeCall:Function,handleComposeKernelCall:Function})=>{
 *   callTurn:(payload:unknown,options?:any)=>Promise<any>,
 *   renderSystemPrompt:(ctx:Record<string,unknown>)=>Promise<string>,
 *   projectTurnTools:(ctx:Record<string,unknown>)=>Promise<{tools:any[],operations:string[]}>,
 *   planToolsCommand:(input:Record<string,unknown>)=>Promise<any>,
 *   composeTurn:(input:{text:string},options?:{signal?:AbortSignal})=>Promise<any>,
 *   withRun:(operation:()=>Promise<void>)=>Promise<void>,
 *   release:()=>void,
 * }} deps.createController
 * @param {(seams:{
 *   runUserTurn:Function,
 *   renderSystemPrompt:Function,
 *   projectTurnTools:Function,
 *   planToolsCommand:Function,
 *   composeTurn:Function,
 *   withRun:Function,
 * })=>Promise<{
 *   turnDeps:Record<string,any>,
 *   sessionDeps:Record<string,any>,
 *   isolationDeps:Record<string,any>,
 *   actorCount:()=>Promise<{activeActors:number}>|{activeActors:number},
 *   actorOverview:()=>Promise<{roots:any[]}>|{roots:any[]},
 *   relays?:Record<string,any>,
 *   composeAuthority?:{authorize:Function,handleKernelCall:Function},
 *   close?:()=>Promise<void>|void,
 * }>} deps.loadRuntime
 * @param {number} [deps.loadTimeoutMs]
 * @param {()=>string} [deps.newId]
 * @param {ReturnType<import('./provider-egress-authority.js').createProviderEgressAuthority>}
 *   [deps.providerEgress]
 * @param {ReturnType<import('./authority-effect-scheduler.js').createAuthorityEffectScheduler>}
 *   [deps.authorityScheduler]
 * @param {(runtime:Record<string,any>,custody:{isCurrent:()=>boolean,publish:()=>boolean})=>Promise<void>|void} [deps.onLoaded]
 */
export const createKernelTurnOwner = ({
  createController, loadRuntime, onLoaded,
  loadTimeoutMs = TURN_RUNTIME_LOAD_TIMEOUT_MS,
  newId, providerEgress, authorityScheduler,
}) => {
  if (typeof createController !== 'function' || typeof loadRuntime !== 'function') {
    throw new TypeError('kernel-turn-owner-config-invalid');
  }
  /** @type {{
   *   epoch:number,
   *   runtime:{close?:()=>Promise<void>|void,relays?:Record<string,any>,composeAuthority?:any},
   *   routes:Record<string,(message?:any,sender?:any)=>Promise<any>>,
   *   release:()=>Promise<void>,
   *   retire:()=>void,
   *   published:boolean,
   * }|null} */
  let live = null;
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
    providerEgress,
    authorityScheduler,
    ...(newId ? { newId } : {}),
  });
  controller = createController({
    authorizeTurnCall: bridge.authorize,
    handleTurnKernelCall: bridge.handleKernelCall,
    authorizeComposeCall: (/** @type {unknown} */ payload) =>
      live?.runtime.composeAuthority?.authorize(payload) ?? null,
    handleComposeKernelCall: (/** @type {string} */ operation,
      /** @type {unknown} */ payload, /** @type {any} */ context) =>
      live?.runtime.composeAuthority?.handleKernelCall(operation, payload, context)
        ?? { ok: false, code: 'kernel-operation-denied', outcomeKnown: true },
  });
  if (typeof controller?.callTurn !== 'function'
      || typeof controller.renderSystemPrompt !== 'function'
      || typeof controller.projectTurnTools !== 'function'
      || typeof controller.planToolsCommand !== 'function'
      || typeof controller.composeTurn !== 'function'
      || typeof controller.withRun !== 'function'
      || typeof controller.release !== 'function') {
    void bridge.close();
    throw new TypeError('kernel-turn-controller-invalid');
  }

  let closed = false;
  let stopEpoch = 0;
  /** @type {()=>void} */
  let closeHandoff;
  /** @type {Promise<void>} */
  const handoffClosed = new Promise((resolve) => { closeHandoff = () => resolve(); });
  let loadEpoch = 0;
  const claimedRuntimes = new WeakSet();
  const loadCandidate = async (/** @type {number} */ epoch) => {
    const loaded = await loadRuntime(Object.freeze({
      runUserTurn: bridge.runUserTurn,
      renderSystemPrompt: controller.renderSystemPrompt.bind(controller),
      projectTurnTools: controller.projectTurnTools.bind(controller),
      planToolsCommand: controller.planToolsCommand.bind(controller),
      composeTurn: controller.composeTurn.bind(controller),
      withRun: controller.withRun.bind(controller),
    }));
    if (!loaded || typeof loaded !== 'object'
        || !loaded.turnDeps || !loaded.sessionDeps || !loaded.isolationDeps
        || typeof loaded.actorCount !== 'function'
        || typeof loaded.actorOverview !== 'function') {
      await loaded?.close?.();
      throw new TypeError('kernel-turn-runtime-invalid');
    }
    if (claimedRuntimes.has(loaded)) throw new Error('kernel-turn-runtime-reused');
    claimedRuntimes.add(loaded);
    /** @type {Promise<void>|null} */
    let releasePending = null;
    const release = async () => {
      releasePending ||= (async () => { await loaded?.close?.(); })();
      await releasePending;
    };
    if (closed || epoch !== loadEpoch) {
      await release();
      throw new Error('kernel-turn-owner-closed');
    }
    let routes;
    try {
      routes = makeKernelSessionTurnRoutes({
        ...loaded,
        turnDeps: {
          ...loaded.turnDeps,
          admitSend: (/** @type {any} */ context) => context?.stopEpoch === stopEpoch,
        },
      });
    } catch (cause) {
      await release();
      throw cause;
    }
    /** @type {()=>void} */
    let retire = () => {};
    /** @type {Promise<void>} */
    const retired = new Promise((resolve) => { retire = () => resolve(); });
    const candidate = { epoch, runtime: loaded, routes, release, retire, published: false };
    live = candidate;
    try {
      const handoff = await Promise.race([
        Promise.resolve().then(() => onLoaded?.(loaded, Object.freeze({
          isCurrent: () => !closed && epoch === loadEpoch && live === candidate,
          publish: () => {
            if (closed || epoch !== loadEpoch || live !== candidate) return false;
            candidate.published = true;
            return true;
          },
        }))).then(() => 'ready'),
        handoffClosed.then(() => 'closed'),
        retired.then(() => 'retired'),
      ]);
      if (handoff !== 'ready' || closed || epoch !== loadEpoch || live !== candidate) {
        await release();
        throw new Error('kernel-turn-owner-closed');
      }
      candidate.published = true;
    }
    catch (cause) {
      if (live === candidate) live = null;
      await release();
      throw cause;
    }
    return candidate;
  };
  const makeLoadLane = (/** @type {number} */ epoch) => makeBoundedModuleLoader(
    () => loadCandidate(epoch),
    {
      timeoutMs: loadTimeoutMs,
      loadCode: 'kernel-turn-runtime-load-failed',
      timeoutCode: 'kernel-turn-runtime-load-timeout',
    },
  );
  let load = makeLoadLane(loadEpoch);
  const retireTimedOutHandoff = (/** @type {number} */ epoch) => {
    const candidate = live;
    if (epoch !== loadEpoch) return;
    if (candidate?.epoch === epoch) live = null;
    loadEpoch += 1;
    load = makeLoadLane(loadEpoch);
    if (candidate?.epoch === epoch) {
      candidate.retire();
      void candidate.release().catch(() => {});
    }
  };

  const routes = Object.freeze(Object.fromEntries(
    KERNEL_SESSION_TURN_ROUTE_NAMES.map((name) => [name, async (
      /** @type {any} */ message = {}, /** @type {any} */ sender = undefined,
    ) => {
      if (closed) return closedFailure();
      if (name === 'agent/stop') {
        stopEpoch += 1;
        const stop = live?.routes[name];
        return stop ? stop(message, sender) : { ok: true };
      }
      const ingressStopEpoch = stopEpoch;
      const ingressLoadEpoch = loadEpoch;
      let loadedOwner;
      try { loadedOwner = await load(); }
      catch (cause) {
        if (/** @type {{code?:unknown}} */ (cause)?.code
            === 'kernel-turn-runtime-load-timeout') {
          retireTimedOutHandoff(ingressLoadEpoch);
        }
        return closed ? closedFailure() : startupFailure(cause);
      }
      if (closed) return closedFailure();
      if (ingressLoadEpoch !== loadEpoch || live !== loadedOwner) {
        return startupFailure({ code: 'kernel-turn-runtime-load-timeout' });
      }
      return loadedOwner.routes[name](message, name === 'agent/send'
        ? Object.freeze({ stopEpoch: ingressStopEpoch }) : sender);
    }]),
  ));
  const projection = async (/** @type {'actorCount'|'actorOverview'} */ method) => {
    if (closed) return closedFailure();
    const ingressLoadEpoch = loadEpoch;
    try {
      const loadedOwner = await load();
      if (closed) return closedFailure();
      if (ingressLoadEpoch !== loadEpoch || live !== loadedOwner) {
        return startupFailure({ code: 'kernel-turn-runtime-load-timeout' });
      }
      return loadedOwner.runtime[method]();
    } catch (cause) {
      if (/** @type {{code?:unknown}} */ (cause)?.code
          === 'kernel-turn-runtime-load-timeout') {
        retireTimedOutHandoff(ingressLoadEpoch);
      }
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
    get relays() { return live?.published ? live.runtime.relays ?? null : null; },
    getRelays: async () => {
      if (closed) throw new Error('kernel-turn-owner-closed');
      const ingressLoadEpoch = loadEpoch;
      let loaded;
      try { loaded = await load(); }
      catch (cause) {
        if (/** @type {{code?:unknown}} */ (cause)?.code
            === 'kernel-turn-runtime-load-timeout') {
          retireTimedOutHandoff(ingressLoadEpoch);
        }
        throw cause;
      }
      if (closed) throw new Error('kernel-turn-owner-closed');
      if (ingressLoadEpoch !== loadEpoch || live !== loaded) {
        throw Object.assign(new Error('kernel-turn-runtime-load-timeout'), {
          code: 'kernel-turn-runtime-load-timeout',
        });
      }
      return loaded.runtime.relays ?? {};
    },
    close: async () => {
      if (closed) return;
      closed = true;
      closeHandoff();
      loadEpoch += 1;
      load.reset();
      const current = live;
      live = null;
      current?.retire();
      try { await current?.release(); }
      finally {
        await bridge.close();
        controller.release();
      }
    },
  });
};
