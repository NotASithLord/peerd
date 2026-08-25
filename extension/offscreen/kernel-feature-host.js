// @ts-check

import { makeBoundedModuleLoader } from '../shared/bounded-module-load.js';
import {
  KERNEL_FEATURE_DISPATCH_CAPABILITY,
  createKernelFeatureEffectQuota,
  kernelFeatureAuthorityAllowed,
  kernelFeatureResultAllowed,
  parseKernelFeatureDispatch,
} from '../shared/kernel-feature-policy.js';

const failure = (/** @type {string} */ code, /** @type {boolean} */ outcomeKnown,
  /** @type {'startup'|'run'} */ phase, /** @type {boolean} */ retryable = false) => Object.freeze({
  ok: false,
  code,
  outcomeKnown,
  phase,
  retryable,
});
/**
 * @param {{loaders?:Record<string,()=>Promise<any>>,
 * loadTimeoutMs?:number,now?:()=>number,setTimeoutFn?:typeof setTimeout,
 * clearTimeoutFn?:typeof clearTimeout}} [deps]
 */
export const createKernelFeatureHost = ({
  loaders = {}, loadTimeoutMs = 15_000, now = Date.now,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
} = {}) => {
  const clusters = Object.freeze(Object.fromEntries(Object.entries(loaders).map(
    ([cluster, load]) => [cluster, makeBoundedModuleLoader(load, {
      timeoutMs: loadTimeoutMs,
      loadCode: `feature-${cluster}-load-failed`,
      timeoutCode: `feature-${cluster}-load-timeout`,
    })],
  )));
  /** @type {Map<string,number>} */ const activeRoutes = new Map();
  /** @type {Set<(code:string)=>void>} */ const activeGrants = new Set();
  let poisoned = false;
  const poison = (/** @type {string} */ code) => {
    if (poisoned) return;
    poisoned = true;
    for (const expire of [...activeGrants]) expire(code);
  };
  const dispatch = async (/** @type {unknown} */ payload, /** @type {{
   * signal:AbortSignal,authority?:unknown,deadlineAt?:number,
   * kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} */ options) => {
    const request = parseKernelFeatureDispatch(payload);
    if (!request) return failure('feature-dispatch-invalid', true, 'startup');
    if (poisoned) {
      return failure('feature-host-generation-retired', true, 'startup', true);
    }
    if (!kernelFeatureAuthorityAllowed(
      KERNEL_FEATURE_DISPATCH_CAPABILITY, payload, options?.authority,
    )) return failure('feature-authority-invalid', true, 'startup');
    if (!options?.signal || options.signal.aborted
        || !Number.isSafeInteger(options.deadlineAt) || Number(options.deadlineAt) <= now()) {
      return failure('feature-grant-invalid', true, 'startup');
    }
    if (Number(options.deadlineAt) - now() > request.policy.maxDurationMs) {
      return failure('feature-duration-invalid', true, 'startup');
    }
    const routeKey = `${request.cluster}\0${request.route}`;
    const active = activeRoutes.get(routeKey) ?? 0;
    if (active >= request.policy.concurrent) {
      return failure('feature-route-concurrency-exhausted', true, 'startup', true);
    }
    activeRoutes.set(routeKey, active + 1);
    try {
      const load = clusters[request.cluster];
      if (!load) return failure('feature-cluster-unavailable', true, 'startup', true);
      let module;
      try { module = await load(); }
      catch (cause) {
        if (typeof /** @type {{code?:unknown}} */ (cause)?.code === 'string'
            && /** @type {{code:string}} */ (cause).code.endsWith('-load-timeout')) {
          poison('feature-host-generation-expired');
        }
        return failure(
          /** @type {{code?:string}} */ (cause)?.code ?? 'feature-module-load-failed',
          true,
          'startup',
          true,
        );
      }
      const routes = module?.routes ?? module?.default?.routes ?? module?.default ?? module;
      const handler = routes?.[request.route];
      if (typeof handler !== 'function') {
        return failure('feature-route-unavailable', true, 'startup', true);
      }
      if (poisoned) {
        return failure('feature-host-generation-retired', true, 'startup', true);
      }
      if (options.signal.aborted || Number(options.deadlineAt) <= now()) {
        return failure('feature-grant-expired', true, 'startup', true);
      }
      const quota = createKernelFeatureEffectQuota(KERNEL_FEATURE_DISPATCH_CAPABILITY, payload);
      let effectsStarted = 0;
      let grantOpen = true;
      const grant = new AbortController();
      let stop = (/** @type {Record<string,unknown>} */ _result) => {};
      const stopped = new Promise((resolve) => { stop = resolve; });
      const expire = (/** @type {string} */ code) => {
        if (!grantOpen) return;
        grantOpen = false;
        grant.abort();
        stop(failure(
          code, effectsStarted === 0, 'run', effectsStarted === 0,
        ));
      };
      const expireGeneration = () => poison('feature-host-generation-expired');
      activeGrants.add(expire);
      options.signal.addEventListener('abort', expireGeneration, { once: true });
      const deadlineTimer = setTimeoutFn(
        expireGeneration, Math.max(1, Number(options.deadlineAt) - now()),
      );
      const call = async (/** @type {string} */ operation, /** @type {unknown} */ value) => {
        if (poisoned || !grantOpen || grant.signal.aborted
            || Number(options.deadlineAt) <= now()) {
          return failure(poisoned
            ? 'feature-host-generation-retired' : 'feature-grant-settled', true, 'run');
        }
        const admitted = quota.admit(operation, value);
        if (admitted?.ok !== true) return admitted;
        if (typeof options.kernelCall !== 'function') {
          const denied = failure('kernel-operation-denied', true, 'run');
          quota.observe(operation, value, denied);
          return denied;
        }
        effectsStarted += 1;
        let result;
        try { result = await options.kernelCall(operation, value); }
        catch { result = failure('kernel-operation-failed', false, 'run'); }
        if (poisoned || !grantOpen || grant.signal.aborted) {
          return failure('feature-host-generation-retired', false, 'run');
        }
        const observed = quota.observe(operation, value, result);
        return observed?.ok === true ? result : observed;
      };
      try {
        const execution = Promise.resolve().then(() => handler(
          request.message,
          Object.freeze({
            effects: Object.freeze({
              call, signal: grant.signal, deadlineAt: options.deadlineAt,
            }),
          }),
        )).then((value) => {
          if (poisoned || !grantOpen || grant.signal.aborted
              || Number(options.deadlineAt) <= now()) {
            poison('feature-host-generation-expired');
            return failure(
              'feature-host-generation-expired', effectsStarted === 0,
              'run', effectsStarted === 0,
            );
          }
          const result = Object.freeze({ ok: true, outcomeKnown: true, value });
          return kernelFeatureResultAllowed(KERNEL_FEATURE_DISPATCH_CAPABILITY, payload, result)
            ? result : failure('feature-result-invalid', false, 'run');
        }).catch((cause) => failure(
          'feature-dispatch-failed',
          effectsStarted === 0
            || /** @type {{outcomeKnown?:unknown}} */ (cause)?.outcomeKnown === true,
          'run',
        ));
        return await Promise.race([execution, stopped]);
      } finally {
        grantOpen = false;
        grant.abort();
        clearTimeoutFn(deadlineTimer);
        activeGrants.delete(expire);
        options.signal.removeEventListener('abort', expireGeneration);
      }
    } finally {
      const remaining = (activeRoutes.get(routeKey) ?? 1) - 1;
      if (remaining > 0) activeRoutes.set(routeKey, remaining);
      else activeRoutes.delete(routeKey);
    }
  };
  return Object.freeze({ dispatch });
};
