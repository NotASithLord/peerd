// @ts-check
// Minimal sealed-controller runtime. Feature controllers join this registry in
// later migration slices; this health capability makes the packaged transport
// executable now without granting semantic or browser authority.

import { renderSystemPromptFromAssets } from '/peerd-runtime/controller.js';

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
  ) => (await import('./semantic-route-host.js')).dispatchSemanticRoute(payload, options),
  // Fixed package-local lazy module. The prompt-only controller stays small;
  // the agent loop evaluates only after the authority kernel commits turn.run.
  'turn.run': async (
    /** @type {unknown} */ payload,
    /** @type {{signal:AbortSignal,authority?:unknown,deadlineAt?:number,kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} */ options,
  ) => (
    await import('./controller-turn-runtime.js')
  ).runControllerTurn(payload, options),
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
