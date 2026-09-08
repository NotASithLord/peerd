// @ts-check

// why: main and actor semantic owners must not assign different custody to the
// same local exception. A failure before any exact authority request is known;
// once an effect request started, only an explicit host stamp can prove it.

/**
 * @param {unknown} cause
 * @param {{effectCount?:number}} [state]
 * @returns {{error:string,code?:string,outcomeKnown:boolean,retryable:boolean}}
 */
export const normalizeSemanticToolFailure = (cause, { effectCount = 0 } = {}) => {
  const failure = /** @type {{message?:string,code?:string,outcomeKnown?:boolean,retryable?:boolean}} */ (cause);
  const outcomeKnown = failure?.outcomeKnown === true
    || (failure?.outcomeKnown !== false && effectCount === 0);
  return {
    error: failure?.message ?? String(cause),
    ...(typeof failure?.code === 'string' ? { code: failure.code } : {}),
    outcomeKnown,
    retryable: outcomeKnown && failure?.retryable !== false,
  };
};
