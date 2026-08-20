// @ts-check
// Pure translation between the sealed app client and the existing gated App
// runtime primitives. The code surface is vocabulary and composition only; it
// cannot mint authority or choose an App instance.

import { codeClientMethod, codeClientMethods } from './capability-manifest.js';

const SAFE_ACTION = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_PARAMS_CHARS = 20_000;

export class AppApiError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'AppApiError';
  }
}

const APP_METHODS = Object.freeze({
  observe: Object.freeze({
    tool: 'app_observe',
    toArgs: () => ({}),
  }),
  act: Object.freeze({
    tool: 'app_act',
    toArgs: (/** @type {Record<string, any>} */ args) => {
      if (typeof args.action !== 'string' || !SAFE_ACTION.test(args.action)) {
        throw new AppApiError('app.act(action, params): action must match /^[a-z][a-z0-9-]{0,63}$/');
      }
      const params = args.params == null ? {} : args.params;
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw new AppApiError('app.act(action, params): params must be an object');
      }
      let encoded;
      try { encoded = JSON.stringify(params); }
      catch { throw new AppApiError('app.act(action, params): params must be JSON-serializable'); }
      if (encoded.length > MAX_PARAMS_CHARS) {
        throw new AppApiError(`app.act(action, params): params exceed ${MAX_PARAMS_CHARS} characters`);
      }
      return { action: args.action, params };
    },
  }),
});

export const APP_API_METHODS = Object.freeze(codeClientMethods('app')
  .filter((method) => typeof codeClientMethod('app', method)?.tool === 'string'));

/** @param {{method?: unknown,args?: unknown}} call */
export const appCallToToolCall = (call) => {
  const method = typeof call?.method === 'string' ? call.method : '';
  const spec = /** @type {Record<string, {tool:string,toArgs:(args:Record<string,any>)=>Record<string,any>}>} */ (APP_METHODS)[method];
  const declared = codeClientMethod('app', method);
  if (!spec || !declared || declared.tool !== spec.tool) {
    throw new AppApiError(`unknown app method: ${String(call?.method)}`);
  }
  const args = call?.args && typeof call.args === 'object' && !Array.isArray(call.args)
    ? /** @type {Record<string, any>} */ (call.args)
    : {};
  return { name: spec.tool, args: spec.toArgs(args) };
};

/** @param {string} method @param {{ok?:boolean,error?:string,structured?:Record<string,any>}} result */
export const shapeAppResult = (method, result) => {
  if (!APP_API_METHODS.includes(method)) throw new AppApiError(`unknown app method: ${method}`);
  if (result?.ok !== true) throw new AppApiError(result?.error ?? `app.${method} failed`);
  return result.structured?.value ?? null;
};
