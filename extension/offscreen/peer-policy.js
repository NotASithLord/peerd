// @ts-check
import { peerPolicySnapshot } from '/shared/peer-policy.js';

// why: an older read can finish after a newer unsolicited policy update. Never
// let that completion reopen admission, even across a kernel restart.
export const createPeerPolicyView = () => {
  let revision = -1;
  let available = false;
  let blocked = new Set();
  return {
    /** @param {any} value */
    apply(value) {
      let next;
      try { next = peerPolicySnapshot(value); }
      catch (error) { available = false; throw error; }
      if (next.revision < revision) return false;
      if (next.revision === revision && (next.blocked.length !== blocked.size
          || next.blocked.some(did => !blocked.has(did)))) { available = false; throw new Error('peer-policy-revision-conflict'); }
      blocked = new Set(next.blocked); revision = next.revision; available = true;
      return true;
    },
    invalidate() { available = false; },
    /** @param {string} did */
    isBlocked: (did) => !available || blocked.has(did),
    revision: () => revision,
  };
};
