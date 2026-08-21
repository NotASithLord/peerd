// @ts-check
// Nonsecret first-paint posture. A fresh install can render Create Vault
// without starting the sealed authority realm; initialized profiles still
// reconcile against the authoritative encrypted blob and session mirror.

import {
  parseVaultPostureIndex,
  VAULT_POSTURE_INDEX_KEY,
  VAULT_POSTURE_SCHEMA,
} from '../shared/vault-posture-contract.js';

export { parseVaultPostureIndex, VAULT_POSTURE_INDEX_KEY };

/**
 * @param {Object} deps
 * @param {{get:(key:string)=>Promise<any>,set:(key:string,value:any)=>Promise<void>}} deps.kv
 * @param {()=>number} [deps.now]
 * @param {(ms:number)=>Promise<void>} [deps.wait]
 */
export const createVaultPostureIndex = ({
  kv,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) => {
  if (!kv || typeof kv.get !== 'function' || typeof kv.set !== 'function') {
    throw new TypeError('vault-posture-index-config-invalid');
  }
  /** @type {ReturnType<typeof parseVaultPostureIndex>} */
  let current = null;
  let tail = Promise.resolve();
  const serialized = (/** @type {()=>Promise<any>} */ operation) => {
    const run = tail.then(operation, operation);
    tail = run.then(() => {}, () => {});
    return run;
  };
  const read = async () => {
    current = parseVaultPostureIndex(await kv.get(VAULT_POSTURE_INDEX_KEY));
    return current;
  };
  const write = (/** @type {{initialized:boolean,prfEnrolled:boolean,hasRecovery:boolean}} */ status) =>
    serialized(async () => {
      const next = parseVaultPostureIndex({
        schema: VAULT_POSTURE_SCHEMA,
        initialized: status.initialized,
        prfEnrolled: status.prfEnrolled,
        hasRecovery: status.hasRecovery,
        updatedAt: now(),
      });
      if (!next) throw new TypeError('vault-posture-index-status-invalid');
      await kv.set(VAULT_POSTURE_INDEX_KEY, next);
      current = next;
      return next;
    });
  const markFreshInstall = () => serialized(async () => {
    const stored = parseVaultPostureIndex(await kv.get(VAULT_POSTURE_INDEX_KEY));
    if (stored) { current = stored; return stored; }
    const next = Object.freeze({
      schema: VAULT_POSTURE_SCHEMA, initialized: false, prfEnrolled: false,
      hasRecovery: false, updatedAt: now(),
    });
    await kv.set(VAULT_POSTURE_INDEX_KEY, next);
    current = next;
    return next;
  });
  const loadForBoot = async () => {
    const first = await read();
    if (first) return first;
    // runtime.onInstalled is dispatched after module evaluation. Give that
    // exact fresh-install owner a short bounded window to publish the marker;
    // an existing/update profile with no marker falls through to authority
    // reconciliation rather than ever claiming "uninitialized".
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await wait(20);
      const next = await read();
      if (next) return next;
    }
    return null;
  };
  return Object.freeze({
    read,
    write,
    markFreshInstall,
    loadForBoot,
    snapshot: () => current,
  });
};
