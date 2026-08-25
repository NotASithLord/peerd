// @ts-check

import {
  parseRuntimeBootstrapProjection,
  parseRuntimeDispatch,
  runtimeDispatchTimeoutMs,
} from '/shared/kernel-runtime-policy.js';

/** @param {{call:(payload:unknown,options?:{timeoutMs?:number})=>Promise<any>,
 * readBootstrap?:()=>Promise<unknown>|unknown,now?:()=>number,
 * handleRichKernelCall?:(operation:string,payload:unknown,context:any)=>Promise<any>|any}} deps */
export const createKernelRuntimeControl = ({
  call, readBootstrap = () => null, now = Date.now, handleRichKernelCall,
}) => {
  if (typeof call !== 'function') throw new TypeError('kernel-runtime-control-config-invalid');
  const grants = new WeakMap();
  const issue = (/** @type {string} */ operation, /** @type {Record<string,unknown>} */ input = {}) => {
    const payload = Object.freeze({ operation, input: Object.freeze(input) });
    const parsed = parseRuntimeDispatch(payload);
    if (!parsed) throw new TypeError('kernel-runtime-operation-invalid');
    const timeoutMs = runtimeDispatchTimeoutMs(payload, now());
    if (timeoutMs === 0) {
      return Promise.resolve({
        ok: true, outcomeKnown: true,
        value: { ok: false, error: 'provider: run deadline expired' },
      });
    }
    grants.set(payload, Object.freeze({
      ownerId: parsed.policy.authority.ownerId,
      sessionId: null,
      instanceId: null,
      origin: null,
      target: parsed.policy.authority.target,
      replayClass: parsed.policy.authority.replayClass,
    }));
    return call(payload, { timeoutMs: /** @type {number} */ (timeoutMs) });
  };
  return Object.freeze({
    bootstrap: () => issue('runtime.bootstrap'),
    probe: () => issue('runtime.probe'),
    relay: (/** @type {string} */ route, /** @type {unknown} */ message) =>
      issue(route === 'script-run/abort' ? 'runtime.rich.abort' : 'runtime.rich.relay', {
        route, message,
      }),
    authorize: (/** @type {unknown} */ payload) => {
      if (!payload || typeof payload !== 'object') return null;
      const key = /** @type {object} */ (payload);
      const grant = grants.get(key) ?? null;
      grants.delete(key);
      return grant;
    },
    handleKernelCall: async (
      /** @type {string} */ operation,
      /** @type {unknown} */ payload,
      /** @type {{capability?:string,authority?:any}} */ context,
    ) => {
      if (context?.capability !== 'runtime.dispatch') {
        return { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };
      }
      if (context?.authority?.replayClass === 'E'
          && ((context.authority.target === 'kernel-runtime-rich-relay'
              && (operation === 'rich.script.admit' || operation === 'rich.model.call'))
            || (context.authority.target === 'kernel-runtime-rich-abort'
              && operation === 'rich.script.abort'))) {
        return typeof handleRichKernelCall === 'function'
          ? handleRichKernelCall(operation, payload, context)
          : { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };
      }
      if (operation !== 'runtime.bootstrap.read'
          || !payload || typeof payload !== 'object' || Array.isArray(payload)
          || Object.keys(payload).length !== 0
          || context?.authority?.target !== 'kernel-runtime'
          || context.authority.replayClass !== 'A') {
        return { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };
      }
      try {
        const projection = parseRuntimeBootstrapProjection(await readBootstrap());
        return projection
          ? { ok: true, outcomeKnown: true, value: projection }
          : { ok: false, code: 'runtime-bootstrap-projection-invalid', outcomeKnown: false };
      } catch {
        return { ok: false, code: 'runtime-bootstrap-read-failed', outcomeKnown: false };
      }
    },
  });
};
