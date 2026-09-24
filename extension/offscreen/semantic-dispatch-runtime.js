// @ts-check

import {
  compileSemanticHostRouteManifest,
  parseSemanticDispatchAuthority,
  parseSemanticDispatchRequest,
  semanticDispatchResultFits,
} from '../shared/semantic-dispatch-contract.js';

const refusal = (/** @type {string} */ code) => Object.freeze({
  ok: false, code, outcomeKnown: true,
});

/**
 * @typedef {(message: Record<string, unknown>, options: {
 *   signal: AbortSignal,
 *   authority: NonNullable<ReturnType<typeof parseSemanticDispatchAuthority>>,
 *   deadlineAt?: number,
 *   kernelCall?: (operation:string, payload:unknown) => Promise<any>,
 * }) => Promise<unknown>|unknown} SemanticRouteHandler
 */

/**
 * @param {Object} options
 * @param {unknown} options.manifest
 * @param {Record<string, SemanticRouteHandler>|Map<string, SemanticRouteHandler>} options.handlers
 * @param {() => number} [options.now]
 */
export const createSemanticDispatchRuntime = ({ manifest, handlers, now = Date.now }) => {
  const table = compileSemanticHostRouteManifest(manifest);
  const entries = handlers instanceof Map ? [...handlers.entries()] : Object.entries(handlers ?? {});
  /** @type {Map<string, SemanticRouteHandler>} */
  const registry = new Map();
  for (const [route, handler] of entries) {
    if (registry.has(route)) throw new TypeError('semantic-handler-duplicate');
    const row = table.get(route);
    if (!row) {
      throw new TypeError(`semantic-handler-route-not-admitted:${route}`);
    }
    if (typeof handler !== 'function') throw new TypeError(`semantic-handler-invalid:${route}`);
    registry.set(route, handler);
  }
  for (const row of table.values()) if (!registry.has(row.route)) {
    throw new TypeError(`semantic-handler-missing:${row.route}`);
  }

  return Object.freeze({
    routes: Object.freeze([...registry.keys()].sort()),
    /**
     * @param {unknown} payload
     * @param {{signal:AbortSignal,authority?:unknown,deadlineAt?:number,
     * kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} options
     */
    dispatch: async (payload, options) => {
      const request = parseSemanticDispatchRequest(payload);
      if (!request) return refusal('semantic-dispatch-request-invalid');
      const authority = parseSemanticDispatchAuthority(options?.authority);
      if (!authority) return refusal('semantic-dispatch-authority-invalid');
      if (!options?.signal || typeof options.signal.aborted !== 'boolean') {
        return refusal('semantic-dispatch-signal-invalid');
      }
      const row = table.get(request.route);
      if (!row) return refusal('semantic-dispatch-route-unknown');
      const handler = registry.get(request.route);
      if (!handler) return refusal('semantic-dispatch-handler-unavailable');
      if (options.signal.aborted) return refusal('semantic-dispatch-aborted');
      if (options.deadlineAt !== undefined
          && (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= now())) {
        return refusal('semantic-dispatch-deadline-expired');
      }
      try {
        const result = await handler(request.message, {
          signal: options.signal,
          authority,
          deadlineAt: options.deadlineAt,
          kernelCall: options.kernelCall,
        });
        if (!semanticDispatchResultFits(result)) {
          return { ok: false, code: 'semantic-dispatch-result-invalid', outcomeKnown: false };
        }
        return result;
      } catch (cause) {
        void cause;
        return {
          ok: false,
          code: 'semantic-dispatch-handler-failed',
          // The handler crossed the semantic boundary and may have committed.
          outcomeKnown: false,
        };
      }
    },
  });
};
