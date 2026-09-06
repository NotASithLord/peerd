// @ts-check

import {
  TURN_COMPOSE_CAPABILITY,
  turnPhaseAuthorityAllowed,
  turnPhaseAuthorityFor,
} from '../shared/controller-turn-phase-policy.js';
import { composerReferenceRequestKey } from '../shared/composer-reference-policy.js';

/**
 * @param {{call:(capability:string,payload:unknown,options?:any)=>Promise<any>,
 * handleEffect:(operation:string,payload:unknown,context:any)=>Promise<any>|any,
 * prepareContext?:(input:Record<string,any>)=>Promise<unknown>|unknown}} deps
 */
export const createControllerTurnComposeControl = ({ call, handleEffect, prepareContext }) => {
  if (typeof call !== 'function' || typeof handleEffect !== 'function') {
    throw new TypeError('controller-turn-compose-control-invalid');
  }
  const grants = new WeakMap();
  const contexts = new WeakMap();
  /** @type {WeakSet<object>} */
  const active = new WeakSet();
  const throwIfAborted = (/** @type {AbortSignal|undefined} */ signal) => {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
  };
  const awaitWithSignal = (/** @type {Promise<unknown>|unknown} */ operation,
    /** @type {AbortSignal|undefined} */ signal) => {
    if (!signal) return Promise.resolve(operation);
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve(operation).then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', aborted);
      });
    });
  };
  const compose = async (/** @type {{text:string}} */ input,
    /** @type {any} */ options = undefined) => {
    throwIfAborted(options?.signal);
    const payload = Object.freeze({ text: input.text });
    const authority = turnPhaseAuthorityFor(TURN_COMPOSE_CAPABILITY, payload);
    if (!authority) throw new TypeError('controller-turn-compose-input-invalid');
    const privateContext = typeof prepareContext === 'function'
      ? await awaitWithSignal(prepareContext(input), options?.signal) : null;
    throwIfAborted(options?.signal);
    grants.set(payload, authority);
    contexts.set(payload, privateContext);
    active.add(payload);
    return Promise.resolve(call(TURN_COMPOSE_CAPABILITY, payload, options)).finally(() => {
      active.delete(payload);
      grants.delete(payload);
      contexts.delete(payload);
    });
  };
  return Object.freeze({
    compose,
    authorize: (/** @type {unknown} */ payload) => {
      if (!payload || typeof payload !== 'object') return null;
      const request = /** @type {object} */ (payload);
      if (!active.has(request)) return null;
      const privateContext = /** @type {any} */ (contexts.get(request));
      throwIfAborted(privateContext?.signal);
      if (privateContext?.allowedReferenceTemplate instanceof Map) {
        // Each transport attempt receives the original finite occurrence
        // budget. A read-only retry may repeat an identical pinned read after
        // loss, but can never add or substitute a target.
        privateContext.allowedReferences = new Map(privateContext.allowedReferenceTemplate);
      }
      return grants.get(request) ?? null;
    },
    handleKernelCall: (/** @type {string} */ operation, /** @type {unknown} */ payload,
      /** @type {any} */ context) => {
      const request = context?.outerPayload;
      if (context?.capability !== TURN_COMPOSE_CAPABILITY
          || !request || typeof request !== 'object'
          || !active.has(request)
          || !turnPhaseAuthorityAllowed(
            TURN_COMPOSE_CAPABILITY, request, context.authority,
          )) return { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };
      const privateContext = /** @type {any} */ (contexts.get(request));
      if (operation === 'turn.compose.capture-tab' || operation === 'turn.compose.read-file') {
        const key = composerReferenceRequestKey(operation,
          /** @type {Record<string,unknown>} */ (payload));
        const remaining = privateContext?.allowedReferences?.get(key) ?? 0;
        if (!key || remaining < 1) {
          return handleEffect(operation, payload, {
            ...context, composeContext: privateContext, referenceAllowed: false,
          });
        }
        privateContext.allowedReferences.set(key, remaining - 1);
      }
      return handleEffect(operation, payload, {
        ...context, composeContext: privateContext, referenceAllowed: true,
      });
    },
  });
};
