// @ts-check
// Demand-loaded memory management surface. The sealed host owns no storage;
// every read or mutation is one exact Options-bound kernel operation.

const routes = Object.freeze({
  'memory/deleteAll': ['semantic.memory.delete-all', () => ({})],
  'memory/write': ['semantic.memory.write', (/** @type {any} */ message) => ({
    scope: message?.scope, body: message?.body,
  })],
  'memory/delete': ['semantic.memory.delete', (/** @type {any} */ message) => ({
    scope: message?.scope,
  })],
  'memory/suggestions': ['semantic.memory.suggestions', () => ({})],
  'memory/suggestions/approve': ['semantic.memory.approve', (/** @type {any} */ message) => ({
    id: message?.id,
  })],
  'memory/suggestions/dismiss': ['semantic.memory.dismiss', (/** @type {any} */ message) => ({
    id: message?.id,
  })],
});

/** @param {string} route @param {any} message
 * @param {{kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} options */
export const dispatchMemorySemanticRoute = async (route, message, options) => {
  const entry = /** @type {[string,(message:any)=>unknown]|undefined} */ (
    /** @type {Record<string,any>} */ (routes)[route]
  );
  if (!entry || typeof options.kernelCall !== 'function') {
    return { ok: false, code: 'semantic-memory-route-refused', outcomeKnown: true };
  }
  const result = await options.kernelCall(entry[0], entry[1](message));
  if (result?.ok === true) return result.value;
  return {
    ok: false,
    error: result?.outcomeKnown === true
      ? 'The memory operation could not be completed.'
      : 'The memory operation outcome could not be confirmed.',
    outcomeKnown: result?.outcomeKnown === true,
    retryable: result?.outcomeKnown === true,
  };
};
