// @ts-check
// Firefox MV3 background-page host for the actor worker runner. Unlike the
// Chrome offscreen transport, this path is entirely in-process: no runtime
// message exposes actor relay routes or the per-run grant to extension pages.

import { runActor, abortActor } from '/offscreen/actor-runner.js';

/**
 * Own the Firefox event-page heartbeat behind one serialized state machine.
 * Firefox resets an MV3 event page's idle budget when storage.session changes.
 * This is Mozilla's documented extension-side workaround until the platform
 * exposes an official long-task lifetime signal.
 * @param {Object} deps
 * @param {{ set: (items: Record<string, unknown>) => Promise<void>, remove: (key: string) => Promise<void> }} deps.storage
 * @param {string} deps.key
 * @param {number} deps.intervalMs
 * @param {number} deps.ackTimeoutMs
 * @param {() => string} [deps.makeLeaseId]
 * @param {typeof setInterval} [deps.setIntervalFn]
 * @param {typeof clearInterval} [deps.clearIntervalFn]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 * @param {(error: Error) => void} [deps.onLost]
 */
export const makeStorageSessionKeepAlive = ({
  storage,
  key,
  intervalMs,
  ackTimeoutMs,
  makeLeaseId = () => crypto.randomUUID(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onLost = () => {},
}) => {
  let leaseIntended = false;
  let leaseEstablished = false;
  let leaseId = '';
  let sequence = 0;
  /** @type {ReturnType<typeof setInterval>|null} */
  let interval = null;
  /** @type {Promise<void>|null} */
  let pendingWrite = null;
  /** @type {Promise<void>} */
  let cleanupBarrier = Promise.resolve();
  let cleanupPending = false;
  /** @type {{ leaseId: string, sequence: number, resolve: () => void, reject: (error: Error) => void, timeout: ReturnType<typeof setTimeout> } | null} */
  let pendingAcknowledgment = null;
  /** @type {Promise<unknown>} */
  let transition = Promise.resolve();

  /** @param {() => unknown|Promise<unknown>} operation */
  const queue = (operation) => {
    const result = transition.then(operation);
    transition = result.catch(() => {});
    return result;
  };

  const writeHeartbeat = async () => {
    sequence += 1;
    const value = { leaseId, sequence };
    let resolveAcknowledgment = () => {};
    /** @type {(error: Error) => void} */
    let rejectAcknowledgment = () => {};
    /** @type {Promise<void>} */
    const acknowledgment = new Promise((resolve, reject) => {
      resolveAcknowledgment = resolve;
      rejectAcknowledgment = reject;
    });
    const timeout = setTimeoutFn(() => {
      const pending = pendingAcknowledgment;
      if (pending?.leaseId !== value.leaseId || pending?.sequence !== value.sequence) return;
      pendingAcknowledgment = null;
      pending.reject(new Error('actor host storage heartbeat was not acknowledged'));
    }, ackTimeoutMs);
    const expected = {
      ...value,
      resolve: resolveAcknowledgment,
      reject: rejectAcknowledgment,
      timeout,
    };
    pendingAcknowledgment = expected;
    const write = storage.set({ [key]: value });
    pendingWrite = write;
    try {
      await Promise.all([write, acknowledgment]);
      if (pendingWrite === write) pendingWrite = null;
    } catch (error) {
      if (pendingAcknowledgment === expected && expected) {
        clearTimeoutFn(expected.timeout);
        pendingAcknowledgment = null;
        expected.reject(error instanceof Error ? error : new Error(String(error)));
        await acknowledgment.catch(() => {});
      }
      throw error;
    }
  };

  const clearHeartbeat = async () => {
    if (interval !== null) {
      clearIntervalFn(interval);
      interval = null;
    }
    const write = pendingWrite;
    if (write) {
      await write.catch(() => {});
      if (pendingWrite === write) pendingWrite = null;
    }
    await storage.remove(key);
  };

  const beginCleanup = () => {
    if (cleanupPending) return cleanupBarrier;
    cleanupPending = true;
    cleanupBarrier = clearHeartbeat()
      .catch(() => {})
      .finally(() => { cleanupPending = false; });
    return cleanupBarrier;
  };

  const waitForCleanup = async () => {
    if (!cleanupPending) return;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timeout = null;
    const finished = await Promise.race([
      cleanupBarrier.then(() => true),
      new Promise((resolve) => {
        timeout = setTimeoutFn(() => resolve(false), ackTimeoutMs);
      }),
    ]);
    if (timeout !== null) clearTimeoutFn(timeout);
    if (!finished) throw new Error('previous actor host heartbeat cleanup is still pending');
  };

  const loseLease = (/** @type {unknown} */ reason) => {
    if (!leaseIntended) return;
    const notify = leaseEstablished;
    leaseIntended = false;
    leaseEstablished = false;
    if (notify) onLost(reason instanceof Error ? reason : new Error(String(reason)));
    void beginCleanup();
  };

  const tick = () => {
    void queue(async () => {
      if (!leaseIntended) return;
      try {
        await writeHeartbeat();
      } catch (error) {
        loseLease(error);
      }
    });
  };

  // why: a crash can strand the session key. Every acquisition waits on this
  // barrier, but a stuck storage removal gets only the bounded startup budget.
  void beginCleanup();

  const start = async () => {
    await waitForCleanup();
    await queue(async () => {
      leaseIntended = true;
      leaseEstablished = false;
      leaseId = makeLeaseId();
      sequence = 0;
      try {
        await writeHeartbeat();
        if (!leaseIntended) {
          void beginCleanup();
          throw new Error('actor host storage heartbeat stopped during startup');
        }
        leaseEstablished = true;
        interval = setIntervalFn(tick, intervalMs);
      } catch (error) {
        leaseIntended = false;
        leaseEstablished = false;
        void beginCleanup();
        throw error;
      }
    });
  };

  const stop = () => {
    leaseIntended = false;
    leaseEstablished = false;
    if (interval !== null) {
      clearIntervalFn(interval);
      interval = null;
    }
    if (cleanupPending) return;
    // why: actor completion must not wait forever on best-effort storage
    // cleanup. A later start observes the barrier and fails closed if needed.
    void beginCleanup();
  };

  // why: Mozilla's workaround requires an extension listener for the
  // storage.session change event. Matching the exact lease generation makes
  // each write prove that event path before actor work begins or continues.
  /** @param {Record<string, { oldValue?: unknown, newValue?: unknown }>} changes */
  const onChanged = (changes) => {
    if (!Object.hasOwn(changes, key)) return false;
    const value = /** @type {{ leaseId?: unknown, sequence?: unknown } | undefined} */ (
      changes[key]?.newValue
    );
    const oldValue = /** @type {{ leaseId?: unknown } | undefined} */ (
      changes[key]?.oldValue
    );
    const expected = pendingAcknowledgment;
    if (expected
        && value?.leaseId === expected.leaseId
        && value?.sequence === expected.sequence) {
      clearTimeoutFn(expected.timeout);
      pendingAcknowledgment = null;
      expected.resolve();
      return true;
    }
    // A cold-start cleanup event can arrive after its remove() promise settles.
    // If a heartbeat write is pending, wait for that exact write's event or its
    // timeout instead of mistaking the earlier deletion for active tampering.
    if (value === undefined
        && (expected || oldValue?.leaseId !== leaseId)) return false;
    if (!leaseIntended) return false;
    const error = new Error('actor host storage heartbeat changed unexpectedly');
    if (expected) {
      clearTimeoutFn(expected.timeout);
      pendingAcknowledgment = null;
      expected.reject(error);
    }
    void queue(() => loseLease(error));
    return false;
  };

  return { start, stop, onChanged };
};

/**
 * @param {Object} deps
 * @param {string} deps.workerUrl
 * @param {typeof runActor} [deps.run]
 * @param {typeof abortActor} [deps.abort]
 * @param {() => void|Promise<void>} [deps.startKeepAlive]
 * @param {() => void|Promise<void>} [deps.stopKeepAlive]
 */
export const makeDirectActorHost = ({
  workerUrl,
  run = runActor,
  abort = abortActor,
  startKeepAlive = () => {},
  stopKeepAlive = () => {},
}) => {
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
      if (runId) abort(runId);
      settle(error);
    }
  };

  /** @param {{ type?: string, runId?: string, job?: any }} message */
  const sendMessage = async (message) => {
    if (message?.type === 'actor/abort') {
      if (typeof message.runId === 'string') abort(message.runId);
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
      const actorRun = run(message.job, {
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

  return { bindRelayRoutes, isRelaySender, failKeepAlive, sendMessage };
};
