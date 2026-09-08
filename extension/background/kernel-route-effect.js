// @ts-check

/** @param {string} code */
export const kernelUnknownOutcome = (code) => ({
  ok: false,
  error: 'The operation outcome could not be confirmed.',
  code,
  outcomeKnown: false,
  outcomeKind: 'unknown',
  retryable: false,
});

export const makeKernelEffectState = () => ({
  refusal: /** @type {unknown|null} */ (null), lost: false, completed: false,
});

/** @param {Function} effect @param {ReturnType<typeof makeKernelEffectState>} state
 * @param {(()=>void)|null} canWrite @param {(cause:unknown)=>boolean} [knownFailure] */
export const trackKernelEffect = (effect, state, canWrite, knownFailure = () => false) =>
  async (/** @type {any[]} */ ...args) => {
    try { canWrite?.(); }
    catch (cause) { state.refusal = cause; throw cause; }
    try {
      const result = await effect(...args);
      state.completed = true;
      return result;
    } catch (cause) {
      if (!knownFailure(cause)) state.lost = true;
      throw cause;
    }
  };

/** @param {()=>Promise<any>} run @param {ReturnType<typeof makeKernelEffectState>} state
 * @param {string} code @param {boolean} [unknownAfterCompletedFailure] */
export const settleKernelEffect = async (
  run, state, code, unknownAfterCompletedFailure = false,
) => {
  try {
    const result = await run();
    if (state.refusal && !state.completed && !state.lost) throw state.refusal;
    return state.lost || state.refusal && state.completed
      || unknownAfterCompletedFailure && state.completed && result?.ok === false
      ? kernelUnknownOutcome(code) : result;
  } catch (cause) {
    if (state.refusal && !state.completed && !state.lost) throw state.refusal;
    if (state.lost || state.refusal && state.completed
        || unknownAfterCompletedFailure && state.completed) {
      return kernelUnknownOutcome(code);
    }
    throw cause;
  }
};
