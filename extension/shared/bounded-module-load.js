// @ts-check

export const STARTUP_UNAVAILABLE_USER_FAILURE = 'Temporarily unavailable. Try again.';
export const OUTCOME_UNKNOWN_USER_FAILURE = 'Peerd could not confirm whether the requested '
  + 'change finished. Refresh to reconcile before trying again.';

/** @param {string} code */
const moduleLoadError = (code) => Object.assign(
  new Error(code),
  { code, outcomeKnown: true, retryable: true, phase: 'startup' },
);

/**
 * @template T
 * @param {()=>Promise<T>} loader
 * @param {{timeoutMs?:number,loadCode?:string,timeoutCode?:string}} [options]
 */
export const makeBoundedModuleLoader = (loader, {
  timeoutMs = 10_000,
  loadCode = 'module-load-failed',
  timeoutCode = 'module-load-timeout',
} = {}) => {
  /** @type {Promise<T>|null} */ let pending = null;
  const load = () => {
    /** @type {ReturnType<typeof setTimeout>} */ let timer;
    pending ||= Promise.resolve().then(loader).catch(() => {
      pending = null;
      throw moduleLoadError(loadCode);
    });
    return Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(moduleLoadError(timeoutCode)), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  load.reset = () => { pending = null; };
  return load;
};
