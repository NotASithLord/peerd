// @ts-check
// Serialize dweb publication work and invalidate requests that crossed master OFF.

import { withDeadline } from '../shared/cold-util.js';

/**
 * @param {{
 *   retireReseedHost?:(reason:string)=>Promise<unknown>|unknown,
 *   ensureReseedHostRetired?:()=>Promise<unknown>|unknown,
 *   armReseedHost?:(hostEpoch:string)=>Promise<unknown>|unknown,
 *   disarmReseedHost?:(hostEpoch:string)=>Promise<unknown>|unknown,
 *   retirementTimeoutMs?:number,
 *   setTimeoutFn?:typeof setTimeout,
 *   clearTimeoutFn?:typeof clearTimeout,
 * }} [options]
 */
export const createDwebPublicationFence = ({
  retireReseedHost = undefined,
  ensureReseedHostRetired = async () => {},
  armReseedHost = undefined,
  disarmReseedHost = undefined,
  retirementTimeoutMs = 30_000,
  setTimeoutFn: retirementSetTimeout = setTimeout,
  clearTimeoutFn: retirementClearTimeout = clearTimeout,
} = {}) => {
  if ((retireReseedHost !== undefined && typeof retireReseedHost !== 'function')
      || typeof ensureReseedHostRetired !== 'function'
      || ((armReseedHost === undefined) !== (disarmReseedHost === undefined))
      || (armReseedHost !== undefined && typeof armReseedHost !== 'function')
      || (disarmReseedHost !== undefined && typeof disarmReseedHost !== 'function')
      || !Number.isFinite(retirementTimeoutMs) || retirementTimeoutMs <= 0) {
    throw new TypeError('dweb-publication-fence-config-invalid');
  }
  let generation = 0;
  let tail = Promise.resolve();
  let hostRetirementRequired = false;

  const retireUncertainHost = async () => {
    if (!hostRetirementRequired) return;
    if (!retireReseedHost) {
      throw Object.assign(new Error('dweb-reseed-host-retirement-unavailable'), {
        code: 'dweb-reseed-host-retirement-unavailable', outcomeKnown: false,
      });
    }
    await withDeadline(
      () => retireReseedHost('dweb-reseed-outcome-unknown'),
      retirementTimeoutMs,
      () => Object.assign(new Error('dweb-reseed-host-retirement-timeout'), {
        code: 'dweb-reseed-host-retirement-timeout', outcomeKnown: false,
      }),
      retirementSetTimeout,
      retirementClearTimeout,
    );
    hostRetirementRequired = false;
  };

  const invalidate = () => { generation += 1; return generation; };

  /**
   * @template T
   * @param {(isCurrent: () => boolean) => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const run = (operation) => {
    const requestedGeneration = generation;
    const execute = async () => {
      // why: an uncertain reseed may still be executing in the offscreen realm.
      // No later mutation may enter until that physical realm is gone.
      await retireUncertainHost();
      await ensureReseedHostRetired();
      return operation(() => requestedGeneration === generation);
    };
    const result = tail.then(execute, execute);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  /**
   * Reseeding is recovery work, so a retired recovery must not own the
   * publication lane forever. The operation receives a predicate that becomes
   * false before this bounded lane is released; it must re-check that predicate
   * after every await and before dispatching an effect.
   *
   * @template T
   * @param {(isCurrent: () => boolean) => Promise<T>} operation
   * @param {{timeoutMs:number,hostEpoch?:string,setTimeoutFn?:typeof setTimeout,clearTimeoutFn?:typeof clearTimeout}} options
   * @returns {Promise<T>}
   */
  const runReseed = (operation, {
    timeoutMs, hostEpoch, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  }) => {
    if (typeof operation !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('dweb-reseed-publication-config-invalid');
    }
    if (armReseedHost && (typeof hostEpoch !== 'string' || hostEpoch.length < 8)) {
      throw new TypeError('dweb-reseed-host-epoch-invalid');
    }
    const requestedGeneration = generation;
    let admitted = false;
    const execute = async () => {
      await retireUncertainHost();
      await ensureReseedHostRetired();
      if (armReseedHost) await armReseedHost(/** @type {string} */ (hostEpoch));
      admitted = true;
      /** @param {unknown} [primaryCause] */
      const settleKnown = async (primaryCause = undefined) => {
        if (!disarmReseedHost) return;
        try { await disarmReseedHost(/** @type {string} */ (hostEpoch)); }
        catch (disarmCause) {
          hostRetirementRequired = true;
          try { await retireUncertainHost(); }
          catch (retirementCause) {
            throw Object.assign(new AggregateError(
              primaryCause === undefined
                ? [disarmCause, retirementCause]
                : [primaryCause, disarmCause, retirementCause],
              'dweb reseed host retirement failed',
            ), { code: 'dweb-reseed-host-retirement-failed', outcomeKnown: false });
          }
        }
      };
      let result;
      try {
        result = await withDeadline(
          () => operation(() => admitted && requestedGeneration === generation),
          timeoutMs,
          () => Object.assign(new Error('dweb-reseed-publication-timeout'), {
            code: 'dweb-reseed-publication-timeout', outcomeKnown: false,
          }),
          setTimeoutFn,
          clearTimeoutFn,
        );
      } catch (cause) {
        if (/** @type {any} */ (cause)?.outcomeKnown === false) {
          // Retire the current predicate synchronously, then destroy the realm
          // before the shared tail releases. A failed retirement poisons the
          // lane; the next caller retries it and cannot touch the old host.
          admitted = false;
          hostRetirementRequired = true;
          try { await retireUncertainHost(); }
          catch (retirementCause) {
            throw Object.assign(new AggregateError(
              [cause, retirementCause], 'dweb reseed host retirement failed',
            ), { code: 'dweb-reseed-host-retirement-failed', outcomeKnown: false });
          }
        } else await settleKnown(cause);
        throw cause;
      }
      await settleKnown();
      return /** @type {T} */ (result);
    };
    const guarded = async () => {
      try { return await execute(); }
      finally {
        admitted = false;
      }
    };
    const bounded = tail.then(guarded, guarded);
    // why: unlike an ordinary user mutation, recovery may release its lane at
    // the deadline. Its current() predicate has already been retired, so a
    // delayed read can finish but cannot dispatch a later publication effect.
    tail = bounded.then(() => undefined, () => undefined);
    return bounded;
  };

  return Object.freeze({ run, runReseed, invalidate, generation: () => generation });
};
