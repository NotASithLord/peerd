// @ts-check
// Retry classification (Class A–F) + the recovery decision.
//
// Every tool and engine action carries one retry class; after an
// interruption, `decideRecovery` is the single pure function that turns
// (class, how far the dispatch got, any evidence, whether the user asked to
// cancel) into the operation's terminal state and what peerd may do next.
//
// The two guarantees this file carries:
//   1. a non-idempotent action (Class E) is NEVER retried automatically
//      after peerd loses proof of its result — it lands in outcome_unknown
//      with verification required;
//   2. explicit user cancellation dominates concurrent recovery — a
//      cancel-requested operation never resumes, and is only reported
//      `cancelled` when the irreversible effect provably did not happen.
//
// Functional core, no IO, no clock.

import {
  OPERATION_STATES, provesCompletion, provesFailure,
} from './operation-state.js';

/**
 * @typedef {'A' | 'B' | 'C' | 'D' | 'E' | 'F'} RetryClass
 *
 *   A  pure read            — retry freely; duplicates are invisible
 *   B  costed read          — retry needs budget + a new attempt number +
 *                             fresh (non-expired) credentials
 *   C  idempotent write     — retry with the SAME idempotency key
 *   D  conditionally        — verify external state (or ask the user)
 *      idempotent action      before retrying; keep the original key
 *   E  non-idempotent       — never auto-retry; unproven completion is
 *      side effect            outcome_unknown
 *   F  long-lived resource  — recreate, never continue; grants re-derived
 */
export const RETRY_CLASSES = Object.freeze({
  PURE_READ: /** @type {const} */ ('A'),
  COSTED_READ: /** @type {const} */ ('B'),
  IDEMPOTENT_WRITE: /** @type {const} */ ('C'),
  CONDITIONAL_ACTION: /** @type {const} */ ('D'),
  SIDE_EFFECT: /** @type {const} */ ('E'),
  RESOURCE: /** @type {const} */ ('F'),
});

const VALID_CLASSES = Object.freeze(new Set(Object.values(RETRY_CLASSES)));

/** @param {unknown} v @returns {v is RetryClass} */
export const isRetryClass = (v) =>
  typeof v === 'string' && VALID_CLASSES.has(/** @type {RetryClass} */ (v));

/**
 * Coerce a stored/declared retry class. Garbage or missing → Class E:
 * an UNCLASSIFIED action must be treated as a non-idempotent side effect,
 * because guessing "safe to retry" is exactly the unsafe-replay failure
 * the contract forbids. Fail closed.
 * @param {unknown} v @returns {RetryClass}
 */
export const normalizeRetryClass = (v) =>
  isRetryClass(v) ? v : RETRY_CLASSES.SIDE_EFFECT;

/**
 * What the recovery decision needs to know about how far a call got.
 *
 * @typedef {Object} RecoveryInput
 * @property {unknown} retryClass          normalized via normalizeRetryClass
 * @property {boolean} [dispatched]        the request/effect left peerd
 * @property {{ kind?: unknown }} [evidence]  positive completion/failure
 *                                         evidence, if any arrived
 * @property {boolean} [cancelRequested]   the user explicitly cancelled
 * @property {boolean} [budgetRemaining]   Class B: may a retry spend at all
 */

/**
 * @typedef {Object} RecoveryVerdict
 * @property {import('./operation-state.js').OperationState} state
 * @property {boolean} autoRetry           peerd may retry with no human in
 *                                         the loop (fresh attempt number)
 * @property {string[]} retryRequires      preconditions for ANY retry beyond
 *                                         autoRetry ('budget',
 *                                         'fresh-credentials',
 *                                         'external-verification',
 *                                         'user-instruction', …)
 * @property {boolean} keepIdempotencyKey  C/D: a retry MUST reuse the
 *                                         original key, never mint a new one
 * @property {boolean} verificationRequired  the target must be checked
 *                                         before any repeat
 * @property {boolean} recreateResource    F: the resource may be recreated
 *                                         (continuation is NOT implied)
 * @property {string} reason               human-readable; rendered in
 *                                         lineage/audit
 */

/** @param {Partial<RecoveryVerdict> & { state: RecoveryVerdict['state'], reason: string }} v
 *  @returns {RecoveryVerdict} */
const verdict = (v) => ({
  autoRetry: false,
  retryRequires: [],
  keepIdempotencyKey: false,
  verificationRequired: false,
  recreateResource: false,
  ...v,
});

/**
 * The recovery decision. Evidence outranks everything except its own
 * absence; explicit cancellation outranks recovery; the retry class decides
 * the rest.
 *
 * @param {RecoveryInput} input
 * @returns {RecoveryVerdict}
 */
export const decideRecovery = (input) => {
  const retryClass = normalizeRetryClass(input?.retryClass);
  const dispatched = input?.dispatched === true;
  const cancelRequested = input?.cancelRequested === true;
  const kind = input?.evidence?.kind;

  // Positive evidence settles the operation regardless of class or cancel:
  // a landed effect is completed even if the user pressed Stop after the
  // fact — reporting it cancelled would hide a real external change.
  if (provesCompletion(kind)) {
    return verdict({
      state: OPERATION_STATES.COMPLETED,
      reason: `positive completion evidence (${String(kind)})`,
    });
  }
  if (provesFailure(kind)) {
    // Proven not-to-have-happened + an explicit cancel is a clean cancel;
    // without the cancel it is an honest failure.
    return cancelRequested
      ? verdict({
        state: OPERATION_STATES.CANCELLED,
        reason: 'cancelled; effect positively did not occur',
      })
      : verdict({
        state: OPERATION_STATES.FAILED,
        reason: `positive failure evidence (${String(kind)})`,
      });
  }

  // No positive evidence from here on.

  if (cancelRequested) {
    if (!dispatched) {
      // Cancel won the race outright: nothing left peerd.
      return verdict({
        state: OPERATION_STATES.CANCELLED,
        reason: 'cancelled before dispatch; no external effect attempted',
      });
    }
    // Dispatched, unacknowledged, cancel requested. For classes whose
    // duplicate execution is invisible or idempotent the honest state is
    // still `cancelled` (the effect, if it landed, is harmless to ignore or
    // repeat). For D/E the effect may have landed and matters:
    // outcome_unknown, with the cancel recorded in the reason.
    if (retryClass === RETRY_CLASSES.CONDITIONAL_ACTION
        || retryClass === RETRY_CLASSES.SIDE_EFFECT) {
      return verdict({
        state: OPERATION_STATES.OUTCOME_UNKNOWN,
        verificationRequired: true,
        keepIdempotencyKey: retryClass === RETRY_CLASSES.CONDITIONAL_ACTION,
        retryRequires: ['external-verification', 'user-instruction'],
        reason: 'cancel requested after dispatch; the effect may have landed '
          + '— verify before treating it as cancelled',
      });
    }
    if (retryClass === RETRY_CLASSES.RESOURCE) {
      return verdict({
        state: OPERATION_STATES.CANCELLED,
        reason: 'cancelled; any partially created resource is settled by orphan reaping',
      });
    }
    return verdict({
      state: OPERATION_STATES.CANCELLED,
      reason: 'cancelled; any in-flight effect is idempotent or invisible',
    });
  }

  switch (retryClass) {
    case RETRY_CLASSES.PURE_READ:
      return verdict({
        state: OPERATION_STATES.INTERRUPTED,
        autoRetry: true,
        reason: 'pure read; duplicate execution has no observable effect',
      });

    case RETRY_CLASSES.COSTED_READ: {
      const hasBudget = input?.budgetRemaining !== false;
      return verdict({
        state: OPERATION_STATES.INTERRUPTED,
        autoRetry: hasBudget,
        retryRequires: hasBudget
          ? ['new-attempt', 'fresh-credentials']
          : ['budget', 'new-attempt', 'fresh-credentials'],
        reason: hasBudget
          ? 'repeatable read; retry as a new attempt within budget'
          : 'repeatable read; budget exhausted — retry needs user budget approval',
      });
    }

    case RETRY_CLASSES.IDEMPOTENT_WRITE:
      return verdict({
        state: OPERATION_STATES.INTERRUPTED,
        autoRetry: true,
        keepIdempotencyKey: true,
        reason: 'idempotent write; retry with the SAME idempotency key',
      });

    case RETRY_CLASSES.CONDITIONAL_ACTION:
      if (!dispatched) {
        return verdict({
          state: OPERATION_STATES.INTERRUPTED,
          autoRetry: true,
          keepIdempotencyKey: true,
          reason: 'conditionally idempotent action; never dispatched, retry '
            + 'with the original key',
        });
      }
      return verdict({
        state: OPERATION_STATES.OUTCOME_UNKNOWN,
        verificationRequired: true,
        keepIdempotencyKey: true,
        retryRequires: ['external-verification'],
        reason: 'dispatched without acknowledgement; check the external state '
          + '(original idempotency key retained) before retrying',
      });

    case RETRY_CLASSES.SIDE_EFFECT:
      if (!dispatched) {
        // Interrupted before any external change: safe, but STILL not
        // auto-retried — Class E repeats only on explicit instruction.
        return verdict({
          state: OPERATION_STATES.INTERRUPTED,
          retryRequires: ['user-instruction'],
          reason: 'non-idempotent side effect interrupted before dispatch; '
            + 'safe to retry on explicit instruction only',
        });
      }
      return verdict({
        state: OPERATION_STATES.OUTCOME_UNKNOWN,
        verificationRequired: true,
        retryRequires: ['external-verification', 'user-instruction'],
        reason: 'non-idempotent side effect dispatched without proof of '
          + 'result; may have completed — verify before repeating',
      });

    case RETRY_CLASSES.RESOURCE:
    default:
      return verdict({
        state: OPERATION_STATES.INTERRUPTED,
        recreateResource: true,
        retryRequires: ['rederive-grants'],
        reason: 'long-lived resource lost; recreate from durable records — '
          + 'continuation is not implied and grants are re-derived',
      });
  }
};
