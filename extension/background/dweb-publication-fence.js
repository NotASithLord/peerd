// @ts-check
// Serialize dweb publication work and invalidate requests that crossed master OFF.

import { withDeadline } from '../shared/cold-util.js';

export const createDwebPublicationFence = () => {
  let generation = 0;
  let tail = Promise.resolve();

  const invalidate = () => { generation += 1; return generation; };

  /**
   * @template T
   * @param {(isCurrent: () => boolean) => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const run = (operation) => {
    const requestedGeneration = generation;
    const execute = () => operation(() => requestedGeneration === generation);
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
   * @param {{timeoutMs:number,setTimeoutFn?:typeof setTimeout,clearTimeoutFn?:typeof clearTimeout}} options
   * @returns {Promise<T>}
   */
  const runReseed = (operation, {
    timeoutMs, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  }) => {
    if (typeof operation !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('dweb-reseed-publication-config-invalid');
    }
    const requestedGeneration = generation;
    let admitted = false;
    const execute = () => {
      admitted = true;
      return withDeadline(
        () => operation(() => admitted && requestedGeneration === generation),
        timeoutMs,
        () => new Error('dweb-reseed-publication-timeout'),
        setTimeoutFn,
        clearTimeoutFn,
      ).finally(() => { admitted = false; });
    };
    const bounded = tail.then(execute, execute);
    // why: unlike an ordinary user mutation, recovery may release its lane at
    // the deadline. Its current() predicate has already been retired, so a
    // delayed read can finish but cannot dispatch a later publication effect.
    tail = bounded.then(() => undefined, () => undefined);
    return bounded;
  };

  return Object.freeze({ run, runReseed, invalidate, generation: () => generation });
};
