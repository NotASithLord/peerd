// @ts-check
// Lazy, sealed toolbox cluster. Durable bodies and run records remain kernel IO.

import { makeToolboxRoutes } from '../../background/routes/toolbox.js';

const unwrap = async (/** @type {Promise<any>} */ promise) => {
  const result = await promise;
  if (result?.ok === true) return result.value;
  throw new Error(result?.error ?? result?.code ?? 'semantic kernel operation failed');
};

/**
 * @param {string} route
 * @param {any} message
 * @param {{kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} options
 */
export const dispatchToolboxSemanticRoute = async (route, message, options) => {
  const { kernelCall } = options;
  if (typeof kernelCall !== 'function') {
    return { ok: false, code: 'semantic-kernel-call-unavailable', outcomeKnown: true };
  }
  const routes = makeToolboxRoutes({
    toolboxStore: {
      getBody: (/** @type {any} */ name) => unwrap(kernelCall('semantic.toolbox.get-body', { name })),
      recordRuns: (/** @type {any[]} */ names, /** @type {any} */ result) =>
        unwrap(kernelCall('semantic.toolbox.record-runs', { names, ok: result?.ok === true })),
    },
  });
  const handler = routes[route];
  if (typeof handler !== 'function') {
    return { ok: false, code: 'semantic-toolbox-route-refused', outcomeKnown: true };
  }
  return handler(message);
};
