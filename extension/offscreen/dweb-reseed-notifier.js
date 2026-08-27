// @ts-check
// Bounded acknowledgement loop for one exact dweb host generation.

const RETRY_DELAYS_MS = Object.freeze([250, 1_000, 4_000]);

/**
 * @param {Object} deps
 * @param {(notice:any)=>Promise<any>} deps.send
 * @param {(notice:any)=>boolean} deps.current
 * @param {readonly number[]} [deps.retryDelaysMs]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 */
export const createDwebReseedNotifier = ({
  send,
  current,
  retryDelaysMs = RETRY_DELAYS_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  if (typeof send !== 'function' || typeof current !== 'function'
      || !Array.isArray(retryDelaysMs)
      || retryDelaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)) {
    throw new TypeError('dweb-reseed-notifier-config-invalid');
  }
  let generation = 0;
  /** @type {ReturnType<typeof setTimeoutFn>|null} */
  let timer = null;
  /** @type {(()=>void)|null} */
  let releaseWait = null;
  const cancel = () => {
    generation += 1;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
    const release = releaseWait;
    releaseWait = null;
    release?.();
  };
  const wait = (/** @type {number} */ delay, /** @type {number} */ owner) =>
    new Promise((resolve) => {
      if (owner !== generation) { resolve(undefined); return; }
      releaseWait = () => { releaseWait = null; resolve(undefined); };
      timer = setTimeoutFn(() => {
        timer = null;
        releaseWait?.();
      }, delay);
    });
  const notify = async (/** @type {any} */ notice) => {
    cancel();
    const owner = generation;
    /** @type {any} */
    let result = { ok: false, error: 'dweb-reseed-unacknowledged' };
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      if (owner !== generation || !current(notice)) {
        return { ok: false, cancelled: true, error: 'dweb-generation-retired' };
      }
      try { result = await send(notice); }
      catch (cause) {
        result = {
          ok: false,
          error: /** @type {{message?:unknown}} */ (cause)?.message ?? String(cause),
        };
      }
      if (result?.ok === true || attempt === retryDelaysMs.length) return result;
      await wait(retryDelaysMs[attempt], owner);
    }
    return result;
  };
  return Object.freeze({ notify, cancel });
};
