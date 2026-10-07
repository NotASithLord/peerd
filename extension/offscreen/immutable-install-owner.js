// @ts-check
// why: Home tabs are replaceable views, not owners of possibly live installs.
// This realm survives their closure and SW adoption. Unknown effects cannot be
// evicted to make room; only a positive catalog receipt or physical retirement
// can release that uncertainty. Successful records are never cached after return.
export const createImmutableInstallOwner = () => {
  /** @type {Map<string,Promise<any>>} */ const attempts = new Map();
  /** @param {string} address @param {any} existing @param {()=>Promise<any>} operation */
  const run = (address, existing, operation) => {
    if (existing) { attempts.delete(address); return Promise.resolve({ ok: true, app: existing }); }
    const pending = attempts.get(address);
    if (pending) return pending;
    if (attempts.size >= 64) return Promise.reject(new Error('manual-install-reconciliation-required'));
    const attempt = Promise.resolve().then(operation).then(result => {
      if (attempts.get(address) === attempt) attempts.delete(address);
      return result;
    }, error => {
      if (error?.outcomeKnown !== false && error?.performed !== true
          && !['effect-completed', 'host-lost', 'transport-lost'].includes(error?.outcomeKind)) {
        if (attempts.get(address) === attempt) attempts.delete(address);
      }
      throw error;
    });
    attempts.set(address, attempt);
    return attempt;
  };
  return { run };
};
