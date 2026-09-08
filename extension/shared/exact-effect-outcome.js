// @ts-check

const RISK_CLASSES = new Set(['read', 'control', 'commit', 'resource']);

/**
 * Loss before dispatch is replayable. Once a host operation starts, only a
 * read is intrinsically replayable; "control" includes real mutations such as
 * cancellation and default selection and therefore cannot imply no effect.
 * @param {unknown} riskClass
 * @param {'before'|'during'|'after'} phase
 */
export const exactEffectLossSemantics = (riskClass, phase) => {
  if (typeof riskClass !== 'string' || !RISK_CLASSES.has(riskClass)
      || !['before', 'during', 'after'].includes(phase)) {
    throw new TypeError('exact-effect-loss-semantics-invalid');
  }
  const replayable = phase === 'before' || riskClass === 'read';
  return Object.freeze({
    outcomeKnown: phase !== 'during' || replayable,
    retryable: replayable,
  });
};

/**
 * Validate an outcome explicitly supplied by one exact authority operation.
 * Fulfillment alone is deliberately not evidence that an effect happened.
 * @param {unknown} value
 * @returns {'performed'|'not-performed'|'unknown'}
 */
export const normalizeExactEffectOutcome = (value) =>
  value === 'performed' || value === 'not-performed' ? value : 'unknown';
