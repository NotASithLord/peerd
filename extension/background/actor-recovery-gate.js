// @ts-check

/**
 * Collect internal mailbox correlations only from a durably appended user
 * message. The bound keeps malformed persisted data from becoming an
 * unbounded storage-removal request.
 * @param {any} message
 * @returns {string[]}
 */
export const actorDeliveryIdsFromMessage = (message) => {
  if (message?.role !== 'user') return [];
  const deliveryIds = new Set();
  const addDeliveryId = (/** @type {unknown} */ id) => {
    if (typeof id === 'string' && id.length > 0 && id.length <= 512) deliveryIds.add(id);
  };
  addDeliveryId(message.actorReply?.actorDeliveryId);
  for (const result of Array.isArray(message.toolResults) ? message.toolResults : []) {
    addDeliveryId(result?.actorDeliveryId);
    if (Array.isArray(result?.actorDeliveryIds)) {
      for (const id of result.actorDeliveryIds) addDeliveryId(id);
    }
  }
  return [...deliveryIds];
};

/**
 * Serialize passive actor-mailbox recovery and expose one gate for automatic
 * work. A retained receipt means storage did not accept the warning, so model
 * work stays paused while a later passive retry is scheduled.
 *
 * @param {Object} deps
 * @param {() => Promise<{ redrained: number, retained: number }>} deps.redrain
 * @param {(fn: () => void, delayMs: number) => any} [deps.schedule]
 * @param {number} [deps.retryMs]
 * @param {(error: unknown) => void} [deps.log]
 */
export const makeActorRecoveryGate = ({
  redrain,
  schedule = (fn, delayMs) => setTimeout(fn, delayMs),
  retryMs = 1_000,
  log = () => {},
}) => {
  /** @type {Promise<{ redrained: number, retained: number }> | null} */
  let recoveryPromise = null;
  let retryScheduled = false;
  /** @type {Map<string, () => Promise<any>|any>} */
  const pendingActions = new Map();
  /** @type {Promise<void> | null} */
  let flushPromise = null;

  const flushPendingActions = () => {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      while (pendingActions.size > 0) {
        const batch = [...pendingActions.values()];
        pendingActions.clear();
        for (const action of batch) {
          try { await action(); }
          catch (error) { log(error); }
        }
      }
    })().finally(() => { flushPromise = null; });
    return flushPromise;
  };

  const recover = () => {
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = redrain()
      .catch((error) => {
        log(error);
        return { redrained: 0, retained: 1 };
      })
      .then(async (status) => {
        if (status.retained > 0) {
          recoveryPromise = null;
          if (!retryScheduled) {
            retryScheduled = true;
            schedule(() => {
              retryScheduled = false;
              void recover();
            }, retryMs);
          }
        } else {
          await flushPendingActions();
        }
        return status;
      });
    return recoveryPromise;
  };

  /** @returns {Promise<boolean>} */
  const ready = async () => (await recover()).retained === 0;

  /**
   * Queue automatic work behind recovery. A stable key makes repeated boot,
   * alarm, and unlock nudges collapse to one eventual action.
   * @param {string} key
   * @param {() => Promise<any>|any} action
   */
  const runWhenReady = async (key, action) => {
    const recovery = await recover();
    if (recovery.retained > 0) {
      pendingActions.set(key, action);
      return false;
    }
    await action();
    return true;
  };

  return { recover, ready, runWhenReady };
};
