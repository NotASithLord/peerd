// @ts-check

import { renderSystemPromptFromAssets } from '/peerd-runtime/controller.js';
import { makeBoundedModuleLoader } from '/shared/bounded-module-load.js';

const loadSemanticRoutes = makeBoundedModuleLoader(() => import('./semantic-route-host.js'));
const loadTurnRuntime = makeBoundedModuleLoader(() => import('./controller-turn-runtime.js'));
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
  try {
    const prompt = renderSystemPromptFromAssets(input.ctx, {
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

const DEFAULT_HANDLERS = Object.freeze({
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
    return runtime.runControllerTurn(payload, options);
  },
});

/**
 * @param {{ handlers?: Record<string, (payload: unknown, options: {
 *   signal: AbortSignal, authority?: unknown, deadlineAt?: number,
 *   kernelCall?: (operation:string, payload:unknown)=>Promise<any>,
 * }) => Promise<any>> }} [options]
 */
export const createController = async ({ handlers = DEFAULT_HANDLERS } = {}) => Object.freeze({
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
    const handler = handlers[capability];
    if (typeof handler !== 'function') {
      return { ok: false, code: 'controller-capability-unimplemented', outcomeKnown: true };
    }
    return handler(payload, options);
  },
});
