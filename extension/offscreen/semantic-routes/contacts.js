// @ts-check

import { makeContactsRoutes } from '../../background/routes/contacts.js';
import { mergeContacts } from '/peerd-runtime/contacts/aggregate.js';

/** @param {string} route @param {any} message
 * @param {{kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} options */
export const dispatchContactSemanticRoute = async (route, message, options) => {
  if (!['contacts/set', 'contacts/forget'].includes(route)
      || typeof options.kernelCall !== 'function') {
    return { ok: false, code: 'semantic-contact-route-refused', outcomeKnown: true };
  }
  const call = options.kernelCall;
  const value = async (/** @type {string} */ operation, /** @type {unknown} */ payload = {}) => {
    const result = await call(operation, payload);
    if (result?.ok !== true) throw new Error(result?.code ?? 'contact-kernel-operation-failed');
    return result.value;
  };
  const routes = makeContactsRoutes({
    vault: { isLocked: () => false },
    contacts: {
      upsert: (/** @type {string} */ did, /** @type {unknown} */ patch) =>
        value('semantic.contacts.upsert', { did, patch }),
      remove: (/** @type {string} */ did) =>
        value('semantic.contacts.remove', { did }),
    },
    auditLog: {}, appRegistry: {},
    mergeContacts,
  });
  return routes[route](message);
};
