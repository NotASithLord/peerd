// @ts-check
// Retryable transaction state for public App-share rollback.

export const createShareRollbackStore = ({ terminalLimit = 128 } = {}) => {
  /** @type {Map<string, { state: any, rollbackPromise: Promise<any> | null }>} */
  const pending = new Map();
  /** @type {Map<string, { kind: 'committed' | 'rolled-back', result?: any }>} */
  const terminal = new Map();

  /** @param {string} id @param {{ kind: 'committed' | 'rolled-back', result?: any }} value */
  const remember = (id, value) => {
    terminal.set(id, value);
    while (terminal.size > terminalLimit) terminal.delete(/** @type {string} */ (terminal.keys().next().value));
  };

  const register = (/** @type {string} */ id, /** @type {any} */ state) => {
    if (pending.has(id) || terminal.has(id)) throw new Error('share-transaction-already-exists');
    pending.set(id, { state, rollbackPromise: null });
  };

  const commit = (/** @type {string} */ id) => {
    const done = terminal.get(id);
    if (done?.kind === 'committed') return { ok: true, committed: true };
    if (done?.kind === 'rolled-back') return { ok: false, error: 'share-already-rolled-back' };
    const entry = pending.get(id);
    if (!entry) return { ok: false, error: 'share-transaction-not-found' };
    if (entry.rollbackPromise) return { ok: false, error: 'share-rollback-in-progress' };
    pending.delete(id);
    remember(id, { kind: 'committed' });
    return { ok: true, committed: true };
  };

  /** @param {string} id @param {(state: any) => Promise<any>} operation */
  const rollback = async (id, operation) => {
    const done = terminal.get(id);
    if (done?.kind === 'rolled-back') return { ok: true, ...done.result };
    if (done?.kind === 'committed') return { ok: false, error: 'share-already-committed' };
    const entry = pending.get(id);
    if (!entry) return { ok: false, error: 'share-transaction-not-found' };
    if (entry.rollbackPromise) return entry.rollbackPromise;
    const promise = operation(entry.state).then((result) => {
      pending.delete(id);
      remember(id, { kind: 'rolled-back', result });
      return { ok: true, ...result };
    }).catch((error) => {
      entry.rollbackPromise = null;
      throw error;
    });
    entry.rollbackPromise = promise;
    return promise;
  };

  return Object.freeze({
    register,
    commit,
    rollback,
    clear: () => { pending.clear(); terminal.clear(); },
    hasPending: (/** @type {string} */ id) => pending.has(id),
  });
};
