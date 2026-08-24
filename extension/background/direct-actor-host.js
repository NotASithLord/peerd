// @ts-check
// Firefox MV3 background-page host for the actor worker runner. Unlike the
// Chrome offscreen transport, this path is entirely in-process: no runtime
// message exposes actor relay routes or the per-run grant to extension pages.

export {
  makeRefCountedFirefoxBackgroundLifetime,
  makeStorageSessionKeepAlive,
} from './firefox-storage-keepalive.js';

/** @typedef {Pick<typeof import('/offscreen/actor-runner.js'), 'runActor'|'abortActor'>} ActorRunner */
/** @type {Promise<ActorRunner> | null} */
let actorRunnerPromise = null;
// Chrome never uses the Firefox background-page host, so keep its runner out
// of the cold service-worker graph. Firefox background pages support import().
const loadActorRunner = () => actorRunnerPromise ??= import('/offscreen/actor-runner.js');

/**
 * @param {Object} deps
 * @param {string} deps.workerUrl
 * @param {ActorRunner['runActor']} [deps.run]
 * @param {ActorRunner['abortActor']} [deps.abort]
 * @param {() => Promise<ActorRunner>} [deps.loadRunner]
 * @param {() => void|Promise<void>} [deps.startKeepAlive]
 * @param {() => void|Promise<void>} [deps.stopKeepAlive]
 */
export const makeDirectActorHost = ({
  workerUrl,
  run,
  abort,
  loadRunner = loadActorRunner,
  startKeepAlive = () => {},
  stopKeepAlive = () => {},
}) => {
  /** @type {Promise<ActorRunner> | null} */
  let runnerPromise = null;
  const runner = () => runnerPromise ??= loadRunner();
  const runActor = run ?? (async (...args) => (await runner()).runActor(...args));
  const abortActor = abort ?? ((runId) => {
    void runner().then((value) => value.abortActor(runId)).catch(() => {});
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
  /** @type {Map<symbol, { runId: string|null, settle: (error: Error) => void }>} */
  const activeRunLosses = new Map();

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
  const failKeepAlive = (/** @type {unknown} */ reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    if (keepAliveLoss) return;
    keepAliveLoss = error;
    for (const { runId, settle } of activeRunLosses.values()) {
      if (runId) abortActor(runId);
      settle(error);
    }
  };

  /** @param {{ type?: string, runId?: string, job?: any }} message */
  const sendMessage = async (message) => {
    if (message?.type === 'actor/abort') {
      if (typeof message.runId === 'string') abortActor(message.runId);
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
      const keepAliveLost = new Promise((resolve) => {
        activeRunLosses.set(runKey, {
          runId,
          settle: (error) => resolve({
            ok: false,
            started: true,
            phase: 'run',
            code: 'actor_host_keepalive_lost',
            error: `direct actor host: ${error.message}`,
            outcomeKnown: false,
          }),
        });
      });
      const actorRun = runActor(message.job, {
        workerUrl,
        sendToSW: async (type, payload) => {
          const route = relayRoutes?.[type];
          if (!route) return { ok: false, error: `direct actor host: unknown relay '${type}'` };
          return route(payload, relaySender);
        },
      });
      try {
        return await Promise.race([actorRun, keepAliveLost]);
      } finally {
        activeRunLosses.delete(runKey);
      }
    } finally { await releaseBackground(); }
  };

  return {
    bindRelayRoutes, isRelaySender, failKeepAlive, sendMessage,
    hasActiveRuns: () => activeRuns > 0 || activeRunLosses.size > 0,
  };
};
