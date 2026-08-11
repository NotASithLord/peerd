// @ts-check
// Typed failure outcomes — deterministic recovery classification.
//
// The settle path's string heuristics (transport regexes, the observability
// taxonomy) exist because most failures arrive as bare strings. This module
// is the typed protocol that OUTRANKS them: a throw site that knows what
// happened stamps `outcomeKind` on the error (or a tool returns it on its
// result), and the recovery decision becomes a table lookup instead of a
// pattern match. Adoption is incremental — an unstamped failure still takes
// the heuristic path — but every stamped site is one less guess.
//
// The four kinds mirror the contract's evidence semantics:
//   transport-lost       the wire died with the request possibly delivered
//                        (ambiguous for a side effect, never `failed`)
//   host-lost            the execution host (worker, engine tab, message
//                        port) died mid-work (equally ambiguous)
//   pre-effect-failure   the action was refused BEFORE any effect — the one
//                        shape that is positive failure evidence
//   effect-completed     the effect is known to have completed, but a later
//                        policy check refused any further authority
//
// why plain string kinds + an own-property marker rather than instanceof:
// errors cross realm and relay boundaries (offscreen worker → SW) where
// prototypes don't survive; a string field does. The classes below are for
// runtime-side throw sites; layers below peerd-runtime (egress, engines)
// stamp the field on their own error types without importing anything.

/**
 * @typedef {'transport-lost' | 'host-lost' | 'pre-effect-failure' | 'effect-completed'} FailureOutcomeKind
 */

export const FAILURE_OUTCOMES = Object.freeze({
  TRANSPORT_LOST: /** @type {const} */ ('transport-lost'),
  HOST_LOST: /** @type {const} */ ('host-lost'),
  PRE_EFFECT_FAILURE: /** @type {const} */ ('pre-effect-failure'),
  EFFECT_COMPLETED: /** @type {const} */ ('effect-completed'),
});

const VALID_OUTCOME_KINDS = Object.freeze(new Set(Object.values(FAILURE_OUTCOMES)));

/** @param {unknown} v @returns {v is FailureOutcomeKind} */
export const isFailureOutcomeKind = (v) =>
  typeof v === 'string' && VALID_OUTCOME_KINDS.has(/** @type {any} */ (v));

/**
 * Read a stamped outcome kind off a thrown error or a tool result.
 * Unknown/missing → undefined (heuristics take over). Fail closed against
 * garbage: only the known kinds pass.
 * @param {unknown} carrier
 * @returns {FailureOutcomeKind | undefined}
 */
export const outcomeKindOf = (carrier) => {
  const kind = /** @type {{ outcomeKind?: unknown }} */ (carrier)?.outcomeKind;
  return isFailureOutcomeKind(kind) ? kind : undefined;
};

export class TransportLostError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'TransportLostError';
    this.outcomeKind = FAILURE_OUTCOMES.TRANSPORT_LOST;
  }
}

export class ExecutionHostLostError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ExecutionHostLostError';
    this.outcomeKind = FAILURE_OUTCOMES.HOST_LOST;
  }
}

export class PreEffectFailureError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PreEffectFailureError';
    this.outcomeKind = FAILURE_OUTCOMES.PRE_EFFECT_FAILURE;
  }
}
