// @ts-check
// Persistent acknowledgement loop for one exact live dweb host generation.

const RETRY_DELAYS_MS = Object.freeze([250, 1_000, 4_000, 15_000]);
const ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * @param {Object} deps
 * @param {(notice:any,options:{signal:AbortSignal})=>Promise<any>} deps.send
 * @param {(notice:any)=>boolean} deps.current
 * @param {readonly number[]} [deps.retryDelaysMs]
 * @param {number} [deps.attemptTimeoutMs]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 */
export const createDwebReseedNotifier = ({
  send,
  current,
  retryDelaysMs = RETRY_DELAYS_MS,
  attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  if (typeof send !== 'function' || typeof current !== 'function'
      || !Array.isArray(retryDelaysMs) || retryDelaysMs.length === 0
      || retryDelaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)
      || !Number.isFinite(attemptTimeoutMs) || attemptTimeoutMs <= 0) {
    throw new TypeError('dweb-reseed-notifier-config-invalid');
  }
  let generation = 0;
  /** @type {ReturnType<typeof setTimeoutFn>|null} */
  let timer = null;
  /** @type {(()=>void)|null} */
  let releaseWait = null;
  /** @type {Set<AbortController>} */
  const attempts = new Set();
  const cancel = () => {
    generation += 1;
    for (const attempt of attempts) attempt.abort('dweb-generation-retired');
    attempts.clear();
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
  /** @param {any} notice @param {number} owner */
  const runAttempt = async (notice, owner) => {
    const controller = new AbortController();
    attempts.add(controller);
    let timedOut = false;
    const deadline = setTimeoutFn(() => {
      timedOut = true;
      controller.abort('dweb-reseed-attempt-timeout');
    }, attemptTimeoutMs);
    const aborted = new Promise((resolve) => {
      controller.signal.addEventListener('abort', () => resolve({ aborted: true }), { once: true });
    });
    const sent = Promise.resolve().then(() => send(notice, { signal: controller.signal }))
      .then((result) => ({ result }), (cause) => ({
        result: {
          ok: false,
          error: /** @type {{message?:unknown}} */ (cause)?.message ?? String(cause),
        },
      }));
    try {
      const outcome = /** @type {any} */ (await Promise.race([sent, aborted]));
      if (outcome?.aborted) {
        if (owner !== generation || !current(notice)) {
          return { ok: false, cancelled: true, error: 'dweb-generation-retired' };
        }
        return {
          ok: false,
          retryable: true,
          error: timedOut ? 'dweb-reseed-attempt-timeout' : 'dweb-reseed-aborted',
        };
      }
      if (owner !== generation || !current(notice)) {
        return { ok: false, cancelled: true, error: 'dweb-generation-retired' };
      }
      return outcome.result;
    } finally {
      clearTimeoutFn(deadline);
      attempts.delete(controller);
    }
  };
  const notify = async (/** @type {any} */ notice) => {
    cancel();
    const owner = generation;
    /** @type {any} */
    let result = { ok: false, error: 'dweb-reseed-unacknowledged' };
    for (let attempt = 0; ; attempt += 1) {
      if (owner !== generation || !current(notice)) {
        return { ok: false, cancelled: true, error: 'dweb-generation-retired' };
      }
      result = await runAttempt(notice, owner);
      if (result?.ok === true || result?.cancelled === true) return result;
      const delay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)];
      await wait(delay, owner);
    }
  };
  return Object.freeze({ notify, cancel });
};
