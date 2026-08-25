// @ts-check

import { KERNEL_SESSION_SUPPORT_ROUTE_NAMES } from '../shared/kernel-support-protocol.js';
import { STARTUP_UNAVAILABLE_USER_FAILURE } from '../shared/bounded-module-load.js';
import { createKernelFeatureControl } from './kernel-feature-control.js';

const success = (/** @type {unknown} */ value) => Object.freeze({
  ok: true, outcomeKnown: true, value,
});
const failure = (/** @type {string} */ code, /** @type {boolean} */ outcomeKnown,
  /** @type {unknown} */ cause = undefined, /** @type {boolean} */ retryable = false) => Object.freeze({
  ok: false, code, outcomeKnown,
  error: /** @type {{message?:string}} */ (cause)?.message ?? code,
  retryable,
});

/**
 * @param {Object} deps
 * @param {(payload:unknown,options?:any)=>Promise<any>} deps.callFeature
 * @param {(route:string,message:Record<string,any>,sender:unknown)=>boolean} deps.admit
 * @param {(operation:string,payload:unknown,context:any)=>boolean} deps.effectAllowed
 * @param {Record<string,(payload:any,context:any)=>Promise<any>|any>} deps.effects
 */
export const createKernelSupportControl = ({
  callFeature, admit, effectAllowed, effects,
}) => {
  if (typeof callFeature !== 'function' || typeof admit !== 'function'
      || typeof effectAllowed !== 'function') {
    throw new TypeError('kernel-support-control-config-invalid');
  }
  const handleEffect = async (/** @type {string} */ operation,
    /** @type {unknown} */ offeredPayload, /** @type {any} */ context) => {
    const payload = offeredPayload && typeof offeredPayload === 'object'
      && !Array.isArray(offeredPayload)
      ? /** @type {Record<string,any>} */ (offeredPayload) : null;
    if (context?.signal?.aborted) return failure('support-call-aborted', true, undefined, true);
    if (!payload || typeof effects?.[operation] !== 'function'
        || !effectAllowed(operation, payload, context)) {
      return failure('support-effect-substitution', true, undefined, true);
    }
    try { return success(await effects[operation](payload, context)); }
    catch (cause) {
      const detail = /** @type {{code?:unknown,outcomeKnown?:unknown}} */ (cause);
      return failure(
        typeof detail.code === 'string' ? detail.code : 'support-effect-failed',
        detail.outcomeKnown === true,
        cause,
        /** @type {{retryable?:unknown}} */ (cause)?.retryable === true,
      );
    }
  };
  const feature = createKernelFeatureControl({
    call: (/** @type {string} */ _capability, /** @type {unknown} */ payload,
      /** @type {any} */ options) => callFeature(payload, options),
    handleEffect,
  });
  const routes = Object.freeze(Object.fromEntries(KERNEL_SESSION_SUPPORT_ROUTE_NAMES.map(
    (route) => [route, async (
      /** @type {Record<string,any>} */ message = {}, /** @type {unknown} */ sender = undefined,
    ) => {
      if (!admit(route, message, sender)) {
        return { ok: false, error: 'kernel-route-unauthorized', outcomeKnown: true };
      }
      const result = await feature.dispatch('support', route, message);
      if (result?.ok === true && Object.hasOwn(result, 'value')) return result.value;
      return result?.phase === 'startup' && typeof result.error !== 'string'
        ? { ...result, error: STARTUP_UNAVAILABLE_USER_FAILURE } : result;
    }],
  )));
  return Object.freeze({
    routes,
    authorize: feature.authorize,
    handleKernelCall: feature.handleKernelCall,
  });
};
