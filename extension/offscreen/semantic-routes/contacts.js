// @ts-check

/** @param {string} code @param {string} action */
const unknown = (code, action) => ({
  ok: false,
  error: `Peerd could not confirm whether ${action} finished. Refresh to reconcile before trying again.`,
  code,
  outcomeKnown: false,
  outcomeKind: 'unknown',
  retryable: false,
});

/** @param {string} route @param {any} message
 * @param {{kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} options */
export const dispatchContactSemanticRoute = async (route, message, options) => {
  if (!['contacts/set', 'contacts/forget'].includes(route)
      || typeof options.kernelCall !== 'function') {
    return { ok: false, code: 'semantic-contact-route-refused', outcomeKnown: true };
  }
  if (typeof message?.did !== 'string') return { ok: false, error: 'did-required' };
  if (route === 'contacts/forget') {
    try {
      const result = await options.kernelCall('semantic.contacts.remove', { did: message.did });
      if (result?.ok === true) {
        return result.value ? { ok: true } : { ok: false, error: 'contact-not-found' };
      }
    } catch {
      // The exact authority response was lost, so deletion cannot be retried safely.
    }
    return unknown('contact-forget-outcome-unknown', 'forgetting the contact');
  }
  /** @type {Record<string, unknown>} */
  const patch = {};
  for (const key of ['name', 'notes', 'tags', 'favorite']) {
    if (message[key] !== undefined) patch[key] = message[key];
  }
  try {
    const result = await options.kernelCall('semantic.contacts.upsert', {
      did: message.did, patch,
    });
    if (result?.ok === true) return { ok: true, contact: result.value };
  } catch {
    // The exact authority response was lost, so mutation cannot be retried safely.
  }
  return unknown('contact-set-outcome-unknown', 'the contact update');
};
