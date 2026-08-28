// @ts-check
// Firefox MV3 background-page host for the actor worker runner. Unlike the
// Chrome offscreen transport, this path is entirely in-process: no runtime
// message exposes actor relay routes or the per-run grant to extension pages.

export {
  makeRefCountedFirefoxBackgroundLifetime,
  makeStorageSessionKeepAlive,
} from './firefox-storage-keepalive.js';
import {
  makeBoundedModuleLoader, STARTUP_UNAVAILABLE_USER_FAILURE,
} from '/shared/bounded-module-load.js';

/** @typedef {Pick<typeof import('/offscreen/actor-runner.js'), 'runActor'|'abortActor'>} ActorRunner */
// Chrome never uses the Firefox background-page host, so keep its runner out
// of the cold service-worker graph. Firefox background pages support import().
const loadActorRunner = () => import('/offscreen/actor-runner.js');

/**
 * @param {Object} deps
 * @param {string} deps.workerUrl
 * @param {ActorRunner['runActor']} [deps.run]
 * @param {ActorRunner['abortActor']} [deps.abort]
 * @param {() => Promise<ActorRunner>} [deps.loadRunner]
 * @param {number} [deps.loadTimeoutMs]
 * @param {number} [deps.relayDrainTimeoutMs]
 * @param {() => void|Promise<void>} [deps.startKeepAlive]
 * @param {() => void|Promise<void>} [deps.stopKeepAlive]
 * @param {(error:Error) => void|Promise<void>} [deps.onKeepAliveLost]
 * @param {number} [deps.healthTransitionTimeoutMs]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 */
export const makeDirectActorHost = ({
  workerUrl,
  run,
  abort,
  loadRunner = loadActorRunner,
  loadTimeoutMs,
  relayDrainTimeoutMs = 5_000,
  startKeepAlive = () => {},
  stopKeepAlive = () => {},
  onKeepAliveLost = () => {},
  healthTransitionTimeoutMs = 1_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  let runnerLoaded = false;
  const runner = makeBoundedModuleLoader(loadRunner, {
    ...(loadTimeoutMs === undefined ? {} : { timeoutMs: loadTimeoutMs }),
    loadCode: 'actor_host_load_failed',
    timeoutCode: 'actor_host_load_timeout',
  });
  const abortActor = abort ?? ((runId) => {
    if (runnerLoaded) void runner().then((value) => value.abortActor(runId)).catch(() => {});
  });
  // Object identity is the sender proof. It never leaves this closure and is
  // never posted, serialized, stored, or exposed on runtime.onMessage.
  const relaySender = Object.freeze({});
  /** @type {Record<string, (payload: any, sender?: unknown) => any> | null} */
  let relayRoutes = null;
  let activeRuns = 0;
  /** @type {Promise<void>} */
  let keepAliveTransition = Promise.resolve();
  /** @type {Promise<void>|null} */
  let keepAliveReady = null;
  /** @type {Error|null} */
  let keepAliveLoss = null;
  /** @type {Map<symbol, { runId: string|null, started:boolean, stopped:boolean, lossReady:Promise<void>|null, armDrain:()=>void, settle:(value:any)=>void }>} */
  const activeRunLosses = new Map();
  const pendingAborts = new Set();

  /** @param {() => void|Promise<void>} operation */
  const queueKeepAliveTransition = (operation) => {
    const result = keepAliveTransition.then(operation);
    // why: one rejected transition must not poison a later manual retry.
    keepAliveTransition = result.catch(() => {});
    return result;
  };
  /** @param {boolean} allowRecovery */
  const retainBackground = async (allowRecovery) => {
    if (keepAliveLoss) {
      if (!allowRecovery || activeRuns > 0) throw keepAliveLoss;
      keepAliveLoss = null;
    }
    activeRuns += 1;
    if (activeRuns === 1) keepAliveReady = queueKeepAliveTransition(startKeepAlive);
    const ready = keepAliveReady;
    if (!ready) {
      activeRuns = Math.max(0, activeRuns - 1);
      throw new Error('keepalive lease was not created');
    }
    try {
      await ready;
    } catch (error) {
      activeRuns = Math.max(0, activeRuns - 1);
      if (activeRuns === 0 && keepAliveReady === ready) {
        keepAliveReady = null;
        // Keep cleanup serialized without making a pre-start refusal wait on a
        // storage call that may itself be stuck. A later acquisition queues
        // behind this cleanup before it can start.
        void queueKeepAliveTransition(stopKeepAlive).catch(() => {});
      }
      throw error;
    }
  };
  const releaseBackground = async () => {
    activeRuns = Math.max(0, activeRuns - 1);
    if (activeRuns !== 0 || !keepAliveReady) return;
    keepAliveReady = null;
    // Queue the clear before yielding. A new run then queues its start after
    // this clear and cannot lose its newly-created heartbeat to an older release.
    await queueKeepAliveTransition(stopKeepAlive).catch(() => {});
  };

  /** @param {Record<string, (payload: any, sender?: unknown) => any>} routes */
  const bindRelayRoutes = (routes) => { relayRoutes = routes; };
  const isRelaySender = (/** @type {unknown} */ sender) => sender === relaySender;
  /** @param {Error} error @returns {Promise<void>} */
  const completeHealthTransition = (error) => new Promise((resolve) => {
    let finished = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeoutFn(timer);
      resolve();
    };
    timer = setTimeoutFn(finish, Math.max(1, healthTransitionTimeoutMs));
    void Promise.resolve().then(() => onKeepAliveLost(error)).catch(() => {}).then(finish);
  });
  const failKeepAlive = (/** @type {unknown} */ reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    if (keepAliveLoss) return;
    keepAliveLoss = error;
    // why: actor isolation health is host authority, not a later semantic
    // result code. Every lost-run result waits for this bounded transition so
    // a successor demand cannot race ahead of the durable refusal.
    const lossReady = completeHealthTransition(error);
    for (const active of activeRunLosses.values()) {
      active.stopped = true;
      active.lossReady = lossReady;
      if (active.started && active.runId) abortActor(active.runId);
      active.settle({
        ok: false,
        started: active.started,
        phase: active.started ? 'run' : 'startup',
        code: 'actor_host_keepalive_lost',
        error: `direct actor host: ${error.message}`,
        outcomeKnown: !active.started,
      });
    }
  };

  /** @param {{ type?: string, runId?: string, job?: any }} message */
  const sendMessage = async (message) => {
    if (message?.type === 'actor/abort') {
      if (typeof message.runId === 'string') {
        let activeMatch = false;
        for (const active of activeRunLosses.values()) {
          if (active.runId !== message.runId) continue;
          activeMatch = true;
          if (active.started) {
            abortActor(message.runId);
            active.armDrain();
          }
          else {
            active.stopped = true;
            active.settle({
              ok: false, started: false, phase: 'startup',
              code: 'actor_host_aborted', outcomeKnown: true,
            });
          }
        }
        if (!activeMatch) {
          pendingAborts.add(message.runId);
          const oldest = pendingAborts.values().next().value;
          if (pendingAborts.size > 256 && typeof oldest === 'string') pendingAborts.delete(oldest);
          abortActor(message.runId);
        }
      }
      return { ok: true };
    }
    if (message?.type !== 'actor/run' || !message.job) {
      return { ok: false, started: false, code: 'actor_host_bad_request', error: 'direct actor host: unsupported request' };
    }
    if (!relayRoutes) {
      return { ok: false, started: false, code: 'actor_host_not_ready', error: 'direct actor host: relay routes are not bound' };
    }
    try {
      await retainBackground(message.job.probeOnly === true);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        started: false,
        code: 'actor_host_keepalive_failed',
        error: `direct actor host: could not retain background: ${detail}`,
      };
    }
    try {
      const runKey = Symbol('direct-actor-run');
      const runId = typeof message.job.runId === 'string' ? message.job.runId : null;
      if (runId && pendingAborts.delete(runId)) {
        return {
          ok: false, started: false, phase: 'startup',
          code: 'actor_host_aborted', outcomeKnown: true,
        };
      }
      /** @type {(value:any)=>void} */
      let settle = () => {};
      const active = {
        runId, started: false, stopped: false, lossReady: null,
        armDrain: () => {},
        settle: (/** @type {any} */ value) => settle(value),
      };
      let relayDrainTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
      const armRelayDrain = () => {
        if (active.stopped || relayDrainTimer) return;
        relayDrainTimer = setTimeoutFn(() => {
          active.stopped = true;
          if (runId) abortActor(runId);
          active.settle({
            ok: false, started: true, phase: 'run',
            code: 'actor_relay_drain_timeout',
            error: 'direct actor host relay drain timed out',
            outcomeKnown: false, retryable: false,
          });
        }, Math.max(1, relayDrainTimeoutMs));
      };
      active.armDrain = armRelayDrain;
      const stopped = new Promise((resolve) => {
        settle = resolve;
      });
      activeRunLosses.set(runKey, active);
      const actorRun = (async () => {
        let execute = run;
        if (!execute) {
          let loaded;
          try { loaded = await runner(); }
          catch (cause) {
            return {
              ok: false,
              started: false,
              phase: 'startup',
              code: /** @type {{code?:string}} */ (cause)?.code ?? 'actor_host_load_failed',
              error: STARTUP_UNAVAILABLE_USER_FAILURE,
              outcomeKnown: true,
            };
          }
          if (active.stopped) return undefined;
          runnerLoaded = true;
          execute = loaded.runActor;
        }
        if (active.stopped) return undefined;
        if (typeof execute !== 'function') {
          return {
            ok: false, started: false, phase: 'startup',
            code: 'actor_host_load_failed', outcomeKnown: true,
          };
        }
        active.started = true;
        try {
          return await execute(message.job, {
            workerUrl,
            onRelayDrain: armRelayDrain,
            sendToSW: async (type, payload) => {
              const route = relayRoutes?.[type];
              if (!route) return { ok: false, error: `direct actor host: unknown relay '${type}'` };
              return route(payload, relaySender);
            },
          });
        } catch (cause) {
          return {
            ok: false,
            started: true,
            phase: 'run',
            code: 'actor_host_run_failed',
            error: `direct actor host: ${cause instanceof Error ? cause.message : String(cause)}`,
            outcomeKnown: false,
          };
        }
      })();
      try {
        const result = await Promise.race([actorRun, stopped]);
        await active.lossReady;
        return result;
      } finally {
        if (relayDrainTimer) clearTimeoutFn(relayDrainTimer);
        activeRunLosses.delete(runKey);
      }
    } finally { await releaseBackground(); }
  };

  return {
    bindRelayRoutes, isRelaySender, failKeepAlive, sendMessage,
    hasActiveRuns: () => activeRuns > 0 || activeRunLosses.size > 0,
  };
};
