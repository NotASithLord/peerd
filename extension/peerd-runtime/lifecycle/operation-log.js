// @ts-check
// The durable operation log — persist-before-report over injected storage.
//
// Every operation that can outlive one synchronous call gets a record here
// (contract §8): created before dispatch, dispatched marked before the
// effect leaves peerd, results persisted before success is reported to the
// agent. Storage is injected (the SW passes a chrome.storage.local
// adapter), mirroring the other runtime stores; state changes go through
// the operation-state legality table, and result metadata passes the audit
// sanitizer so a bearer token or raw header can never reach disk.

import {
  OPERATION_STATES, assertTransition, isTerminal,
} from './operation-state.js';
import { normalizeRetryClass } from './retry-class.js';
import { sanitizeDetail } from './audit-events.js';

export const OPERATION_LOG_KEY = 'peerd.lifecycle.operations';

// Terminal records kept for correlation before the oldest are pruned. why a
// cap: the log is a recovery + audit correlation surface, not history —
// unbounded growth would make the startup reconcile scan pay for every
// operation ever run.
export const OPERATION_LOG_MAX_TERMINAL = 500;

export class OperationNotFoundError extends Error {
  /** @param {string} operationId */
  constructor(operationId) {
    super(`no operation record: ${operationId}`);
    this.name = 'OperationNotFoundError';
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

  /** @returns {Promise<Record<string, import('./reconcile.js').OperationRecord>>} */
  const load = async () => {
    const map = await storage.get(OPERATION_LOG_KEY);
    return map && typeof map === 'object' ? map : {};
  };

  /** @param {Record<string, import('./reconcile.js').OperationRecord>} map */
  const persist = async (map) => {
    const terminal = Object.values(map)
      .filter((record) => isTerminal(record.state))
      .sort((a, b) => a.createdAt - b.createdAt);
    const excess = terminal.length - OPERATION_LOG_MAX_TERMINAL;
    if (excess > 0) {
      for (const record of terminal.slice(0, excess)) delete map[record.operationId];
    }
    await storage.set(OPERATION_LOG_KEY, map);
  };

  /**
   * Record a new operation BEFORE dispatch (§8.1). Persists, then returns
   * the stored record.
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
  const begin = async (input) => {
    if (!input?.operationId || !input.sessionId || !input.toolName || !input.generationId) {
      throw new TypeError('operationLog.begin: operationId, sessionId, toolName and generationId are required');
    }
    const map = await load();
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
  };

  /** @param {string} operationId */
  const get = async (operationId) => (await load())[operationId];

  /** All records still in a nonterminal state — the reconciler's input. */
  const listNonterminal = async () =>
    Object.values(await load()).filter((record) => !isTerminal(record.state));

  /**
   * Move an operation through the state machine. Illegal transitions throw
   * (IllegalTransitionError) — recovery paths must go through the
   * reconciler/resolver, not free-form writes. Persists before returning.
   *
   * @param {string} operationId
   * @param {import('./operation-state.js').OperationState} to
   * @param {{ resultDigest?: string, lastDurableStep?: number,
   *   dispatched?: boolean, cancelRequested?: boolean,
   *   evidence?: { kind?: string }, detail?: unknown }} [patch]
   */
  const transition = async (operationId, to, patch = {}) => {
    const map = await load();
    const record = map[operationId];
    if (!record) throw new OperationNotFoundError(operationId);
    assertTransition(record.state, to);
    const next = {
      ...record,
      state: to,
      ...(patch.dispatched === true ? { dispatched: true } : {}),
      ...(patch.cancelRequested === true ? { cancelRequested: true } : {}),
      ...(patch.evidence ? { evidence: patch.evidence } : {}),
      ...(typeof patch.lastDurableStep === 'number'
        ? { lastDurableStep: patch.lastDurableStep } : {}),
      // Result metadata is digest-only and scrubbed: the log stores
      // correlation, never payloads or credentials (§8.2).
      ...(typeof patch.resultDigest === 'string'
        ? { resultDigest: String(sanitizeDetail(patch.resultDigest)) } : {}),
    };
    map[operationId] = next;
    await persist(map);
    return next;
  };

  /** Mark the moment the effect leaves peerd. @param {string} operationId */
  const markDispatched = (operationId) =>
    transition(operationId, OPERATION_STATES.AWAITING_REMOTE, { dispatched: true });

  /**
   * Class B retries: a fresh attempt number on the same operation. Refused
   * on terminal records other than `interrupted` — a retry re-drives an
   * interrupted read, never a settled outcome.
   * @param {string} operationId
   */
  const newAttempt = async (operationId) => {
    const map = await load();
    const record = map[operationId];
    if (!record) throw new OperationNotFoundError(operationId);
    if (record.state !== OPERATION_STATES.INTERRUPTED) {
      throw new TypeError(`newAttempt requires an interrupted operation; got ${record.state}`);
    }
    const next = {
      ...record,
      attempt: record.attempt + 1,
      state: OPERATION_STATES.QUEUED,
      dispatched: false,
    };
    map[operationId] = next;
    await persist(map);
    return next;
  };

  return { begin, get, listNonterminal, transition, markDispatched, newAttempt };
};
