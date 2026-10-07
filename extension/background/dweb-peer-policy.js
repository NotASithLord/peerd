// @ts-check
import { withDeadline } from '/shared/cold-util.js';
import { MAX_USER_BANS, policyDid, peerPolicySnapshot } from '/shared/peer-policy.js';

export const USER_PEER_POLICY_KEY = 'dweb.userPeerPolicy';
/** @type {WeakMap<object,ReturnType<typeof createUserPeerPolicy>>} */
const owners = new WeakMap();
/** @param {{get:(key:string)=>Promise<any>,set:(key:string,value:any)=>Promise<any>}} kv */
export const userPeerPolicy = (kv) => {
  let owner = owners.get(kv);
  if (!owner) { owner = createUserPeerPolicy(kv); owners.set(kv, owner); }
  return owner;
};
/** @param {{get:(key:string)=>Promise<any>,set:(key:string,value:any)=>Promise<any>}} kv */
export const createUserPeerPolicy = (kv) => {
  let tail = Promise.resolve();
  let queued = 0;
  // why: storage admission must remain bounded even if its backing transaction
  // stalls. Saturation is local overload, never a reason to evict an existing ban.
  /** @template T @param {()=>Promise<T>} action */
  const ordered = (action) => {
    if (queued >= 32) return Promise.reject(new Error('peer-policy-busy'));
    queued++;
    const result = tail.then(action);
    const settled = () => { queued--; };
    tail = result.then(settled, settled);
    return result;
  };
  const read = async () => {
    const value = await kv.get(USER_PEER_POLICY_KEY);
    return peerPolicySnapshot(value ?? { v: 1, revision: 0, blocked: [] });
  };
  return {
    snapshot: () => ordered(read),
    /** @template T @param {string} did @param {()=>Promise<T>} operation */
    withPublisher: (did, operation) => ordered(async () => {
      policyDid(did);
      if ((await read()).blocked.includes(did)) throw new Error('publisher-user-blocked');
      return operation();
    }),
    /** @param {string} did @param {boolean} blocked @param {(policy:any)=>Promise<any>} [enforce] @param {()=>boolean} [current] */
    set: (did, blocked, enforce = async policy => policy, current = () => true) => ordered(async () => {
      if (!current()) throw new Error('peer-policy-authority-retired');
      policyDid(did);
      if (typeof blocked !== 'boolean') throw new Error('invalid-peer-policy-mutation');
      const old = await read();
      if (!current()) throw new Error('peer-policy-authority-retired');
      const entries = new Set(old.blocked);
      if (entries.has(did) === blocked) return enforce(old);
      if (blocked && entries.size >= MAX_USER_BANS) throw new Error('peer-policy-full');
      if (old.revision === Number.MAX_SAFE_INTEGER) throw new Error('peer-policy-revision-exhausted');
      if (blocked) entries.add(did); else entries.delete(did);
      const next = { v: /** @type {const} */ (1), revision: old.revision + 1, blocked: [...entries].sort() };
      await kv.set(USER_PEER_POLICY_KEY, next);
      return enforce(next);
    }),
  };
};

/** @param {Record<string,any>} deps @param {{did:string,block?:boolean}} args */
export const setUserPeerBlocked = async (deps, { did, block = true }) => {
  if (deps.vault.isLocked()) return { ok: false, error: 'vault-locked' };
  const current = () => !deps.vault.isLocked() && deps.current?.() !== false;
  try {
    return await userPeerPolicy(deps.kv).set(did, block, async policy => {
      const receipt = { durable: true, revision: policy.revision };
      try {
        if (!current()) throw new Error('peer-policy-authority-retired');
        if (block) await deps.revokePeer?.(did);
        // why: an absent physical host needs no message and must not be created.
        // A subsequent startup hydrates the committed policy before joining.
        const contexts = await deps.browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        if (Array.isArray(contexts) && contexts.length === 0) return { ...receipt, ok: true, inactive: true };
        const result = await withDeadline(() => deps.browser.runtime.sendMessage({ type: 'dweb/base-host/peer-policy', policy }),
          5_000, () => new Error('peer-policy-enforcement-timeout'));
        if (result?.ok && result.revision === policy.revision) return { ...receipt, ok: true };
      } catch { /* durable storage and live enforcement have separate receipts */ }
      return { ...receipt, ok: false, error: 'peer-policy-enforcement-unconfirmed', outcomeKnown: false };
    }, current);
  } catch (error) { return { ok: false, error: String(error), outcomeKnown: false }; }
};
