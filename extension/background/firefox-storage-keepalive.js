// @ts-check
// Firefox-only storage.session event-page lifetime lease.

export const FIREFOX_ACTOR_KEEPALIVE_KEY = 'peerdActorHostKeepAlive';
export const FIREFOX_ACTOR_KEEPALIVE_MS = 10_000;
export const FIREFOX_ACTOR_KEEPALIVE_ACK_MS = 2_000;

/**
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
    void beginCleanup();
  };

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
 * @param {() => void|Promise<void>} deps.start
 * @param {() => void|Promise<void>} deps.stop
 */
export const makeRefCountedFirefoxBackgroundLifetime = ({ start, stop }) => {
  if (typeof start !== 'function' || typeof stop !== 'function') {
    throw new TypeError('firefox-background-lifetime-config-invalid');
  }
  /** @type {Set<{released:boolean,lost:Promise<Error>,lose:(error:Error)=>void}>} */
  const tokens = new Set();
  /** @type {Promise<void>|null} */
  let ready = null;
  /** @type {Promise<unknown>} */
  let transition = Promise.resolve();
  /** @type {Error|null} */
  let failure = null;
  const queue = (/** @type {()=>void|Promise<void>} */ operation) => {
    const result = transition.then(operation);
    transition = result.catch(() => {});
    return result;
  };
  const release = async (/** @type {any} */ token) => {
    if (!token || token.released) return;
    token.released = true;
    tokens.delete(token);
    if (tokens.size !== 0) return;
    ready = null;
    failure = null;
    await queue(stop).catch(() => {});
  };
  const acquire = async () => {
    if (failure && tokens.size > 0) throw failure;
    let lose = (/** @type {Error} */ _error) => {};
    const token = {
      released: false,
      lost: new Promise((resolve) => { lose = resolve; }),
      lose,
    };
    tokens.add(token);
    if (tokens.size === 1) {
      failure = null;
      ready = /** @type {Promise<void>} */ (queue(start));
    }
    try {
      await ready;
      if (failure) throw failure;
      return token;
    } catch (cause) {
      await release(token);
      throw cause;
    }
  };
  const fail = (/** @type {unknown} */ cause) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (failure) return;
    failure = error;
    for (const token of tokens) token.lose(error);
  };
  /**
   * @template T
   * @param {()=>Promise<T>|T} operation
   * @param {{outcomeKnownOnLoss?:boolean,code?:string,onLost?:(cause:Error)=>void}} [options]
   * @returns {Promise<T>}
   */
  const run = async (operation, {
    outcomeKnownOnLoss = false,
    code = 'firefox-background-lifetime-lost',
    onLost = () => {},
  } = {}) => {
    let token;
    try { token = await acquire(); }
    catch (cause) {
      const error = /** @type {Error & {code?:string,outcomeKnown?:boolean,phase?:string}} */ (
        cause instanceof Error ? cause : new Error(String(cause))
      );
      error.code ??= 'firefox-background-lifetime-startup-failed';
      error.outcomeKnown = true;
      error.phase = 'startup';
      throw error;
    }
    let crossedDispatch = false;
    const work = Promise.resolve().then(() => {
      crossedDispatch = true;
      return operation();
    });
    const lost = token.lost.then((cause) => {
      if (crossedDispatch) {
        try { onLost(cause); } catch { /* custody classification still wins */ }
      }
      const error = /** @type {Error & {code?:string,outcomeKnown?:boolean,phase?:string}} */ (
        new Error(`Firefox background lifetime was lost: ${cause.message}`)
      );
      error.code = code;
      error.outcomeKnown = crossedDispatch ? outcomeKnownOnLoss : true;
      error.phase = crossedDispatch ? 'run' : 'startup';
      throw error;
    });
    try { return await Promise.race([work, lost]); }
    finally { await release(token); }
  };
  const createHandle = () => {
    /** @type {Awaited<ReturnType<typeof acquire>>|null} */
    let token = null;
    return Object.freeze({
      async start() {
        if (!token) token = await acquire();
      },
      async stop() {
        const active = token;
        token = null;
        await release(active);
      },
    });
  };
  return Object.freeze({ acquire, release, run, createHandle, fail,
    snapshot: () => ({ active: tokens.size, lost: failure !== null }) });
};

/**
 * @param {Object} deps
 * @param {any} deps.browser
 * @param {{event:(key:string, raw:any, owner:string)=>any}} deps.registry
 * @param {(error:Error)=>void} [deps.onLost]
 * @param {typeof makeStorageSessionKeepAlive} [deps.makeKeepAlive]
 */
export const attachFirefoxStorageKeepAlive = ({
  browser,
  registry,
  onLost = () => {},
  makeKeepAlive = makeStorageSessionKeepAlive,
}) => {
  if (!browser?.storage?.session
      || typeof registry?.event !== 'function') {
    throw new TypeError('firefox-storage-keepalive-config-invalid');
  }
  const lifetime = makeKeepAlive({
    storage: browser.storage.session,
    key: FIREFOX_ACTOR_KEEPALIVE_KEY,
    intervalMs: FIREFOX_ACTOR_KEEPALIVE_MS,
    ackTimeoutMs: FIREFOX_ACTOR_KEEPALIVE_ACK_MS,
    onLost,
  });
  const event = registry.event(
    'storage.session.onChanged',
    browser.storage.session.onChanged,
    'kernel-firefox-actor-lifetime',
  );
  if (!event) throw new Error('firefox-storage-keepalive-event-unavailable');
  event.addListener((/** @type {Record<string, any>} */ changes) => {
    lifetime.onChanged(changes);
  });
  return Object.freeze(lifetime);
};
