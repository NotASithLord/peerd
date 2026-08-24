// @ts-check
// Browser-neutral authority-generation fence.

import {
  bindKernelIdentity,
  kernelIdentityMatches,
  parseKernelIdentity,
} from '../shared/kernel-identity.js';

export const KERNEL_GENERATION_SESSION_KEY = 'authority-kernel.generation.v1';

/** @typedef {import('../shared/kernel-identity.js').KernelIdentity} KernelGenerationIdentity */
/** @typedef {{ok:true,identity:Readonly<KernelGenerationIdentity>}|{ok:false,error:string}} KernelCurrent */

/**
 * Claim one browser-background generation and fence every state envelope to it.
 *
 * @param {Object} deps
 * @param {{
 *   sessionGet: (key:string) => Promise<unknown>,
 *   sessionSet: (key:string, value:unknown) => Promise<unknown>,
 * }} deps.session
 * @param {Readonly<KernelGenerationIdentity>} deps.identity
 */
export const makeKernelGenerationLifecycle = ({
  session,
  identity: candidate,
}) => {
  const identity = parseKernelIdentity(candidate);
  if (!identity) throw new TypeError('kernel generation identity is invalid');
  let retired = false;

  const claim = async () => {
    await session.sessionSet(KERNEL_GENERATION_SESSION_KEY, identity);
    const observed = await session.sessionGet(KERNEL_GENERATION_SESSION_KEY);
    if (!kernelIdentityMatches(identity, observed)) {
      retired = true;
      throw new Error('kernel-generation-claim-lost');
    }
  };
  const readyPromise = claim();

  const retireLocal = () => { retired = true; };
  /** @returns {Promise<KernelCurrent>} */
  const reconcile = async () => {
    await readyPromise;
    if (retired) return { ok: false, error: 'kernel-generation-retired' };
    const observed = await session.sessionGet(KERNEL_GENERATION_SESSION_KEY);
    if (!kernelIdentityMatches(identity, observed)) {
      retireLocal();
      return { ok: false, error: 'kernel-generation-retired' };
    }
    return { ok: true, identity };
  };
  /**
   * @template {Record<string, unknown>} T
   * @param {T} payload
   * @returns {Readonly<T & KernelGenerationIdentity>}
   */
  const bind = (payload) => {
    if (retired) throw new Error('kernel-generation-retired');
    return bindKernelIdentity(identity, payload);
  };
  /**
   * @template {Record<string, unknown>} T
   * @param {T} payload
   * @returns {Promise<Readonly<T & KernelGenerationIdentity>>}
   */
  const bindCurrent = async (payload) => {
    const current = await reconcile();
    if (!current.ok) throw new Error(current.error);
    return bind(payload);
  };

  return Object.freeze({
    identity,
    ready: () => readyPromise,
    reconcile,
    bind,
    bindCurrent,
  });
};
