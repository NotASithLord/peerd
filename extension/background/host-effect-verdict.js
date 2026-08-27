// @ts-check

// why: Promise fulfillment only proves that an exact authority RPC returned.
// Each named handler chooses the result contract that proves whether its own
// mutation/resource effect happened; ambiguous shapes remain unknown.
const rejected = (/** @type {unknown} */ cause) => {
  const detail = /** @type {{performed?:boolean,outcomeKnown?:boolean}} */ (cause);
  if (detail?.performed === true) return 'performed';
  return detail?.outcomeKnown === true ? 'not-performed' : 'unknown';
};

export const HOST_EFFECT_OUTCOME = Object.freeze({
  okResult: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value?.ok === true
        ? 'performed' : value?.ok === false ? 'not-performed' : 'unknown',
    rejected,
  }),
  fulfilledResult: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value?.ok === false ? 'not-performed' : 'performed',
    rejected,
  }),
  valueResult: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value === null || value === false ? 'not-performed' : 'performed',
    rejected,
  }),
  runResult: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value?.ok === false || value?.refusal || value?.refused === true
        || value?.aborted === true ? 'not-performed' : 'performed',
    rejected,
  }),
  memoryResult: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value?.ok === false
      || value?.rejected === true || value?.op === 'noop'
      ? 'not-performed' : value?.ok === true || typeof value?.op === 'string'
        ? 'performed' : 'unknown',
    rejected,
  }),
  actorResult: Object.freeze({
    fulfilled: (/** @type {any} */ value) => value?.outcomeKnown === false
      ? 'unknown' : value === null || value === false || value?.ok === false
        || value?.refused === true ? 'not-performed' : 'performed',
    rejected,
  }),
  confirmation: Object.freeze({
    fulfilled: () => 'not-performed', rejected: () => 'not-performed',
  }),
});
