// @ts-check
// Lazy, sealed contact projection cluster. Contact/audit/App storage remains in
// the authority kernel through exact route-bound reverse calls.

import { makeContactsRoutes } from '../../background/routes/contacts.js';
import { mergeContacts } from '/peerd-runtime/contacts/aggregate.js';

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
export const dispatchContactsSemanticRoute = async (route, message, options) => {
  const { kernelCall } = options;
  if (typeof kernelCall !== 'function') {
    return { ok: false, code: 'semantic-kernel-call-unavailable', outcomeKnown: true };
  }
  const routes = makeContactsRoutes({
    vault: { isLocked: () => false },
    auditLog: { list: () => unwrap(kernelCall('semantic.contacts.list-audit', {})) },
    contacts: {
      list: () => unwrap(kernelCall('semantic.contacts.list-saved', {})),
      upsert: (/** @type {string} */ did, /** @type {Record<string, unknown>} */ patch) =>
        unwrap(kernelCall('semantic.contacts.upsert', { did, patch })),
      remove: (/** @type {string} */ did) =>
        unwrap(kernelCall('semantic.contacts.remove', { did })),
    },
    appRegistry: { list: () => unwrap(kernelCall('semantic.contacts.list-apps', {})) },
    mergeContacts,
  });
  const handler = routes[route];
  if (typeof handler !== 'function') {
    return { ok: false, code: 'semantic-contacts-route-refused', outcomeKnown: true };
  }
  return handler(message);
};
