// @ts-check
// Canonical operation states — the lifecycle contract's state vocabulary.
//
// Every operation that can outlive one synchronous call carries exactly one
// of these states. The contract's core guarantee lives here: peerd never
// silently reports an uncertain side effect as definitely failed or
// definitely completed. `outcome_unknown` is a real terminal state with its
// own resolution rules — it can only leave via positive evidence, never by
// an automatic timeout-to-failed conversion.
//
// Functional core: values in, verdicts out. No IO, no clock. The imperative
// shells (SW dispatcher, operation log, reconciler) enforce these tables at
// every transition.

/**
 * @typedef {'created' | 'queued' | 'running' | 'awaiting_user'
 *   | 'awaiting_remote' | 'cancelling' | 'completed' | 'failed'
 *   | 'cancelled' | 'interrupted' | 'outcome_unknown'} OperationState
 */

export const OPERATION_STATES = Object.freeze({
  CREATED: /** @type {const} */ ('created'),
  QUEUED: /** @type {const} */ ('queued'),
  RUNNING: /** @type {const} */ ('running'),
  AWAITING_USER: /** @type {const} */ ('awaiting_user'),
  AWAITING_REMOTE: /** @type {const} */ ('awaiting_remote'),
  CANCELLING: /** @type {const} */ ('cancelling'),
  COMPLETED: /** @type {const} */ ('completed'),
  FAILED: /** @type {const} */ ('failed'),
  CANCELLED: /** @type {const} */ ('cancelled'),
  INTERRUPTED: /** @type {const} */ ('interrupted'),
  OUTCOME_UNKNOWN: /** @type {const} */ ('outcome_unknown'),
});

// Terminal states — nothing moves OUT of these through the transition
// table. The two sanctioned exits live elsewhere and are deliberate:
// resolveUnknownOutcome (below) settles outcome_unknown on positive
// evidence, and the operation log's newAttempt re-queues an `interrupted`
// record with an incremented attempt number (contract §4 Class B: "the
// retry must receive a new operation attempt number"). why: free-form
// rewinds would erase the evidence trail the contract exists to preserve.
export const TERMINAL_STATES = Object.freeze(
  /** @type {ReadonlySet<OperationState>} */ (new Set([
  OPERATION_STATES.COMPLETED,
  OPERATION_STATES.FAILED,
  OPERATION_STATES.CANCELLED,
  OPERATION_STATES.INTERRUPTED,
  OPERATION_STATES.OUTCOME_UNKNOWN,
])));

/** @param {unknown} state */
export const isTerminal = (state) =>
  isOperationState(state) && TERMINAL_STATES.has(state);

/** @param {unknown} v @returns {v is OperationState} */
export const isOperationState = (v) =>
  typeof v === 'string' && Object.values(OPERATION_STATES).includes(
    /** @type {OperationState} */ (v),
  );

// The legality table. Keys are source states; values are the states a
// running system may move them to. Terminal states are absent on purpose —
// nothing transitions OUT of a terminal state through this table.
// `outcome_unknown` resolution is the ONE sanctioned exception and goes
// through resolveUnknownOutcome below, which demands positive evidence.
/** @type {Readonly<Record<string, ReadonlySet<OperationState>>>} */
const TRANSITIONS = Object.freeze({
  [OPERATION_STATES.CREATED]: new Set([
    OPERATION_STATES.QUEUED, OPERATION_STATES.RUNNING,
    OPERATION_STATES.CANCELLED, OPERATION_STATES.FAILED,
    OPERATION_STATES.INTERRUPTED,
  ]),
  [OPERATION_STATES.QUEUED]: new Set([
    OPERATION_STATES.RUNNING, OPERATION_STATES.CANCELLED,
    OPERATION_STATES.FAILED, OPERATION_STATES.INTERRUPTED,
  ]),
  [OPERATION_STATES.RUNNING]: new Set([
    OPERATION_STATES.AWAITING_USER, OPERATION_STATES.AWAITING_REMOTE,
    OPERATION_STATES.CANCELLING, OPERATION_STATES.COMPLETED,
    OPERATION_STATES.FAILED, OPERATION_STATES.CANCELLED,
    OPERATION_STATES.INTERRUPTED, OPERATION_STATES.OUTCOME_UNKNOWN,
  ]),
  // awaiting_user cannot reach outcome_unknown: while an operation waits on
  // the user no side effect is in flight, so an interruption there is always
  // the safe `interrupted` (and the pending confirmation dies with it).
  [OPERATION_STATES.AWAITING_USER]: new Set([
    OPERATION_STATES.RUNNING, OPERATION_STATES.CANCELLING,
    OPERATION_STATES.CANCELLED, OPERATION_STATES.FAILED,
    OPERATION_STATES.INTERRUPTED,
  ]),
  [OPERATION_STATES.AWAITING_REMOTE]: new Set([
    OPERATION_STATES.RUNNING, OPERATION_STATES.CANCELLING,
    OPERATION_STATES.COMPLETED, OPERATION_STATES.FAILED,
    OPERATION_STATES.INTERRUPTED, OPERATION_STATES.OUTCOME_UNKNOWN,
  ]),
  // cancelling → completed stays legal: a side effect can land between the
  // user's Stop and the wire actually closing. Reporting it completed is
  // truthful; reporting cancelled would hide a landed effect.
  [OPERATION_STATES.CANCELLING]: new Set([
    OPERATION_STATES.CANCELLED, OPERATION_STATES.COMPLETED,
    OPERATION_STATES.FAILED, OPERATION_STATES.OUTCOME_UNKNOWN,
  ]),
});

/**
 * May a live operation move `from` → `to`? Pure table lookup; unknown
 * states are never movable (fail closed).
 * @param {unknown} from @param {unknown} to
 */
export const canTransition = (from, to) => {
  if (!isOperationState(from) || !isOperationState(to)) return false;
  const allowed = TRANSITIONS[from];
  return allowed ? allowed.has(to) : false;
};

export class IllegalTransitionError extends Error {
  /** @param {unknown} from @param {unknown} to */
  constructor(from, to) {
    super(`illegal operation-state transition: ${String(from)} -> ${String(to)}`);
    this.name = 'IllegalTransitionError';
  }
}

/** @param {unknown} from @param {unknown} to @returns {OperationState} */
export const assertTransition = (from, to) => {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return /** @type {OperationState} */ (to);
};

// --- Completion evidence ---------------------------------------------------
//
// `completed` and `failed` both require POSITIVE evidence (contract §3.1).
// A timeout or dropped connection is not evidence of anything when a side
// effect may already have occurred — that ambiguity is exactly what
// `outcome_unknown` exists to name.

/**
 * Evidence kinds that positively prove COMPLETION of a side effect.
 * @typedef {'success-response' | 'verified-state' | 'idempotency-key-lookup'
 *   | 'durable-commit-check'} CompletionEvidence
 */
export const COMPLETION_EVIDENCE = Object.freeze(new Set([
  'success-response', 'verified-state', 'idempotency-key-lookup',
  'durable-commit-check',
]));

/**
 * Evidence kinds that positively prove the operation did NOT complete.
 * A definitive rejection before the effect (4xx validation refusal, a
 * verified absence at the target) qualifies; 'timeout' and
 * 'connection-lost' deliberately do not.
 * @typedef {'error-response-before-effect' | 'verified-absent'
 *   | 'user-verified-absent'} FailureEvidence
 */
export const FAILURE_EVIDENCE = Object.freeze(new Set([
  'error-response-before-effect', 'verified-absent', 'user-verified-absent',
]));

/** @param {unknown} kind */
export const provesCompletion = (kind) =>
  COMPLETION_EVIDENCE.has(/** @type {any} */ (kind));

/** @param {unknown} kind */
export const provesFailure = (kind) =>
  FAILURE_EVIDENCE.has(/** @type {any} */ (kind));

export class UnknownOutcomeUnresolvedError extends Error {
  /** @param {unknown} evidence */
  constructor(evidence) {
    super('outcome_unknown can only resolve on positive evidence; '
      + `got: ${String(evidence)}`);
    this.name = 'UnknownOutcomeUnresolvedError';
  }
}

/**
 * The ONLY way out of `outcome_unknown`: positive evidence gathered after
 * the fact (an external-state check, an idempotency-key lookup, or the
 * user's own verification). Anything else — including 'timeout',
 * 'connection-lost', undefined, or a plea of "probably failed" — throws.
 * There is deliberately no automatic path from outcome_unknown to failed.
 *
 * @param {{ kind?: unknown }} evidence
 * @returns {OperationState} completed or failed
 */
export const resolveUnknownOutcome = (evidence) => {
  const kind = evidence?.kind;
  if (provesCompletion(kind)) return OPERATION_STATES.COMPLETED;
  if (provesFailure(kind)) return OPERATION_STATES.FAILED;
  throw new UnknownOutcomeUnresolvedError(kind);
};
