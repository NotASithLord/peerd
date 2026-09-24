// @ts-check
// Human-facing custody rules for Options-page mutations. Browser message
// rejection has crossed dispatch but carries no receipt, so it is never safe to
// describe as an ordinary retry. Stable validation codes may be mapped to
// bounded copy; every unknown/raw code falls back without being rendered.

/** @param {unknown} value */
export const isUnknownMutationOutcome = (value) =>
  value != null && typeof value === 'object'
    && /** @type {{outcomeKnown?:unknown}} */ (value).outcomeKnown === false;

/** @param {string} action */
export const unknownMutationCopy = (action) =>
  `Peerd could not confirm whether ${action} finished. Refresh this page to reconcile before trying again.`;

/**
 * @param {unknown} reply
 * @param {{action:string,fallback:string,messages?:Record<string,string>}} options
 */
export const mutationFailureCopy = (reply, { action, fallback, messages = {} }) => {
  if (isUnknownMutationOutcome(reply)) return unknownMutationCopy(action);
  const code = typeof /** @type {{error?:unknown}} */ (reply)?.error === 'string'
    ? /** @type {{error:string}} */ (reply).error : '';
  return messages[code] ?? fallback;
};
