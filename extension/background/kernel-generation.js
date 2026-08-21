// @ts-check
// Browser-neutral authority-generation fence. The legacy pending-grant field
// stays in the durable schema so a successor can report and clear old builds.

import {
  bindKernelIdentity,
  createKernelIdentity,
  KERNEL_IDENTITY_SCHEMA,
  kernelIdentityFromEnvelope,
  kernelIdentityMatches,
  parseKernelIdentity,
} from '../shared/kernel-identity.js';

export const KERNEL_GENERATION_SCHEMA = KERNEL_IDENTITY_SCHEMA;
export const KERNEL_GENERATION_SESSION_KEY = 'authority-kernel.generation.v1';

/** @typedef {import('../shared/kernel-identity.js').KernelIdentity} KernelGenerationIdentity */
/** @typedef {{replaced:boolean,priorBuildMatched:boolean,invalidatedPendingGrantCount:number}} KernelReconciliation */
/** @typedef {{ok:true,identity:Readonly<KernelGenerationIdentity>}|{ok:false,error:string,invalidatedPendingGrantCount?:number}} KernelCurrent */

/** @param {unknown} value @param {number} [max] */
const safeText = (value, max = 256) => typeof value === 'string'
  && value.length >= 8 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/** @param {unknown} value */
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value @returns {Readonly<KernelGenerationIdentity>|null} */
export const parseKernelGenerationIdentity = (value) => parseKernelIdentity(value);

/** @param {unknown} value */
const parseStoredGeneration = (value) => {
  const identity = kernelIdentityFromEnvelope(value);
  if (!identity || !record(value)) return null;
  const stored = /** @type {Record<string, unknown>} */ (value);
  if (!Number.isFinite(stored.startedAt) || Number(stored.startedAt) < 0
      || !Number.isSafeInteger(stored.pendingGrantCount)
      || Number(stored.pendingGrantCount) < 0) return null;
  return Object.freeze({
    ...identity,
    startedAt: Number(stored.startedAt),
    pendingGrantCount: Number(stored.pendingGrantCount),
  });
};

/**
 * @param {ReturnType<typeof parseKernelGenerationIdentity>} expected
 * @param {unknown} value
 */
export const kernelGenerationMatches = (expected, value) =>
  kernelIdentityMatches(expected, value);

/**
 * Claim one browser-background generation and fence every state envelope to
 * it. A replacement reports old controller grants from the durable v1 schema,
 * then persists zero; live controller channels own their own receipt custody.
 *
 * @param {Object} deps
 * @param {{
 *   sessionGet: (key:string) => Promise<unknown>,
 *   sessionSet: (key:string, value:unknown) => Promise<unknown>,
 * }} deps.session
 * @param {Readonly<KernelGenerationIdentity>} [deps.identity]
 * @param {string} [deps.build] legacy construction seam; callers should inject identity
 * @param {() => string} [deps.newId]
 * @param {() => number} [deps.now]
 */
export const makeKernelGenerationLifecycle = ({
  session,
  build,
  identity: injectedIdentity,
  newId = () => crypto.randomUUID(),
  now = Date.now,
}) => {
  const identity = injectedIdentity
    ? parseKernelGenerationIdentity(injectedIdentity)
    : safeText(build) ? createKernelIdentity({ buildId: /** @type {string} */ (build), newId })
      : null;
  if (!identity) throw new TypeError('kernel generation identity is invalid');
  const startedAt = now();
  if (!Number.isFinite(startedAt) || startedAt < 0) {
    throw new TypeError('kernel generation start time is invalid');
  }

  let retired = false;
  /** @type {Readonly<KernelReconciliation>} */
  let reconciliation = Object.freeze({
    replaced: false, priorBuildMatched: false, invalidatedPendingGrantCount: 0,
  });
  const persisted = () => ({ ...identity, startedAt, pendingGrantCount: 0 });

  const claim = async () => {
    const prior = parseStoredGeneration(await session.sessionGet(KERNEL_GENERATION_SESSION_KEY));
    reconciliation = Object.freeze({
      replaced: !!prior && !kernelGenerationMatches(identity, prior),
      priorBuildMatched: !!prior && prior.buildId === identity.buildId,
      invalidatedPendingGrantCount: prior && !kernelGenerationMatches(identity, prior)
        ? prior.pendingGrantCount : 0,
    });
    await session.sessionSet(KERNEL_GENERATION_SESSION_KEY, persisted());
    const observed = await session.sessionGet(KERNEL_GENERATION_SESSION_KEY);
    if (!kernelGenerationMatches(identity, observed)) {
      retired = true;
      throw new Error('kernel-generation-claim-lost');
    }
    return Object.freeze({ ...reconciliation });
  };
  const readyPromise = claim();

  const retireLocal = () => { retired = true; };
  /** @returns {Promise<KernelCurrent>} */
  const reconcile = async () => {
    await readyPromise;
    if (retired) return { ok: false, error: 'kernel-generation-retired' };
    const observed = await session.sessionGet(KERNEL_GENERATION_SESSION_KEY);
    if (!kernelGenerationMatches(identity, observed)) {
      retireLocal();
      return {
        ok: false,
        error: 'kernel-generation-retired',
        invalidatedPendingGrantCount: 0,
      };
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
    reconciliation: () => reconciliation,
    reconcile,
    bind,
    bindCurrent,
    retired: () => retired,
  });
};
