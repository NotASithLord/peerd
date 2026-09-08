// @ts-check

import {
  makeBoundedModuleLoader,
  STARTUP_UNAVAILABLE_USER_FAILURE,
} from '../shared/bounded-module-load.js';

const startupFailure = (/** @type {unknown} */ cause) => ({
  ok: false,
  error: STARTUP_UNAVAILABLE_USER_FAILURE,
  code: typeof /** @type {{code?:unknown}} */ (cause)?.code === 'string'
    ? /** @type {{code:string}} */ (cause).code : 'kernel-owner-load-failed',
  outcomeKnown: true,
  phase: 'startup',
  retryable: true,
});
const dispatchFailure = () => ({
  ok: false,
  error: 'The operation outcome could not be confirmed.',
  code: 'kernel-owner-dispatch-failed',
  outcomeKnown: false,
  outcomeKind: 'unknown',
  retryable: false,
});

/**
 * @param {Object} deps
 * @param {readonly string[]} deps.names
 * @param {()=>Promise<Record<string,Function>>} deps.load
 * @param {number} [deps.timeoutMs]
 * @param {string} [deps.loadCode]
 * @param {string} [deps.timeoutCode]
 * @param {(name:string,message:any,sender:any)=>Promise<any>|any} [deps.beforeLoad]
 * @param {{name:string,guards:readonly string[],refusal:()=>any}} [deps.interrupt]
 */
export const makeKernelDemandRoutes = ({
  names, load, timeoutMs = 15_000,
  loadCode = 'kernel-owner-load-failed', timeoutCode = 'kernel-owner-load-timeout',
  beforeLoad = () => null,
  interrupt = undefined,
}) => {
  const unique = [...new Set(names)];
  if (unique.length !== names.length || unique.some((name) => typeof name !== 'string' || !name)) {
    throw new TypeError('kernel-demand-route-names-invalid');
  }
  if (interrupt && (!unique.includes(interrupt.name)
      || !Array.isArray(interrupt.guards)
      || interrupt.guards.some((name) => !unique.includes(name))
      || typeof interrupt.refusal !== 'function')) {
    throw new TypeError('kernel-demand-route-interrupt-invalid');
  }
  let interruptEpoch = 0;
  /** @type {Record<string,Function>|null} */
  let liveRoutes = null;
  const owner = makeBoundedModuleLoader(async () => {
    const routes = await load();
    if (!routes || unique.some((name) => typeof routes[name] !== 'function')) {
      throw new TypeError('kernel-demand-route-owner-invalid');
    }
    liveRoutes = routes;
    return routes;
  }, { timeoutMs, loadCode, timeoutCode });
  return Object.freeze(Object.fromEntries(unique.map((name) => [name, async (
    /** @type {any} */ message = {}, /** @type {any} */ sender = undefined,
  ) => {
    if (interrupt && name === interrupt.name) {
      interruptEpoch += 1;
      const handler = liveRoutes?.[name];
      return handler ? handler(message, sender) : { ok: true };
    }
    const admittedAt = interrupt?.guards.includes(name) ? interruptEpoch : null;
    try {
      const refusal = await beforeLoad(name, message, sender);
      if (refusal) return refusal;
    } catch (cause) { return startupFailure(cause); }
    let routes;
    try { routes = await owner(); }
    catch (cause) { return startupFailure(cause); }
    if (admittedAt !== null && admittedAt !== interruptEpoch) return interrupt?.refusal();
    try { return await routes[name](message, sender); }
    catch { return dispatchFailure(); }
  }])));
};
