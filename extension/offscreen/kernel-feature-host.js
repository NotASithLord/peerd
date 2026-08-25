// @ts-check

import { makeBoundedModuleLoader } from '../shared/bounded-module-load.js';
import {
  KERNEL_FEATURE_DISPATCH_CAPABILITY,
  KERNEL_FEATURE_EVENT_CAPABILITY,
  createKernelFeatureEffectQuota,
  kernelFeatureAuthorityAllowed,
  kernelFeatureResultAllowed,
  parseKernelFeatureDispatch,
  parseKernelFeatureEvent,
} from '../shared/kernel-feature-policy.js';

const failure = (/** @type {string} */ code, /** @type {boolean} */ outcomeKnown,
  /** @type {'startup'|'run'} */ phase, /** @type {boolean} */ retryable = false) => Object.freeze({
  ok: false,
  code,
  outcomeKnown,
  phase,
  retryable,
});
const eventEnvelope = (/** @type {unknown} */ value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = /** @type {Record<string,any>} */ (value);
  if (Object.keys(input).sort().join(',') !== 'bootId,eventId,kernelEpoch,sequence,value'
      || typeof input.bootId !== 'string' || input.bootId.length < 8 || input.bootId.length > 512
      || typeof input.eventId !== 'string' || input.eventId.length < 8
      || input.eventId.length > 512
      || typeof input.kernelEpoch !== 'string' || input.kernelEpoch.length < 8
      || input.kernelEpoch.length > 512 || !Number.isSafeInteger(input.sequence)
      || input.sequence < 1 || !input.value || typeof input.value !== 'object'
      || Array.isArray(input.value)) return null;
  return input;
};

/**
 * @param {{loaders?:Record<string,()=>Promise<any>>,events?:Record<string,Function>,
 * loadTimeoutMs?:number,now?:()=>number}} [deps]
 */
export const createKernelFeatureHost = ({
  loaders = {}, events = {}, loadTimeoutMs = 15_000, now = Date.now,
} = {}) => {
  const clusters = Object.freeze(Object.fromEntries(Object.entries(loaders).map(
    ([cluster, load]) => [cluster, makeBoundedModuleLoader(load, {
      timeoutMs: loadTimeoutMs,
      loadCode: `feature-${cluster}-load-failed`,
      timeoutCode: `feature-${cluster}-load-timeout`,
    })],
  )));
  /** @type {{bootId:string,kernelEpoch:string}|null} */ let eventIdentity = null;
  /** @type {Map<string,number>} */ const activeRoutes = new Map();
  let eventSequence = 0;
  let eventLane = Promise.resolve();
  const dispatch = async (/** @type {unknown} */ payload, /** @type {{
   * signal:AbortSignal,authority?:unknown,deadlineAt?:number,
   * kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} */ options) => {
    const request = parseKernelFeatureDispatch(payload);
    if (!request) return failure('feature-dispatch-invalid', true, 'startup');
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
      if (options.signal.aborted || Number(options.deadlineAt) <= now()) {
        return failure('feature-grant-expired', true, 'startup', true);
      }
      const quota = createKernelFeatureEffectQuota(KERNEL_FEATURE_DISPATCH_CAPABILITY, payload);
      let effectsStarted = 0;
      let grantOpen = true;
      const grant = new AbortController();
      let stop = (/** @type {Record<string,unknown>} */ _result) => {};
      const stopped = new Promise((resolve) => { stop = resolve; });
      const expire = () => {
        if (!grantOpen) return;
        grant.abort();
        stop(failure(
          'feature-grant-expired', effectsStarted === 0, 'run', effectsStarted === 0,
        ));
      };
      options.signal.addEventListener('abort', expire, { once: true });
      const deadlineTimer = setTimeout(expire, Math.max(1, Number(options.deadlineAt) - now()));
      const call = async (/** @type {string} */ operation, /** @type {unknown} */ value) => {
        if (!grantOpen || grant.signal.aborted || Number(options.deadlineAt) <= now()) {
          return failure('feature-grant-settled', true, 'run');
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
        clearTimeout(deadlineTimer);
        options.signal.removeEventListener('abort', expire);
      }
    } finally {
      const remaining = (activeRoutes.get(routeKey) ?? 1) - 1;
      if (remaining > 0) activeRoutes.set(routeKey, remaining);
      else activeRoutes.delete(routeKey);
    }
  };
  const event = async (/** @type {unknown} */ payload, /** @type {{
   * signal:AbortSignal,authority?:unknown,deadlineAt?:number}} */ options) => {
    const request = parseKernelFeatureEvent(payload);
    if (!request) return failure('feature-event-invalid', true, 'startup');
    if (!kernelFeatureAuthorityAllowed(
      KERNEL_FEATURE_EVENT_CAPABILITY, payload, options?.authority,
    )) return failure('feature-authority-invalid', true, 'startup');
    if (!options?.signal || options.signal.aborted
        || !Number.isSafeInteger(options.deadlineAt) || Number(options.deadlineAt) <= now()) {
      return failure('feature-grant-invalid', true, 'startup');
    }
    const run = eventLane.then(async () => {
      const envelope = eventEnvelope(request.payload);
      if (!envelope) return failure('feature-event-envelope-invalid', true, 'startup');
      if (options.signal.aborted || Number(options.deadlineAt) <= now()) {
        return failure('feature-grant-expired', true, 'startup', true);
      }
      if (eventIdentity && (eventIdentity.bootId !== envelope.bootId
          || eventIdentity.kernelEpoch !== envelope.kernelEpoch)) {
        return failure('feature-event-generation-invalid', true, 'startup');
      }
      if (envelope.sequence <= eventSequence) {
        return Object.freeze({
          ok: true, outcomeKnown: true,
          value: Object.freeze({ accepted: false, duplicate: true }),
        });
      }
      if (!eventIdentity && request.event !== 'production/reconcile') {
        return failure('feature-event-reconcile-required', true, 'startup', true);
      }
      if (eventIdentity && envelope.sequence !== eventSequence + 1
          && request.event !== 'production/reconcile') {
        return Object.freeze({
          ok: true, outcomeKnown: true,
          value: Object.freeze({ accepted: false, gap: true, reconcile: true }),
        });
      }
      const handler = events[request.event];
      if (typeof handler !== 'function') {
        return failure('feature-event-unavailable', true, 'startup', true);
      }
      try {
        const value = await handler(envelope.value, Object.freeze({
          signal: options.signal,
          identity: Object.freeze({
            bootId: envelope.bootId,
            kernelEpoch: envelope.kernelEpoch,
            eventId: envelope.eventId,
            sequence: envelope.sequence,
          }),
        }));
        eventIdentity ??= Object.freeze({
          bootId: envelope.bootId, kernelEpoch: envelope.kernelEpoch,
        });
        eventSequence = envelope.sequence;
        const result = Object.freeze({ ok: true, outcomeKnown: true, value });
        return kernelFeatureResultAllowed(KERNEL_FEATURE_EVENT_CAPABILITY, payload, result)
          ? result : failure('feature-result-invalid', false, 'run');
      } catch (cause) {
        const failed = /** @type {{code?:unknown,outcomeKnown?:unknown,retryable?:unknown}} */ (
          cause
        );
        return failure(
          typeof failed?.code === 'string' ? failed.code : 'feature-event-failed',
          cause instanceof TypeError || failed?.outcomeKnown === true,
          'run',
          failed?.retryable === true,
        );
      }
    });
    eventLane = run.then(() => {}, () => {});
    return run;
  };
  return Object.freeze({ dispatch, event });
};
