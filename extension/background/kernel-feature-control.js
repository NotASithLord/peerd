// @ts-check

import {
  KERNEL_FEATURE_DISPATCH_CAPABILITY,
  KERNEL_FEATURE_EVENT_CAPABILITY,
  kernelFeatureAuthorityFor,
  kernelFeatureAuthorityAllowed,
  kernelFeatureDispatchIdFromAuthority,
  kernelFeatureEffectAllowed,
} from '../shared/kernel-feature-policy.js';

/**
 * @param {{call:(capability:string,payload:unknown,options?:any)=>Promise<any>,
 * handleEffect?:(operation:string,payload:unknown,context:any)=>Promise<any>|any,
 * newId?:()=>string}} deps
 */
export const createKernelFeatureControl = ({
  call, handleEffect, newId = () => crypto.randomUUID(),
}) => {
  if (typeof call !== 'function') throw new TypeError('kernel-feature-control-config-invalid');
  const grants = new WeakMap();
  /** @type {Map<string,Record<string,unknown>>} */ const active = new Map();
  const issue = (/** @type {string} */ capability, /** @type {Record<string,unknown>} */ payload,
    /** @type {any} */ options = undefined) => {
    const authority = kernelFeatureAuthorityFor(capability, payload);
    if (!authority) throw new TypeError('kernel-feature-call-invalid');
    const dispatchId = capability === KERNEL_FEATURE_DISPATCH_CAPABILITY
      ? /** @type {string} */ (payload.dispatchId) : null;
    if (dispatchId && active.has(dispatchId)) throw new TypeError('kernel-feature-dispatch-reused');
    if (dispatchId) active.set(dispatchId, payload);
    grants.set(payload, authority);
    let result;
    try { result = call(capability, payload, options); }
    catch (cause) {
      if (dispatchId && active.get(dispatchId) === payload) active.delete(dispatchId);
      grants.delete(payload);
      throw cause;
    }
    return Promise.resolve(result).finally(() => {
      if (dispatchId && active.get(dispatchId) === payload) active.delete(dispatchId);
      grants.delete(payload);
    });
  };
  return Object.freeze({
    dispatch: (/** @type {string} */ cluster, /** @type {string} */ route,
      /** @type {Record<string,unknown>} */ message = {}, /** @type {any} */ options = undefined) => issue(
      KERNEL_FEATURE_DISPATCH_CAPABILITY,
      Object.freeze({
        cluster, route, dispatchId: newId(), message: Object.freeze({ ...message }),
      }),
      options,
    ),
    event: (/** @type {string} */ event,
      /** @type {Record<string,unknown>} */ payload = {}) => issue(
      KERNEL_FEATURE_EVENT_CAPABILITY,
      Object.freeze({ event, payload: Object.freeze({ ...payload }) }),
    ),
    authorize: (/** @type {string|unknown} */ capabilityOrPayload,
      /** @type {unknown} */ offeredPayload = undefined) => {
      const payload = offeredPayload === undefined ? capabilityOrPayload : offeredPayload;
      if (!payload || typeof payload !== 'object') return null;
      const key = /** @type {object} */ (payload);
      const authority = grants.get(key) ?? null;
      grants.delete(key);
      return authority;
    },
    handleKernelCall: (/** @type {string} */ operation, /** @type {unknown} */ payload,
      /** @type {{capability?:string,authority?:unknown,signal?:AbortSignal,deadlineAt?:number}} */ context) => {
      if (context?.capability !== KERNEL_FEATURE_DISPATCH_CAPABILITY
          || typeof handleEffect !== 'function') {
        return { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };
      }
      if (!kernelFeatureEffectAllowed(context.authority, operation, payload)) {
        return { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };
      }
      const dispatchId = kernelFeatureDispatchIdFromAuthority(context.authority);
      const request = dispatchId ? active.get(dispatchId) : null;
      if (!dispatchId || !request
          || !kernelFeatureAuthorityAllowed(
            KERNEL_FEATURE_DISPATCH_CAPABILITY, request, context.authority,
          )
          || !kernelFeatureEffectAllowed(context.authority, operation, payload, request)) {
        return { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };
      }
      return handleEffect(operation, payload, Object.freeze({
        ...context, dispatchId, request, message: request.message,
      }));
    },
  });
};
