// @ts-check

import {
  createRuntimeEffectQuota,
  parseRuntimeDispatch,
  runtimeDispatchAuthorityAllowed,
  runtimeDispatchResultAllowed,
} from '/shared/kernel-runtime-policy.js';
import { dispatchKernelRichRelay } from './kernel-rich-relay-host.js';

const stopped = (/** @type {string} */ code, /** @type {boolean} */ known,
  /** @type {'startup'|'run'} */ phase) => Object.freeze({
  ok: false, code, outcomeKnown: known, phase,
});

const DEFAULT_HANDLERS = Object.freeze({
  'runtime.bootstrap': async (
    /** @type {unknown} */ _input,
    /** @type {{effects:{call:(operation:string,payload:unknown)=>Promise<any>}}} */ context,
  ) => {
    const result = await context.effects.call('runtime.bootstrap.read', {});
    return result?.ok === true
      ? { ok: true, outcomeKnown: true, value: result.value ?? {} }
      : result;
  },
  'runtime.probe': async () => Object.freeze({
    ok: true, outcomeKnown: true, value: Object.freeze({ ready: true }),
  }),
  'runtime.rich.relay': dispatchKernelRichRelay,
  'runtime.rich.abort': dispatchKernelRichRelay,
});

/**
 * @param {{handlers?:Record<string,(input:unknown,context:{
 *   effects:{signal:AbortSignal,deadlineAt:number,
 *   call:(operation:string,payload:unknown)=>Promise<any>}
 * })=>Promise<unknown>|unknown>,now?:()=>number,
 * setTimeoutFn?:typeof setTimeout,clearTimeoutFn?:typeof clearTimeout}} [deps]
 */
export const createKernelRuntimeHost = ({
  handlers = DEFAULT_HANDLERS,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) => {
  /** @type {Map<string, number>} */
  const active = new Map();
  const dispatch = async (/** @type {unknown} */ payload, /** @type {{
   * signal:AbortSignal,authority?:unknown,deadlineAt?:number,
   * kernelCall?:(operation:string,payload:unknown)=>Promise<any>
   * }} */ options) => {
    const request = parseRuntimeDispatch(payload);
    if (!request) return stopped('runtime-operation-denied', true, 'startup');
    if (!runtimeDispatchAuthorityAllowed(payload, options?.authority)) {
      return stopped('runtime-authority-invalid', true, 'startup');
    }
    if (!options?.signal || options.signal.aborted
        || !Number.isSafeInteger(options.deadlineAt) || Number(options.deadlineAt) <= now()) {
      return stopped('runtime-grant-invalid', true, 'startup');
    }
    if (Number(options.deadlineAt) - now() > request.policy.maxDurationMs) {
      return stopped('runtime-duration-invalid', true, 'startup');
    }
    const count = active.get(request.operation) ?? 0;
    if (count >= request.policy.concurrent) {
      return stopped('runtime-concurrency-exhausted', true, 'startup');
    }
    const handler = handlers[request.operation];
    if (typeof handler !== 'function') {
      return stopped('runtime-operation-unimplemented', true, 'startup');
    }
    active.set(request.operation, count + 1);
    let grantOpen = true;
    const abort = new AbortController();
    let stop = (/** @type {ReturnType<typeof stopped>} */ _result) => {};
    const stoppedRun = new Promise((resolve) => { stop = resolve; });
    const onAbort = () => {
      abort.abort();
      stop(stopped('runtime-call-aborted', false, 'run'));
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    const deadlineTimer = setTimeoutFn(() => {
      abort.abort();
      stop(stopped('runtime-deadline-expired', false, 'run'));
    }, Math.max(1, Number(options.deadlineAt) - now()));
    const effectQuota = createRuntimeEffectQuota(payload);
    const callEffect = async (/** @type {string} */ operation, /** @type {unknown} */ value) => {
      if (!grantOpen || abort.signal.aborted || Number(options.deadlineAt) <= now()) {
        return {
          ok: false, code: 'runtime-grant-settled', outcomeKnown: true,
        };
      }
      const admitted = effectQuota.admit(operation, value);
      if (admitted?.ok !== true) return admitted;
      if (typeof options.kernelCall !== 'function') {
        const denied = {
          ok: false, code: 'kernel-operation-denied', outcomeKnown: true,
        };
        effectQuota.observe(operation, value, denied);
        return denied;
      }
      let result;
      try { result = await options.kernelCall(operation, value); }
      catch {
        result = { ok: false, code: 'kernel-operation-failed', outcomeKnown: false };
      }
      const observed = effectQuota.observe(operation, value, result);
      return observed?.ok === true ? result : observed;
    };
    const effects = Object.freeze({
      signal: abort.signal,
      deadlineAt: Number(options.deadlineAt),
      call: callEffect,
    });
    try {
      const execution = Promise.resolve()
        .then(() => handler(request.input, { effects }))
        .then((result) => runtimeDispatchResultAllowed(payload, result)
          ? result : stopped('runtime-result-invalid', false, 'run'))
        .catch(() => stopped('runtime-dispatch-failed', false, 'run'));
      return await Promise.race([execution, stoppedRun]);
    } finally {
      grantOpen = false;
      abort.abort();
      clearTimeoutFn(deadlineTimer);
      options.signal.removeEventListener('abort', onAbort);
      const remaining = (active.get(request.operation) ?? 1) - 1;
      if (remaining > 0) active.set(request.operation, remaining);
      else active.delete(request.operation);
    }
  };
  return Object.freeze({ dispatch });
};
