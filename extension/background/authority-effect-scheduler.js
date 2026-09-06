// @ts-check

// Exact resources serialize their own state-changing effects. Unrelated tabs,
// instances, repositories and sessions remain independent, so a slow prompt or
// network operation cannot freeze the extension. A page program keeps an
// opaque private lease for nested effects and drains it before its target lane
// is released.

/** @typedef {{barrier:Promise<unknown>,reads:Set<Promise<unknown>>}} AuthorityLane */
/** @typedef {{lane:AuthorityLane,open:boolean,target:string|null}} AuthorityLease */
/** @typedef {{lane:AuthorityLane,users:number,poisoned:boolean}} TargetLane */

/** @returns {AuthorityLane} */
const makeLane = () => ({
  barrier: Promise.resolve(),
  reads: new Set(),
});

/** @param {AuthorityLane} lane @param {boolean} read @param {AbortSignal|undefined} signal */
const enterLane = async (lane, read, signal) => {
  let releaseHold = () => {};
  const released = new Promise((resolve) => { releaseHold = () => resolve(undefined); });
  const prior = lane.barrier;
  const readsBefore = read ? [] : [...lane.reads];
  const started = read ? Promise.resolve(prior) : Promise.allSettled([prior, ...readsBefore]);
  const hold = started.then(() => released);
  hold.catch(() => {});
  if (read) lane.reads.add(hold);
  else lane.barrier = hold.catch(() => {});
  let removeAbort = () => {};
  const aborted = new Promise((_, reject) => {
    const onAbort = () => reject(Object.assign(
      new Error('authority run stopped while waiting for its target'),
      { code: 'authority-run-aborted', outcomeKnown: true, retryable: false },
    ));
    signal?.addEventListener('abort', onAbort, { once: true });
    removeAbort = () => signal?.removeEventListener('abort', onAbort);
  });
  try {
    if (signal?.aborted) throw Object.assign(
      new Error('authority run stopped while waiting for its target'),
      { code: 'authority-run-aborted', outcomeKnown: true, retryable: false },
    );
    await (signal ? Promise.race([started, aborted]) : started);
  } catch (cause) {
    releaseHold();
    lane.reads.delete(hold);
    throw cause;
  } finally { removeAbort(); }
  let releasedOnce = false;
  return () => {
    if (releasedOnce) return;
    releasedOnce = true;
    releaseHold();
    lane.reads.delete(hold);
  };
};

/**
 * @param {{abortDrainMs?:number,setTimeoutFn?:typeof setTimeout,
 *   clearTimeoutFn?:typeof clearTimeout}} [options]
 */
export const createAuthorityEffectScheduler = ({
  abortDrainMs = 250,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) => {
  /** @type {Map<string,TargetLane>} */
  const targetLanes = new Map();
  /** @type {WeakSet<object>} */
  const activeLeases = new WeakSet();
  return Object.freeze({
    run: async (
      /** @type {{read:boolean,target?:string|null,parentLease?:object|null,scopeOnly?:boolean,signal?:AbortSignal}} */ options,
      /** @type {(lease:object)=>Promise<any>|any} */ execute,
    ) => {
      const parent = options.parentLease;
      if (parent && (!activeLeases.has(parent)
          || /** @type {{open?:boolean}} */ (parent).open !== true)) {
        throw new Error('authority-parent-lease-retired');
      }
      const target = typeof options.target === 'string' && options.target
        ? options.target : 'authority:unscoped';
      const poisoned = targetLanes.get(target);
      if (poisoned?.poisoned === true) {
        throw Object.assign(new Error('authority target is poisoned until host restart'), {
          code: 'authority-target-poisoned', outcomeKnown: false, retryable: false,
        });
      }
      let targetEntry = null;
      const parentTarget = /** @type {{target?:string}} */ (parent)?.target;
      const needsTargetLane = options.scopeOnly !== true && (!parent || parentTarget !== target);
      if (needsTargetLane) {
        targetEntry = targetLanes.get(target) ?? { lane: makeLane(), users: 0, poisoned: false };
        targetEntry.users += 1;
        targetLanes.set(target, targetEntry);
      }
      const parentLane = parent
        ? /** @type {{lane:{barrier:Promise<unknown>,reads:Set<Promise<unknown>>}}} */ (parent).lane
        : null;
      /** @type {null|(()=>void)} */
      let releaseParent = null;
      /** @type {null|(()=>void)} */
      let releaseTarget = null;
      /** @type {AuthorityLease|null} */
      let lease = null;
      try {
        releaseParent = parentLane
          ? await enterLane(parentLane, options.read === true, options.signal) : null;
        releaseTarget = targetEntry
          ? await enterLane(targetEntry.lane, options.read === true, options.signal) : null;
        if (targetEntry?.poisoned === true) {
          throw Object.assign(new Error('authority target is poisoned until host restart'), {
            code: 'authority-target-poisoned', outcomeKnown: false, retryable: false,
          });
        }
        lease = /** @type {AuthorityLease} */ (parent && activeLeases.has(parent)
          ? parent : { lane: makeLane(), open: true, target: options.scopeOnly ? null : target });
        activeLeases.add(lease);
        if (options.signal?.aborted) {
          throw Object.assign(new Error('authority run stopped before host dispatch'), {
            code: 'authority-run-aborted', outcomeKnown: true, retryable: false,
          });
        }
        let hostStarted = false;
        const execution = Promise.resolve().then(() => {
          hostStarted = true;
          return execute(/** @type {AuthorityLease} */ (lease));
        });
        execution.catch(() => {});
        if (!options.signal) return await execution;
        const settled = execution.then(
          (value) => ({ status: 'fulfilled', value }),
          (cause) => ({ status: 'rejected', cause }),
        );
        let removeAbort = () => {};
        const aborted = new Promise((resolve) => {
          const onAbort = () => {
            resolve({ status: 'aborted' });
          };
          options.signal?.addEventListener('abort', onAbort, { once: true });
          removeAbort = () => options.signal?.removeEventListener('abort', onAbort);
        });
        try {
          const first = await Promise.race([settled, aborted]);
          if (first.status === 'fulfilled') return first.value;
          if (first.status === 'rejected') throw first.cause;
          if (!hostStarted) {
            throw Object.assign(new Error('authority run stopped before host dispatch'), {
              code: 'authority-run-aborted', outcomeKnown: true, retryable: false,
            });
          }
          let timer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
          const drainExpired = new Promise((resolve) => {
            timer = setTimeoutFn(() => resolve({ status: 'drain-expired' }), abortDrainMs);
          });
          const drained = await Promise.race([settled, drainExpired]);
          if (timer !== null) clearTimeoutFn(timer);
          if (drained.status === 'fulfilled') return drained.value;
          if (drained.status === 'rejected') throw drained.cause;
          const targetToPoison = targetEntry ?? targetLanes.get(target) ?? null;
          if (targetToPoison) targetToPoison.poisoned = true;
          throw Object.assign(new Error('authority host did not settle before cancellation'), {
            code: 'authority-target-poisoned', outcomeKnown: false, retryable: false,
          });
        }
        finally { removeAbort(); }
      }
      finally {
        if (lease && lease !== parent) {
          lease.open = false;
          if (!targetEntry?.poisoned) {
            await Promise.allSettled([lease.lane.barrier, ...lease.lane.reads]);
          }
          activeLeases.delete(lease);
        }
        // A poisoned tombstone prevents future execution. Release the sequencing
        // hold so already-queued callers wake, observe the tombstone and refuse
        // instead of remaining parked behind an abort-ignoring host forever.
        releaseTarget?.();
        releaseParent?.();
        if (targetEntry) {
          targetEntry.users -= 1;
          if (targetEntry.users === 0 && !targetEntry.poisoned
              && targetLanes.get(target) === targetEntry) {
            targetLanes.delete(target);
          }
        }
      }
    },
  });
};
