// @ts-check
// The durable operation log — persist-before-report over injected storage.
//
// Every operation that can outlive one synchronous call gets a record here
// (contract §8): created before dispatch, dispatched marked before the
// effect leaves peerd, results persisted before success is reported to the
// agent. Storage is injected (the SW passes a chrome.storage.local
// adapter), mirroring the other runtime stores. State changes go through
// the operation-state legality table for live transitions, canRecoverySettle
// for reconcile verdicts, and resolveUnknownOutcome for evidence-gated
// resolution — the three sanctioned regimes, nothing free-form. Result
// metadata is digest-only and passes the audit sanitizer; full payloads and
// raw headers are never accepted by this API, so they have no path to disk
// through it.
//
// All mutations are serialized through an internal queue: begin/transition/
// settle each do load → mutate → persist, and two interleaved callers (a
// parallel tool batch, an actor relay racing the main turn) would otherwise
// silently lose the first write. The queue makes the read-modify-write
// atomic within this context; cross-context writers must share ONE log
// instance (the SW owns it).

import {
  OPERATION_STATES, assertTransition, isTerminal, canRecoverySettle,
  resolveUnknownOutcome,
} from './operation-state.js';
import { RETRY_CLASSES, normalizeRetryClass } from './retry-class.js';
import { sanitizeDetail } from './audit-events.js';

export const OPERATION_LOG_KEY = 'peerd.lifecycle.operations';

// Settled records kept for correlation before the oldest are pruned. why a
// cap: the log is a recovery + audit correlation surface, not history —
// unbounded growth would make the startup reconcile scan pay for every
// operation ever run. outcome_unknown records are EXEMPT from this cap
// (deleting one silently discards the uncertainty the contract exists to
// surface — they leave via resolveUnknown) but carry their own, larger
// bound below: a store that can grow without limit from attacker-
// influenceable error text is its own failure mode, so past that bound the
// OLDEST unknowns are dropped — a documented, bounded discard, not a
// silent one (and 200 unresolved unknowns already signals something far
// worse than log pressure).
export const OPERATION_LOG_MAX_TERMINAL = 500;
export const OPERATION_LOG_MAX_UNKNOWN = 200;

const PRUNABLE_STATES = Object.freeze(
  /** @type {ReadonlySet<import('./operation-state.js').OperationState>} */ (new Set([
    OPERATION_STATES.COMPLETED, OPERATION_STATES.FAILED,
    OPERATION_STATES.CANCELLED, OPERATION_STATES.INTERRUPTED,
  ])));

export class OperationNotFoundError extends Error {
  /** @param {string} operationId */
  constructor(operationId) {
    super(`no operation record: ${operationId}`);
    this.name = 'OperationNotFoundError';
  }
}

export class OperationExistsError extends Error {
  /** @param {string} operationId @param {string} state */
  constructor(operationId, state) {
    super(`operation ${operationId} already recorded (state: ${state}); `
      + 'a re-drive needs a fresh operationId — overwriting would erase the '
      + 'dispatch evidence the recovery contract rides on');
    this.name = 'OperationExistsError';
  }
}

export class RetryRefusedError extends Error {
  /** @param {string} operationId @param {string} reason */
  constructor(operationId, reason) {
    super(`retry refused for ${operationId}: ${reason}`);
    this.name = 'RetryRefusedError';
  }
}

/**
 * @param {Object} deps
 * @param {{ get: (key: string) => Promise<any>,
 *   set: (key: string, value: any) => Promise<void> }} deps.storage
 * @param {() => number} [deps.now]
 */
export const createOperationLog = ({ storage, now = Date.now }) => {
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
    throw new TypeError('createOperationLog: storage adapter is required');
  }

  // The mutation queue. Every writer runs load → mutate → persist inside
  // one slot; reads outside the queue are fine (they see a committed map).
  /** @type {Promise<unknown>} */
  let queueTail = Promise.resolve();
  /** @template T @param {() => Promise<T>} job @returns {Promise<T>} */
  const enqueue = (job) => {
    const run = queueTail.then(job, job);
    queueTail = run.then(() => undefined, () => undefined);
    return run;
  };

  /** @returns {Promise<Record<string, import('./reconcile.js').OperationRecord>>} */
  const load = async () => {
    const map = await storage.get(OPERATION_LOG_KEY);
    if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
    // Entry-level validation: one corrupted/adversarial value (null, a
    // primitive, a record with no identity) must not crash listNonterminal
    // and take the whole recovery sweep down with it. Invalid entries are
    // dropped — self-healing on the next persist, and infinitely better
    // than a boot with no reconciliation at all.
    /** @type {Record<string, import('./reconcile.js').OperationRecord>} */
    const clean = {};
    for (const [key, record] of Object.entries(map)) {
      if (record && typeof record === 'object' && !Array.isArray(record)
          && typeof (/** @type {any} */ (record).operationId) === 'string') {
        clean[key] = /** @type {any} */ (record);
      }
    }
    return clean;
  };

  /** @param {Record<string, import('./reconcile.js').OperationRecord>} map */
  const persist = async (map) => {
    const prunable = Object.values(map)
      .filter((record) => PRUNABLE_STATES.has(record.state))
      .sort((a, b) => a.createdAt - b.createdAt);
    const excess = prunable.length - OPERATION_LOG_MAX_TERMINAL;
    if (excess > 0) {
      for (const record of prunable.slice(0, excess)) delete map[record.operationId];
    }
    const unknowns = Object.values(map)
      .filter((record) => record.state === OPERATION_STATES.OUTCOME_UNKNOWN)
      .sort((a, b) => a.createdAt - b.createdAt);
    const unknownExcess = unknowns.length - OPERATION_LOG_MAX_UNKNOWN;
    if (unknownExcess > 0) {
      for (const record of unknowns.slice(0, unknownExcess)) delete map[record.operationId];
    }
    await storage.set(OPERATION_LOG_KEY, map);
  };

  /**
   * Record a new operation BEFORE dispatch (§8.1). Persists, then returns
   * the stored record. An operationId already on record — live OR settled —
   * refuses (OperationExistsError): overwriting would erase the dispatched/
   * evidence flags that decide interrupted vs outcome_unknown on recovery.
   *
   * @param {Object} input
   * @param {string} input.operationId
   * @param {string} input.sessionId
   * @param {string} [input.actorId]
   * @param {string} input.toolName
   * @param {unknown} input.retryClass
   * @param {string} input.generationId
   * @param {string} [input.idempotencyKey]
   * @param {string} [input.target]
   * @param {string} [input.confirmationRef]
   */
  const begin = (input) => enqueue(async () => {
    if (!input?.operationId || !input.sessionId || !input.toolName || !input.generationId) {
      throw new TypeError('operationLog.begin: operationId, sessionId, toolName and generationId are required');
    }
    const map = await load();
    const existing = map[input.operationId];
    if (existing) throw new OperationExistsError(input.operationId, existing.state);
    /** @type {import('./reconcile.js').OperationRecord} */
    const record = {
      operationId: input.operationId,
      sessionId: input.sessionId,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      toolName: input.toolName,
      retryClass: normalizeRetryClass(input.retryClass),
      createdAt: now(),
      attempt: 1,
      state: OPERATION_STATES.CREATED,
      generationId: input.generationId,
      dispatched: false,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.target ? { target: input.target } : {}),
      ...(input.confirmationRef ? { confirmationRef: input.confirmationRef } : {}),
    };
    map[record.operationId] = record;
    await persist(map);
    return record;
  });

  /** @param {string} operationId */
  const get = async (operationId) => (await load())[operationId];

  /** All records still in a nonterminal state — the reconciler's input. */
  const listNonterminal = async () =>
    Object.values(await load()).filter((record) => !isTerminal(record.state));

  /** @param {import('./reconcile.js').OperationRecord} record
   *  @param {import('./operation-state.js').OperationState} to
   *  @param {{ resultDigest?: string, lastDurableStep?: number,
   *    dispatched?: boolean, cancelRequested?: boolean,
   *    evidence?: { kind?: string } }} patch */
  const patched = (record, to, patch) => ({
    ...record,
    state: to,
    ...(patch.dispatched === true ? { dispatched: true } : {}),
    ...(patch.cancelRequested === true ? { cancelRequested: true } : {}),
    ...(patch.evidence ? { evidence: patch.evidence } : {}),
    ...(typeof patch.lastDurableStep === 'number'
      ? { lastDurableStep: patch.lastDurableStep } : {}),
    // Result metadata is digest-only and scrubbed: the log stores
    // correlation, never payloads (§8.2).
    ...(typeof patch.resultDigest === 'string'
      ? { resultDigest: String(sanitizeDetail(patch.resultDigest)) } : {}),
  });

  /**
   * Move a LIVE operation through the state machine. Illegal transitions
   * throw (IllegalTransitionError) — recovery paths go through settle()/
   * resolveUnknown(), not free-form writes. Persists before returning.
   *
   * @param {string} operationId
   * @param {import('./operation-state.js').OperationState} to
   * @param {{ resultDigest?: string, lastDurableStep?: number,
   *   dispatched?: boolean, cancelRequested?: boolean,
   *   evidence?: { kind?: string } }} [patch]
   */
  const transition = (operationId, to, patch = {}) => enqueue(async () => {
    const map = await load();
    const record = map[operationId];
    if (!record) throw new OperationNotFoundError(operationId);
    assertTransition(record.state, to);
    const next = patched(record, to, patch);
    map[operationId] = next;
    await persist(map);
    return next;
  });

  /** Mark the moment the effect leaves peerd. @param {string} operationId */
  const markDispatched = (operationId) =>
    transition(operationId, OPERATION_STATES.AWAITING_REMOTE, { dispatched: true });

  /**
   * Apply a startup reconcile verdict (reconcileAtStartup's plan) to an
   * orphaned record — the recovery regime. canRecoverySettle governs
   * legality: any nonterminal state may settle to any terminal one, except
   * awaiting_user → outcome_unknown.
   *
   * @param {string} operationId
   * @param {import('./retry-class.js').RecoveryVerdict} verdict
   */
  const settle = (operationId, verdict) => enqueue(async () => {
    const map = await load();
    const record = map[operationId];
    if (!record) throw new OperationNotFoundError(operationId);
    if (!canRecoverySettle(record.state, verdict.state)) {
      throw new TypeError(`recovery settle refused: ${record.state} -> ${String(verdict.state)}`);
    }
    const next = { ...record, state: verdict.state };
    map[operationId] = next;
    await persist(map);
    return next;
  });

  /**
   * The ONE exit from outcome_unknown: positive after-the-fact evidence
   * (resolveUnknownOutcome throws on anything weaker, including timeouts).
   * Persists the settled state together with the evidence that earned it.
   *
   * @param {string} operationId
   * @param {{ kind?: string }} evidence
   */
  const resolveUnknown = (operationId, evidence) => enqueue(async () => {
    const map = await load();
    const record = map[operationId];
    if (!record) throw new OperationNotFoundError(operationId);
    if (record.state !== OPERATION_STATES.OUTCOME_UNKNOWN) {
      throw new TypeError(`resolveUnknown requires outcome_unknown; got ${record.state}`);
    }
    const resolved = resolveUnknownOutcome(evidence);
    const next = { ...record, state: resolved, evidence };
    map[operationId] = next;
    await persist(map);
    return next;
  });

  /**
   * Class A–D retries: a fresh attempt number on the same operation.
   * Refused for Class E (a user-instructed repeat of a non-idempotent
   * action is a NEW operation with a fresh confirmation, never a re-drive
   * of the old record) and for any state but `interrupted` — settled
   * outcomes are never re-driven.
   *
   * @param {string} operationId
   * @param {{ generationId?: string }} [patch]  re-stamp the LIVE generation
   *   driving the retry — leaving the dead generation's stamp would
   *   misattribute the attempt in audit and make the reconciler skip it as
   *   "current" never again.
   */
  const newAttempt = (operationId, patch = {}) => enqueue(async () => {
    const map = await load();
    const record = map[operationId];
    if (!record) throw new OperationNotFoundError(operationId);
    if (record.state !== OPERATION_STATES.INTERRUPTED) {
      throw new RetryRefusedError(operationId,
        `requires an interrupted operation; got ${record.state}`);
    }
    if (normalizeRetryClass(record.retryClass) === RETRY_CLASSES.SIDE_EFFECT) {
      throw new RetryRefusedError(operationId,
        'Class E repeats as a new operation with a fresh confirmation, never a re-drive');
    }
    const next = {
      ...record,
      attempt: record.attempt + 1,
      state: OPERATION_STATES.QUEUED,
      dispatched: false,
      ...(typeof patch.generationId === 'string' && patch.generationId
        ? { generationId: patch.generationId } : {}),
    };
    map[operationId] = next;
    await persist(map);
    return next;
  });

  return {
    begin, get, listNonterminal, transition, markDispatched,
    settle, resolveUnknown, newAttempt,
  };
};
