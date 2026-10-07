// @ts-check
import { decodeDidKey, encodeDidKey } from './address/did.js';

export const MAX_USER_BANS = 1024;
/** @param {unknown} did @returns {string} */
export const policyDid = (did) => {
  if (typeof did !== 'string' || encodeDidKey(decodeDidKey(did)) !== did) throw new Error('invalid-peer-did');
  return did;
};
/** @param {any} value @returns {{v:1,revision:number,blocked:string[]}} */
export const peerPolicySnapshot = (value) => {
  if (!value || value.v !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Array.isArray(value.blocked) || value.blocked.length > MAX_USER_BANS) throw new Error('invalid-peer-policy');
  const blocked = value.blocked.map(policyDid);
  if (new Set(blocked).size !== blocked.length) throw new Error('invalid-peer-policy');
  return { v: 1, revision: value.revision, blocked };
};
