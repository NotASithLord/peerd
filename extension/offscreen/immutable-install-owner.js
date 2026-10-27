// @ts-check
// why: Home tabs are replaceable views, not owners of possibly live installs.
// This realm survives their closure and SW adoption. Unknown effects cannot be
// evicted to make room; only a positive catalog receipt or physical retirement
// can release that uncertainty. Successful records are never cached after return.
export const createImmutableInstallOwner = () => {
  /** @typedef {{signal:AbortSignal, beginCommit:()=>void, progress:(value:any)=>void}} Control */
  /** @typedef {{id:string, phase:'retrieving'|'committing'|'cancelling'|'unknown', controller:AbortController, promise:Promise<any>, progress:{phase:string,done?:number,total?:number}}} Attempt */
  /** @type {Map<string,Attempt>} */ const attempts = new Map();
  /** @param {string} address @param {any} existing @param {(control:Control)=>Promise<any>} operation */
  const run = (address, existing, operation) => {
    if (existing) { attempts.delete(address); return Promise.resolve({ ok: true, app: existing }); }
    const pending = attempts.get(address);
    if (pending) return pending.promise;
    if (attempts.size >= 64) return Promise.reject(new Error('manual-install-reconciliation-required'));
    const controller = new AbortController();
    /** @type {Attempt} */
    const attempt = { id: crypto.randomUUID(), phase: 'retrieving', controller, promise: Promise.resolve(), progress: { phase: 'locating' } };
    const control = {
      signal: controller.signal,
      progress: (/** @type {any} */ value) => {
        if (attempt.phase !== 'retrieving' || !['locating', 'connecting', 'manifest', 'chunk', 'verifying'].includes(value?.phase)) return;
        const counts = value.phase === 'chunk' && Number.isSafeInteger(value.done) && Number.isSafeInteger(value.total)
          && value.done >= 0 && value.total > 0 && value.done <= value.total ? { done: value.done, total: value.total } : {};
        attempt.progress = { phase: value.phase, ...counts };
      },
      beginCommit: () => {
        controller.signal.throwIfAborted();
        // why: no await may separate this fence from beginning an effect.
        // A cancellation after this transition cannot promise no installation.
        attempt.phase = 'committing';
      },
    };
    attempt.promise = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(control);
    }).then(result => {
      if (attempts.get(address) === attempt) attempts.delete(address);
      return result;
    }, error => {
      if (error?.outcomeKnown !== false && error?.performed !== true
          && !['effect-completed', 'host-lost', 'transport-lost'].includes(error?.outcomeKind)) {
        if (attempts.get(address) === attempt) attempts.delete(address);
      } else attempt.phase = 'unknown';
      throw error;
    });
    attempts.set(address, attempt);
    return attempt.promise;
  };
  /** @param {string} address */
  const status = (address) => {
    const attempt = attempts.get(address);
    return attempt ? { id: attempt.id, phase: attempt.phase, cancellable: attempt.phase === 'retrieving', progress: { ...attempt.progress } } : null;
  };
  /** @param {string} address @param {string} id */
  const cancel = (address, id) => {
    const attempt = attempts.get(address);
    // why: a delayed view request must never cancel a later retry at this address.
    if (!attempt || attempt.id !== id) return { ok: false, error: 'install-attempt-not-found' };
    if (attempt.phase !== 'retrieving') return { ok: false, error: 'install-not-cancellable', phase: attempt.phase };
    attempt.phase = 'cancelling';
    controllerAbort(attempt.controller);
    return { ok: true, id, phase: attempt.phase };
  };
  return { run, status, cancel };
};

class InstallCancelledError extends Error {
  constructor() {
    super('Install cancelled'); this.name = 'AbortError'; this.code = 'install-cancelled';
    this.outcomeKnown = true; this.performed = false; this.outcomeKind = 'pre-effect-failure';
  }
}
/** @param {AbortController} controller */
const controllerAbort = (controller) => controller.abort(new InstallCancelledError());
