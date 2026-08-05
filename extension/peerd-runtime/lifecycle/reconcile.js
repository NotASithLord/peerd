// @ts-check
// Startup reconciliation — what a fresh service-worker generation does with
// the durable operation records the last one left behind (contract §5.3).
//
// Given the durable records and the newly minted generation, produce — as
// VALUES, no IO — the full recovery plan: per-operation terminal
// transitions (via the retry-class decision), released ownership records,
// refused stale authority, parent-session notifications carrying the §5.4
// structured recovery record, and the audit entries for all of it. The
// shell (service-worker.js) applies the plan; this module only decides it.
//
// A model turn is never resumed from the middle of a stream by this path —
// reconciliation lands interrupted/outcome_unknown states and recovery
// records; the separate auto-resume seam (loop/resume-detect.js) decides
// whether a NEW continuation turn is warranted.

import { OPERATION_STATES, isTerminal } from './operation-state.js';
import { decideRecovery, normalizeRetryClass } from './retry-class.js';
import { sweepStaleAuthority } from './generation.js';
import { LIFECYCLE_EVENTS, lifecycleAuditEntry } from './audit-events.js';

/**
 * The durable operation record (contract §8). The operation log persists
 * this shape; the reconciler consumes it.
 *
 * @typedef {Object} OperationRecord
 * @property {string} operationId
 * @property {string} sessionId
 * @property {string} [actorId]
 * @property {string} toolName
 * @property {unknown} retryClass
 * @property {number} createdAt
 * @property {number} attempt
 * @property {import('./operation-state.js').OperationState} state
 * @property {string} [idempotencyKey]
 * @property {string} [target]
 * @property {string} [confirmationRef]
 * @property {number} [lastDurableStep]
 * @property {string} [resultDigest]
 * @property {string} [generationId]   generation that was driving it
 * @property {boolean} [dispatched]    the effect left peerd
 * @property {boolean} [cancelRequested]
 * @property {{ kind?: string }} [evidence]
 */

// Nonterminal states the reconciler must settle (§5.3 step 3 names
// running/awaiting_user/awaiting_remote; created/queued/cancelling are the
// same orphans caught earlier/later in their lifecycle).
const RECONCILABLE = Object.freeze(
  /** @type {ReadonlySet<import('./operation-state.js').OperationState>} */ (new Set([
    OPERATION_STATES.CREATED, OPERATION_STATES.QUEUED, OPERATION_STATES.RUNNING,
    OPERATION_STATES.AWAITING_USER, OPERATION_STATES.AWAITING_REMOTE,
    OPERATION_STATES.CANCELLING,
  ])));

/**
 * The §5.4 structured recovery record a parent session receives about one
 * settled operation.
 *
 * @param {OperationRecord} record
 * @param {import('./retry-class.js').RecoveryVerdict} recoveryVerdict
 */
export const buildTurnRecoveryRecord = (record, recoveryVerdict) => {
  const unknown = recoveryVerdict.state === OPERATION_STATES.OUTCOME_UNKNOWN;
  return {
    operation: record.toolName,
    operationId: record.operationId,
    previousState: record.state,
    recoveryState: recoveryVerdict.state,
    ...(typeof record.lastDurableStep === 'number'
      ? { lastDurableStep: record.lastDurableStep } : {}),
    sideEffectStatus: unknown
      ? 'outcome_unknown'
      : (record.dispatched === true ? 'dispatched' : 'none attempted'),
    ...(unknown ? { verificationRequired: true } : {}),
  };
};

// The audit event a reconcile verdict earns. An evidence-settled verdict is
// COMPLETED, uncertainty is OUTCOME_UNKNOWN, everything else (interrupted,
// cancelled, evidence-proven failed) records as the interruption it is —
// labelling a completed operation "interrupted" would misfile the one
// event chain audits reconstruct from.
/** @param {import('./operation-state.js').OperationState} state */
const auditEventFor = (state) => {
  if (state === OPERATION_STATES.OUTCOME_UNKNOWN) return LIFECYCLE_EVENTS.OUTCOME_UNKNOWN;
  if (state === OPERATION_STATES.COMPLETED) return LIFECYCLE_EVENTS.OPERATION_COMPLETED;
  return LIFECYCLE_EVENTS.OPERATION_INTERRUPTED;
};

/**
 * @typedef {Object} ReconcilePlan
 * @property {Array<{ operationId: string,
 *   from: import('./operation-state.js').OperationState,
 *   to: import('./operation-state.js').OperationState,
 *   verdict: import('./retry-class.js').RecoveryVerdict }>} transitions
 * @property {Array<{ record: import('./generation.js').StampedAuthority,
 *   reason: string }>} staleAuthority
 * @property {Array<{ sessionId: string, actorId?: string,
 *   recoveryRecord: ReturnType<typeof buildTurnRecoveryRecord> }>} notifications
 * @property {Array<ReturnType<typeof lifecycleAuditEntry>>} auditEvents
 */

/**
 * Decide the whole startup recovery plan for a new SW generation.
 *
 * Rules encoded (contract §5.3):
 *  - only nonterminal records are touched; terminal history is immutable;
 *  - an operation parked on a user approval (`awaiting_user`) is always
 *    `interrupted` — its confirmation died with the old generation, and no
 *    side effect can have been in flight while waiting on the user;
 *  - everything else settles via the retry-class decision (Class E
 *    dispatched-unproven → outcome_unknown, never auto-retry);
 *  - a record still stamped with the CURRENT generation is not an orphan
 *    (the shell may pass records mid-write) and is left alone;
 *  - each settled operation notifies its parent session with the §5.4
 *    recovery record and appends the matching audit entries;
 *  - every stamped authority record passed in (grants, approval tokens,
 *    leases, tab/actor ownership) is swept: prior-generation or expired
 *    stamps land in staleAuthority with a STALE_GRANT_REFUSED audit entry
 *    each — the shell releases them (§5.3 steps 5 and 7).
 *
 * The plan's transitions apply through operationLog.settle() — the recovery
 * regime — never through the live transition table.
 *
 * @param {Object} input
 * @param {OperationRecord[]} input.records
 * @param {import('./generation.js').Generation} input.generation  freshly minted
 * @param {import('./generation.js').StampedAuthority[]} [input.authorityRecords]
 * @param {number} [input.now]  defaults to the new generation's mint time
 * @returns {ReconcilePlan}
 */
export const reconcileAtStartup = ({ records, generation, authorityRecords, now }) => {
  /** @type {ReconcilePlan} */
  const plan = {
    transitions: [], staleAuthority: [], notifications: [],
    auditEvents: [lifecycleAuditEntry({
      event: LIFECYCLE_EVENTS.SW_GENERATION_CHANGED,
      generationId: generation.id,
    })],
  };

  const { stale } = sweepStaleAuthority(authorityRecords ?? [], {
    generation, now: typeof now === 'number' ? now : generation.mintedAt,
  });
  for (const entry of stale) {
    plan.staleAuthority.push(entry);
    plan.auditEvents.push(lifecycleAuditEntry({
      event: LIFECYCLE_EVENTS.STALE_GRANT_REFUSED,
      generationId: generation.id,
      detail: { reason: entry.reason },
    }));
  }

  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record.operationId !== 'string') continue;
    if (isTerminal(record.state) || !RECONCILABLE.has(record.state)) continue;
    if (record.generationId === generation.id) continue; // ours, in flight

    // Waiting on the user = nothing dispatched; the pending confirmation is
    // dead either way (generation changed). Force the safe shape onto BOTH
    // the decision and the recovery record — a bogus dispatched flag on an
    // awaiting_user record must not surface as "dispatched" to the parent.
    const effective = record.state === OPERATION_STATES.AWAITING_USER
      ? { ...record, dispatched: false }
      : record;

    const verdict = decideRecovery({
      retryClass: normalizeRetryClass(effective.retryClass),
      dispatched: effective.dispatched,
      cancelRequested: effective.cancelRequested,
      evidence: effective.evidence,
    });

    plan.transitions.push({
      operationId: record.operationId,
      from: record.state,
      to: verdict.state,
      verdict,
    });

    const recoveryRecord = buildTurnRecoveryRecord(effective, verdict);
    plan.notifications.push({
      sessionId: record.sessionId,
      ...(record.actorId ? { actorId: record.actorId } : {}),
      recoveryRecord,
    });

    plan.auditEvents.push(lifecycleAuditEntry({
      event: auditEventFor(verdict.state),
      sessionId: record.sessionId,
      actorId: record.actorId,
      operationId: record.operationId,
      attempt: record.attempt,
      result: verdict.state,
      generationId: generation.id,
      detail: { toolName: record.toolName, reason: verdict.reason },
    }));
  }

  return plan;
};
