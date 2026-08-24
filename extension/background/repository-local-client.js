// @ts-check
// Firefox-only local repository generation, loaded after an admitted operation.

import {
  repositoryMethodIsAppFile,
  repositoryMethodIsKnown,
  repositoryMethodIsMutating,
  repositoryMethodMayFetch,
} from '../shared/feature-lease-protocol.js';
import { makeRepositoryFacade, repositoryKey } from './repository-client.js';
import { makeBoundedModuleLoader } from '../shared/bounded-module-load.js';

/**
 * @param {{
 *   loadService: () => Promise<ReturnType<typeof import('../peerd-engine/repository.js').createRepositoryService>>,
 *   loadAppService?: () => Promise<Record<string,any>>,
 *   withLifetime?: <T>(operation:()=>Promise<T>,options?:{
 *     outcomeKnownOnLoss?:boolean,code?:string,onLost?:(cause:Error)=>void,
 *   })=>Promise<T>,
 *   appReadTimeoutMs?: number,
 *   appEffectTimeoutMs?: number,
 *   loadTimeoutMs?: number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 * }} deps
 * @returns {ReturnType<typeof import('../peerd-engine/repository.js').createRepositoryService>}
 */
export const createLazyLocalRepositoryClient = ({
  loadService,
  loadAppService = async () => {
    const { createRepositoryAppFileService } = await import('/offscreen/repository-app-files.js');
    return createRepositoryAppFileService();
  },
  withLifetime = (operation) => operation(),
  appReadTimeoutMs = 8_000,
  appEffectTimeoutMs = 15_000,
  loadTimeoutMs = 10_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  if (!Number.isFinite(appReadTimeoutMs) || appReadTimeoutMs <= 0
      || !Number.isFinite(appEffectTimeoutMs) || appEffectTimeoutMs <= 0) {
    throw new TypeError('repository-local-timeout-invalid');
  }
  const loadRepositoryService = makeBoundedModuleLoader(loadService, {
    timeoutMs: loadTimeoutMs,
    loadCode: 'repository-service-load-failed',
    timeoutCode: 'repository-service-load-timeout',
  });
  const loadRepositoryAppService = makeBoundedModuleLoader(loadAppService, {
    timeoutMs: loadTimeoutMs,
    loadCode: 'repository-app-service-load-failed',
    timeoutCode: 'repository-app-service-load-timeout',
  });
  /** @type {Promise<ReturnType<typeof import('../peerd-engine/repository.js').createRepositoryService>> | null} */
  let servicePromise = null;
  /** @type {Promise<Record<string,any>> | null} */
  let appServicePromise = null;
  /** A lost Firefox generation must drain before a replacement can touch OPFS. */
  /** @type {Promise<void> | null} */
  let generationBarrier = null;
  const getService = () => {
    if (!servicePromise) {
      servicePromise = loadRepositoryService().catch((error) => {
        servicePromise = null;
        throw error;
      });
    }
    return servicePromise;
  };
  const getAppService = () => {
    if (!appServicePromise) {
      appServicePromise = loadRepositoryAppService().catch((error) => {
        appServicePromise = null;
        throw error;
      });
    }
    return appServicePromise;
  };
  /** @type {Map<string, Promise<unknown>>} */ const transactionTails = new Map();
  /** @type {Map<string, Promise<unknown>>} */ const operationTails = new Map();
  /** @template T @param {Map<string,Promise<unknown>>} lanes @param {string} key @param {()=>Promise<T>} operation */
  const enqueue = async (lanes, key, operation) => {
    const prior = lanes.get(key) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(operation);
    lanes.set(key, current);
    try { return await current; }
    finally { if (lanes.get(key) === current) lanes.delete(key); }
  };
  /** @template T @param {string[]} keys @param {()=>Promise<T>} operation */
  const enqueueMany = (keys, operation) => [...new Set(keys)].sort().reduceRight(
    (next, key) => () => enqueue(operationTails, key, next), operation,
  )();
  /** @param {string} method @param {any[]} args */
  const invokeUnqueued = async (method, args) => {
    if (!repositoryMethodIsKnown(method)) throw new Error(`unsupported repository operation: ${method}`);
    if (generationBarrier) {
      const error = /** @type {Error & {outcomeKnown?:boolean,code?:string}} */ (
        new Error('The retired Firefox repository generation is still settling. Reconcile and retry shortly.')
      );
      error.code = 'repository-firefox-generation-draining';
      error.outcomeKnown = true;
      throw error;
    }
    const wireArgs = [...args];
    const callerSignal = args.findLast((entry) => entry?.signal instanceof AbortSignal)?.signal;
    if (callerSignal?.aborted) {
      const error = /** @type {Error & {outcomeKnown?:boolean,code?:string}} */ (
        callerSignal.reason instanceof Error ? callerSignal.reason : new Error('repository operation aborted')
      );
      error.code ??= 'repository-call-aborted';
      error.outcomeKnown = true;
      throw error;
    }
    const abort = new AbortController();
    const abortFromCaller = () => abort.abort(callerSignal?.reason ?? 'repository operation aborted');
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
    if (repositoryMethodMayFetch(method) || repositoryMethodIsAppFile(method)) {
      const options = wireArgs[1] && typeof wireArgs[1] === 'object' && !Array.isArray(wireArgs[1])
        ? wireArgs[1] : {};
      wireArgs[1] = { ...options, signal: abort.signal };
    }
    /** @type {Promise<any> | null} */
    let usedGeneration = null;
    /** @type {(value?:unknown)=>void} */ let settleOperation = () => {};
    const operationSettled = new Promise((resolve) => { settleOperation = resolve; });
    let dispatched = false;
    /** @type {ReturnType<typeof setTimeout>|null} */ let deadlineTimer = null;
    try {
      const lifetimeWork = withLifetime(async () => {
        try {
          if (abort.signal.aborted) throw abort.signal.reason;
          usedGeneration = repositoryMethodIsAppFile(method) ? getAppService() : getService();
          const service = await usedGeneration;
          if (abort.signal.aborted) throw abort.signal.reason;
          dispatched = true;
          return await /** @type {any} */ (service)[method](...wireArgs);
        } finally { settleOperation(); }
      }, {
        outcomeKnownOnLoss: !repositoryMethodIsMutating(method),
        code: repositoryMethodIsMutating(method)
          ? 'repository-firefox-effect-lifetime-lost'
          : 'repository-firefox-read-lifetime-lost',
        onLost: (cause) => abort.abort(cause),
      });
      if (!repositoryMethodIsAppFile(method)) return await lifetimeWork;
      const timeoutMs = repositoryMethodIsMutating(method)
        ? appEffectTimeoutMs : appReadTimeoutMs;
      const deadline = new Promise((_, reject) => {
        deadlineTimer = setTimeoutFn(() => {
          const error = /** @type {Error & {outcomeKnown?:boolean,code?:string}} */ (
            new Error('App file service took too long to respond.')
          );
          error.code = 'repository-app-file-timeout';
          error.outcomeKnown = dispatched ? !repositoryMethodIsMutating(method) : true;
          abort.abort(error);
          reject(error);
        }, timeoutMs);
      });
      return await Promise.race([lifetimeWork, deadline]);
    } catch (cause) {
      const classification = /** @type {{outcomeKnown?:boolean,code?:string}} */ (cause);
      if (!dispatched && classification?.outcomeKnown === false) {
        classification.outcomeKnown = true;
        classification.code = 'repository-firefox-startup-lost';
      }
      if (classification?.outcomeKnown === false) {
        const drain = operationSettled.catch(() => {}).then(() => {
          if (repositoryMethodIsAppFile(method)) {
            if (appServicePromise === usedGeneration) appServicePromise = null;
            loadRepositoryAppService.reset();
          } else if (servicePromise === usedGeneration) servicePromise = null;
          if (!repositoryMethodIsAppFile(method)) loadRepositoryService.reset();
        });
        generationBarrier = drain;
        void drain.finally(() => {
          if (generationBarrier === drain) generationBarrier = null;
        });
      } else if (repositoryMethodIsMutating(method) && dispatched
          && callerSignal?.aborted && classification?.outcomeKnown !== true) {
        classification.outcomeKnown = false;
        classification.code ??= 'repository-call-aborted-outcome-unknown';
      }
      throw cause;
    } finally {
      if (deadlineTimer !== null) clearTimeoutFn(deadlineTimer);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    }
  };
  /** @param {string} method @param {any[]} args */
  const invoke = (method, args) => {
    const refs = method === 'fork' ? [args[0], args[1]] : [args[0]];
    const keys = refs.filter((entry) => entry && typeof entry === 'object'
      && typeof entry.kind === 'string' && typeof entry.id === 'string').map(repositoryKey);
    return keys.length ? enqueueMany(keys, () => invokeUnqueued(method, args))
      : invokeUnqueued(method, args);
  };
  return makeRepositoryFacade(invoke, (ref, operation) =>
    enqueue(transactionTails, repositoryKey(ref), operation));
};

/**
 * @param {Object} deps
 * @param {(url:string,init?:RequestInit)=>Promise<Response>} deps.webFetch
 * @param {(name:string)=>Promise<string|null>} deps.getSecret
 * @param {(event:any)=>void} deps.audit
 * @param {<T>(operation:()=>Promise<T>,options?:any)=>Promise<T>} deps.withLifetime
 */
export const createFirefoxRepositoryClient = ({ webFetch, getSecret, audit, withLifetime }) =>
  createLazyLocalRepositoryClient({
    loadService: async () => {
      const { createRepositoryService } = await import('/peerd-engine/repository.js');
      return createRepositoryService({ webFetch, getSecret, audit });
    },
    withLifetime,
  });
