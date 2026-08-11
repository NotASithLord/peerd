// @ts-check
// Lease-backed holds for trusted operations that run outside the Pod tab. A
// browser MV3 service worker can disappear without executing finally blocks;
// the lease makes that lost release self-healing while renewals keep a live
// operation exclusive.

const TOKEN = /^lock-[a-z0-9-]{1,80}$/i;
export const DEFAULT_EXTERNAL_WORKSPACE_LEASE_MS = 30_000;

/**
 * @param {Object} deps
 * @param {()=>{wait:Promise<unknown>,release:()=>void}} deps.appendHold
 * @param {number} [deps.leaseMs]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 */
export const createExternalWorkspaceLockManager = ({
  appendHold,
  leaseMs = DEFAULT_EXTERNAL_WORKSPACE_LEASE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  /** @type {Map<string,{release:()=>void,cancelled:boolean,owned:boolean,timer?:ReturnType<typeof setTimeout>}>} */
  const locks = new Map();

  /** @param {string} token @param {ReturnType<typeof locks.get>} record */
  const arm = (token, record) => {
    if (!record) return;
    clearTimeoutFn(record.timer);
    record.timer = setTimeoutFn(() => {
      if (locks.get(token) !== record) return;
      locks.delete(token);
      record.cancelled = true;
      record.release();
    }, leaseMs);
  };

  /** @param {string} token */
  const acquire = async (token) => {
    if (!TOKEN.test(token) || locks.has(token)) {
      throw new Error('invalid or duplicate workspace lock token');
    }
    /** @type {{release:()=>void,cancelled:boolean,owned:boolean,timer?:ReturnType<typeof setTimeout>}} */
    const record = { release: () => {}, cancelled: false, owned: false };
    locks.set(token, record);
    let hold;
    try {
      hold = appendHold();
      record.release = hold.release;
      arm(token, record);
    } catch (error) {
      locks.delete(token);
      clearTimeoutFn(record.timer);
      throw error;
    }
    await hold.wait;
    if (record.cancelled || locks.get(token) !== record) {
      record.release();
      throw new Error('workspace lock released before acquisition');
    }
    record.owned = true;
    return { leaseMs };
  };

  /** @param {string} token */
  const renew = (token) => {
    const record = locks.get(token);
    if (!record || record.cancelled) return false;
    arm(token, record);
    return true;
  };

  /** @param {string} token */
  const release = (token) => {
    const record = locks.get(token);
    if (!record) return false;
    locks.delete(token);
    clearTimeoutFn(record.timer);
    record.cancelled = true;
    record.release();
    return true;
  };

  return { acquire, renew, release };
};
