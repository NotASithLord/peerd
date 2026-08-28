// @ts-check

import { buildTemporalBlock, renderSystemPromptFromAssets } from '/peerd-runtime/controller.js';
import { makeBoundedModuleLoader } from '/shared/bounded-module-load.js';
import { RUNTIME_DISPATCH_CAPABILITY } from '/shared/kernel-runtime-policy.js';
import {
  KERNEL_FEATURE_DISPATCH_CAPABILITY,
} from '/shared/kernel-feature-policy.js';
import { createKernelFeatureHost } from './kernel-feature-host.js';
import { TURN_COMPOSE_CAPABILITY } from '/shared/controller-turn-phase-policy.js';

const loadSemanticRoutes = makeBoundedModuleLoader(() => import('./semantic-route-host.js'));
const loadTurnRuntime = makeBoundedModuleLoader(() => import('./controller-turn-runtime.js'));
const loadKernelRuntimeHost = makeBoundedModuleLoader(() => import('./kernel-runtime-host.js'));
const loadAdministrativeHost = () => import('./kernel-administrative-host.js');
const loadRepositoryHost = () => import('./kernel-repository-host.js');
const loadLocalHost = () => import('./kernel-local-host.js');
const loadSupportHost = () => import('./kernel-support-host.js');
const loadComposeRuntime = makeBoundedModuleLoader(() => import('./controller-compose-runtime.js'));
const loadFailure = (/** @type {any} */ cause) => ({
  ok: false,
  code: cause?.code ?? 'controller-module-load-failed',
  error: 'Feature unavailable. Try again.',
  outcomeKnown: true,
  retryable: true,
  phase: 'startup',
});

const isRecord = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value);

const renderPrompt = async (/** @type {unknown} */ payload) => {
  if (!isRecord(payload)) {
    return { ok: false, code: 'prompt-payload-invalid', outcomeKnown: true };
  }
  const input = /** @type {Record<string, any>} */ (payload);
  if (!isRecord(input.ctx)
      || typeof input.template !== 'string' || input.template.length > 64 * 1024
      || typeof input.dwebBlock !== 'string' || input.dwebBlock.length > 16 * 1024) {
    return { ok: false, code: 'prompt-payload-invalid', outcomeKnown: true };
  }
  const { temporalNowMs, ...promptContext } = input.ctx;
  if (temporalNowMs !== undefined && !Number.isFinite(temporalNowMs)) {
    return { ok: false, code: 'prompt-payload-invalid', outcomeKnown: true };
  }
  try {
    const prompt = renderSystemPromptFromAssets({
      ...promptContext,
      ...(temporalNowMs === undefined ? {} : {
        temporalBlock: buildTemporalBlock({ lastTurnAt: null, nowMs: temporalNowMs }),
      }),
    }, {
      template: input.template,
      dwebBlock: input.dwebBlock,
    });
    if (prompt.length > 96 * 1024) {
      return { ok: false, code: 'prompt-result-too-large', outcomeKnown: true };
    }
    return { ok: true, prompt, outcomeKnown: true };
  } catch (cause) {
    return {
      ok: false, code: 'prompt-render-failed', outcomeKnown: true,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
};

const makeDefaultHandlers = (/** @type {ReturnType<typeof createKernelFeatureHost>} */ featureHost) => Object.freeze({
  'health.ping': async (/** @type {unknown} */ payload) => ({
    ok: true, outcomeKnown: true, payload,
  }),
  'prompt.render': renderPrompt,
  'semantic.dispatch': async (
    /** @type {unknown} */ payload,
    /** @type {any} */ options,
  ) => {
    let routes;
    try { routes = await loadSemanticRoutes(); }
    catch (cause) { return loadFailure(cause); }
    return routes.dispatchSemanticRoute(payload, options);
  },
  'turn.run': async (
    /** @type {unknown} */ payload,
    /** @type {{signal:AbortSignal,authority?:unknown,deadlineAt?:number,kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} */ options,
  ) => {
    let runtime;
    try { runtime = await loadTurnRuntime(); }
    catch (cause) { return loadFailure(cause); }
    const turn = runtime.createControllerTurnRuntime();
    return turn.runControllerTurn(payload, options);
  },
  'turn.tools.project': async (/** @type {unknown} */ payload) => {
    let runtime;
    try { runtime = await loadTurnRuntime(); }
    catch (cause) { return loadFailure(cause); }
    return runtime.createControllerTurnRuntime().projectTools(payload);
  },
  'turn.tools.command': async (/** @type {unknown} */ payload) => {
    let runtime;
    try { runtime = await loadTurnRuntime(); }
    catch (cause) { return loadFailure(cause); }
    return runtime.createControllerTurnRuntime().planToolsCommand(payload);
  },
  [TURN_COMPOSE_CAPABILITY]: async (/** @type {unknown} */ payload,
    /** @type {any} */ options) => {
    let runtime;
    try { runtime = await loadComposeRuntime(); }
    catch (cause) { return loadFailure(cause); }
    return runtime.composeTurn(payload, options);
  },
  [KERNEL_FEATURE_DISPATCH_CAPABILITY]: featureHost.dispatch,
});

/**
 * @param {{ handlers?: Record<string, (payload: unknown, options: {
 *   signal: AbortSignal, authority?: unknown, deadlineAt?: number,
 *   kernelCall?: (operation:string, payload:unknown)=>Promise<any>,
 * }) => Promise<any>>, featureHost?:ReturnType<typeof createKernelFeatureHost>,
 * loadRuntimeHost?:()=>Promise<{
 *   createKernelRuntimeHost:(options?:any)=>{dispatch:(payload:unknown,options:any)=>Promise<any>}
 * }> }} [options]
 */
export const createController = async ({
  handlers,
  featureHost: injectedFeatureHost,
  loadRuntimeHost: runtimeHostLoader = loadKernelRuntimeHost,
} = {}) => {
  const featureHost = injectedFeatureHost ?? createKernelFeatureHost({
    loaders: {
      administrative: loadAdministrativeHost,
      repository: loadRepositoryHost,
      local: loadLocalHost,
      support: loadSupportHost,
    },
  });
  /** @type {{dispatch:(payload:unknown,options:any)=>Promise<any>} | null} */
  let runtimeHost = null;
  /** @type {Promise<{dispatch:(payload:unknown,options:any)=>Promise<any>}> | null} */
  let runtimeHostLoading = null;
  const runtimeDispatch = async (/** @type {unknown} */ payload, /** @type {any} */ options) => {
    let host = runtimeHost;
    if (!host) {
      try {
        runtimeHostLoading ??= runtimeHostLoader().then((module) => {
          if (typeof module?.createKernelRuntimeHost !== 'function') {
            throw new Error('kernel runtime host factory missing');
          }
          const candidate = module.createKernelRuntimeHost();
          if (!candidate || typeof candidate.dispatch !== 'function') {
            throw new Error('kernel runtime host invalid');
          }
          runtimeHost = candidate;
          return candidate;
        });
        host = await runtimeHostLoading;
      }
      catch (cause) {
        runtimeHostLoading = null;
        return loadFailure(cause);
      }
    }
    return host.dispatch(payload, options);
  };
  /** @type {Record<string, (payload:unknown, options:any)=>Promise<any>>} */
  const activeHandlers = Object.freeze({
    ...makeDefaultHandlers(featureHost),
    ...handlers,
    [RUNTIME_DISPATCH_CAPABILITY]: runtimeDispatch,
  });
  return Object.freeze({
  /**
   * @param {string} capability
   * @param {unknown} payload
   * @param {{ signal: AbortSignal, authority?: unknown, deadlineAt?: number,
   *   kernelCall?: (operation:string, payload:unknown)=>Promise<any> }} options
   */
  call: async (capability, payload, options) => {
    if (options.signal.aborted) {
      return { ok: false, code: 'controller-call-aborted', outcomeKnown: true };
    }
    const handler = activeHandlers[capability];
    if (typeof handler !== 'function') {
      return { ok: false, code: 'controller-capability-unimplemented', outcomeKnown: true };
    }
    return handler(payload, options);
  },
  });
};
