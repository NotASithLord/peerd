// @ts-check
// Dispatch tracking — the lifecycle contract wired into the tool choke point.
//
// The dispatcher calls beginTracking() after every gate/confirm/hook has
// passed and before execute(), and settleTracking() with the outcome. In
// between, the durable operation record exists with dispatched:true — so a
// service-worker eviction at ANY point leaves evidence the startup
// reconciler can settle truthfully (interrupted vs outcome_unknown).
//
// This file also enforces contract guarantee 2 as a structural backstop:
// any dispatch that re-presents an operationId whose earlier dispatch has
// no proven outcome is REFUSED with the semantic state instead of executed
// twice. (The auto-resume path itself repairs orphaned tool_use blocks as
// synthesized error results rather than re-dispatching — see the format
// layer's orphan repair — so the guard's live coverage is the other replay
// shapes: an OpenAI-compat model re-emitting an id it used before, a
// duplicated wake delivery, or any future resume path that does re-drive.)
//
// Failure semantics (§16.2 — no generic timeouts): a settled failure is
// classified. A definitive error response is `failed`; an ambiguous
// transport loss (timeout, dropped connection) settles by retry class —
// interrupted for A/B/C, outcome_unknown for D/E — and the tool result's
// error string carries that state, so the agent hears the distinction, not
// "timeout".
//
// Functional core over the injected operation log; no chrome.*, bun-tested.

import { OPERATION_STATES, canTransition } from './operation-state.js';
import { RETRY_CLASSES, decideRecovery, normalizeRetryClass } from './retry-class.js';
import { describeRecovery } from './recovery-report.js';
import { OperationExistsError } from './operation-log.js';
import { FAILURE_OUTCOMES } from './failure-taxonomy.js';

// Error shapes that mean "the wire died with the request possibly delivered"
// — the ambiguous bucket. Kept alongside the classifier kind 'timeout'
// because fetch-layer failures surface as bare TypeError messages that the
// taxonomy files under 'environment'/'internal'.
// HTTP 5xx is here on purpose: the server RECEIVED the request before
// erroring, so for a non-idempotent action the effect may have landed
// before the failure was minted. Only pre-effect refusals (4xx validation,
// gate blocks) are definitive.
const AMBIGUOUS_ERROR = /timed? ?out|timeout|failed to fetch|networkerror|network error|connection (reset|closed|lost|refused)|socket hang ?up|ERR_(NETWORK|CONNECTION|INTERNET|TIMED_OUT)|fetch failed|load failed|HTTP 5\d\d|\b50[0-4]\b.*(server|gateway)|internal server error|bad gateway|service unavailable|gateway time/i;

// Execution-HOST deaths: the channel to the code doing the work died — a
// closed message port, a closed engine tab, a terminated worker, an
// invalidated extension context. These are NOT the tool attesting failure
// (a returned "element not found" is); they are the transport dying with
// the effect possibly in flight, so for a non-idempotent action they are
// ambiguous, never positive failure evidence.
const HOST_DEATH_ERROR = /message port closed|receiving end does not exist|could not establish connection|tab (was |is )?closed|no tab with id|VM(NotReady|BootFailed|TabClosed)|worker (was )?(terminated|died|killed)|context invalidated|extension context|target (closed|crashed)|frame (was )?detached/i;

/** @param {string | undefined} error @param {string} kind */
const isAmbiguousLoss = (error, kind) =>
  kind === 'timeout'
  || (typeof error === 'string'
    && (AMBIGUOUS_ERROR.test(error) || HOST_DEATH_ERROR.test(error)));

/**
 * @typedef {Object} TrackingHandle
 * @property {string} operationId
 * @property {import('./retry-class.js').RetryClass} retryClass
 * @property {string} toolName
 */

/**
 * @typedef {{ refuse: { error: string, recovery: ReturnType<typeof describeRecovery>['agent'] } }
 *   | { handle: TrackingHandle } | null} BeginOutcome
 */

/**
 * The fail-closed refusal for a Class D/E dispatch whose tracking cannot
 * start; A/B/C degrade to untracked (null). Shared by the live tracker's
 * storage-failure path and makeFailClosedTracker below.
 *
 * @param {import('./retry-class.js').RetryClass} retryClass
 * @param {string | undefined} toolName
 * @param {string} reason
 * @returns {BeginOutcome}
 */
const refuseUntracked = (retryClass, toolName, reason) => {
  if (retryClass !== RETRY_CLASSES.SIDE_EFFECT
      && retryClass !== RETRY_CLASSES.CONDITIONAL_ACTION) {
    return null;
  }
  return {
    refuse: {
      error: `failed: ${toolName ?? 'this action'} was NOT executed — lifecycle `
        + `tracking is unavailable (${reason}) and a non-idempotent action must `
        + 'not run untracked: an interruption could then never be reported or '
        + 'guarded against. Retry once storage recovers, or run a read-only '
        + 'alternative.',
      recovery: {
        category: 'security_degradation',
        state: OPERATION_STATES.FAILED,
        autoRetry: false,
        retryRequires: ['lifecycle-storage'],
        verificationRequired: false,
        keepIdempotencyKey: false,
        reason: `tracking unavailable: ${reason}`,
      },
    },
  };
};

/**
 * The tracker the shell arms when lifecycle BOOT itself failed: Class D/E
 * dispatches are refused (fail closed — same rationale as a mid-flight
 * storage failure), everything else runs untracked as it did before the
 * lifecycle landed. settleTracking is a no-op (nothing was recorded).
 *
 * @param {Object} input
 * @param {string} input.reason
 * @param {(tool: { name?: string, sideEffect?: string, primitive?: string,
 *   retryClass?: unknown }) => import('./retry-class.js').RetryClass} input.retryClassFor
 */
export const makeFailClosedTracker = ({ reason, retryClassFor }) => ({
  /** @param {{ tool: { name?: string, sideEffect?: string, primitive?: string,
   *   retryClass?: unknown } }} input
   *  @returns {Promise<BeginOutcome>} */
  beginTracking: async ({ tool }) =>
    refuseUntracked(normalizeRetryClass(retryClassFor(tool)), tool?.name, reason),
  settleTracking: async () => null,
});

/**
 * @param {Object} deps
 * @param {ReturnType<import('./operation-log.js').createOperationLog>} deps.operationLog
 * @param {() => string} deps.generationId    current SW generation id
 * @param {(tool: { name?: string, sideEffect?: string, primitive?: string,
 *   retryClass?: unknown }) => import('./retry-class.js').RetryClass} deps.retryClassFor
 * @param {(error: string) => string | { kind: string }} [deps.classifyFailure]
 *   observability taxonomy (its native shape is { kind, label }); absent →
 *   only the transport regex decides ambiguity
 */
export const makeDispatchTracker = ({ operationLog, generationId, retryClassFor, classifyFailure }) => {
  if (!operationLog || typeof generationId !== 'function' || typeof retryClassFor !== 'function') {
    throw new TypeError('makeDispatchTracker: operationLog, generationId and retryClassFor are required');
  }

  /** @param {string | undefined} error */
  const failureKind = (error) => {
    try {
      const out = classifyFailure?.(error ?? '');
      if (typeof out === 'string') return out;
      return out?.kind ?? 'internal';
    } catch { return 'internal'; }
  };

  /**
   * Decide what an EXISTING record for this operationId means for a fresh
   * dispatch attempt. This is the auto-replay guard.
   *
   * @param {import('./reconcile.js').OperationRecord} record
   * @param {import('./retry-class.js').RetryClass} retryClass
   * @returns {Promise<BeginOutcome>}
   */
  const resumeExisting = async (record, retryClass) => {
    const settledUnknown = record.state === OPERATION_STATES.OUTCOME_UNKNOWN;
    const inFlightUnproven = !record.state || !record.dispatched
      ? false
      : record.state !== OPERATION_STATES.COMPLETED
        && record.state !== OPERATION_STATES.FAILED
        && record.state !== OPERATION_STATES.CANCELLED;

    if (record.state === OPERATION_STATES.COMPLETED) {
      // The first dispatch provably landed; re-running it is exactly the
      // duplicate the contract forbids. Refuse with the truth.
      return {
        refuse: {
          error: `completed: ${record.toolName} already completed on a previous `
            + 'dispatch of this same call — not re-executing. Use the recorded '
            + 'result or issue a NEW operation.',
          recovery: {
            category: 'verify_before_retry', state: OPERATION_STATES.COMPLETED,
            autoRetry: false, retryRequires: [], verificationRequired: false,
            keepIdempotencyKey: false, reason: 'duplicate of a completed dispatch',
          },
        },
      };
    }

    if ((settledUnknown || inFlightUnproven)
        && (retryClass === RETRY_CLASSES.SIDE_EFFECT
          || retryClass === RETRY_CLASSES.CONDITIONAL_ACTION)) {
      // Class D/E whose earlier dispatch has no proven outcome: the
      // re-dispatch is automatic (same tool_use id ⇒ nobody instructed it),
      // so it must not run.
      const verdict = decideRecovery({ retryClass, dispatched: true });
      const report = describeRecovery(verdict, {
        retryClass, operationId: record.operationId, toolName: record.toolName,
      });
      if (!settledUnknown && canTransition(record.state, OPERATION_STATES.OUTCOME_UNKNOWN)) {
        await operationLog.transition(record.operationId, OPERATION_STATES.OUTCOME_UNKNOWN)
          .catch(() => {});
      } else if (!settledUnknown) {
        await operationLog.settle(record.operationId, verdict).catch(() => {});
      }
      return {
        refuse: {
          error: `outcome_unknown: ${record.toolName} was already dispatched and `
            + 'its result was lost. It may have completed — verify the external '
            + 'state before repeating it. Not re-executing automatically.',
          recovery: report.agent,
        },
      };
    }

    if (record.state === OPERATION_STATES.INTERRUPTED
        && retryClass !== RETRY_CLASSES.SIDE_EFFECT) {
      // A/B/C/D-undispatched interruption: the sanctioned retry — same
      // operation, fresh attempt number, re-stamped with the LIVE
      // generation. markDispatched mirrors the fresh path: the retry's
      // effect can leave peerd the instant it executes, and a record still
      // claiming dispatched:false would reconcile a second interruption as
      // "never attempted, safe to auto-retry" — the exact false claim the
      // contract forbids.
      const next = await operationLog.newAttempt(record.operationId,
        { generationId: generationId() });
      await operationLog.transition(record.operationId, OPERATION_STATES.RUNNING);
      await operationLog.markDispatched(record.operationId);
      return { handle: { operationId: next.operationId, retryClass, toolName: next.toolName } };
    }

    if (record.state === OPERATION_STATES.INTERRUPTED) {
      // Interrupted Class E, re-driven with the same id: still automatic.
      // Safe (nothing dispatched) but Class E repeats only on explicit
      // instruction, which arrives as a NEW call id, never a replay.
      const verdict = decideRecovery({ retryClass, dispatched: false });
      const report = describeRecovery(verdict, {
        retryClass, operationId: record.operationId, toolName: record.toolName,
      });
      return {
        refuse: {
          error: `interrupted: ${record.toolName} was interrupted before any `
            + 'external change and is safe to retry — but not automatically. '
            + 'Ask the user, or re-issue it as a new call.',
          recovery: report.agent,
        },
      };
    }

    // A live nonterminal record that is NOT dispatched (created/queued/
    // running pre-dispatch orphan of this same generation, or a failed/
    // cancelled terminal): settle the orphan as interrupted where legal and
    // let the fresh dispatch proceed under a new attempt via newAttempt
    // when possible; otherwise refuse duplicates conservatively.
    if (record.state === OPERATION_STATES.CREATED
        || record.state === OPERATION_STATES.QUEUED
        || record.state === OPERATION_STATES.RUNNING) {
      const verdict = decideRecovery({ retryClass, dispatched: false });
      await operationLog.settle(record.operationId, verdict).catch(() => {});
      const fresh = await operationLog.get(record.operationId);
      if (fresh?.state === OPERATION_STATES.INTERRUPTED
          && retryClass !== RETRY_CLASSES.SIDE_EFFECT) {
        // Same shape as the sanctioned-retry branch above: live generation
        // stamp + dispatched marked before the effect can leave.
        const next = await operationLog.newAttempt(record.operationId,
          { generationId: generationId() });
        await operationLog.transition(record.operationId, OPERATION_STATES.RUNNING);
        await operationLog.markDispatched(record.operationId);
        return { handle: { operationId: next.operationId, retryClass, toolName: next.toolName } };
      }
    }
    return {
      refuse: {
        error: `interrupted: a previous dispatch of this exact call is on record `
          + `(state: ${record.state}); not re-executing automatically.`,
        recovery: {
          category: 'verify_before_retry', state: record.state,
          autoRetry: false, retryRequires: ['user-instruction'],
          verificationRequired: false, keepIdempotencyKey: false,
          reason: 'duplicate dispatch of a recorded operation',
        },
      },
    };
  };

  /**
   * Record the operation and mark it dispatched. Returns null for Class A
   * (pure reads are reconstructible and duplicate-invisible — tracking
   * them would put a storage write on every read), a handle to settle
   * later, or a refusal the dispatcher must return WITHOUT executing.
   *
   * @param {Object} input
   * @param {string} input.callId       the tool_use id — the operation identity
   * @param {{ name?: string, sideEffect?: string, primitive?: string, retryClass?: unknown }} input.tool
   * @param {string} [input.sessionId]
   * @param {string} [input.actorId]
   * @param {string} [input.target]
   * @returns {Promise<BeginOutcome>}
   */
  const beginTracking = async ({ callId, tool, sessionId, actorId, target }) => {
    const retryClass = normalizeRetryClass(retryClassFor(tool));
    if (retryClass === RETRY_CLASSES.PURE_READ) return null;
    if (typeof callId !== 'string' || !callId) return null;

    // The operation identity is SESSION-scoped. why: the replay guard must
    // fire on the same call re-driven within its own session (auto-resume
    // replaying pending tool_use ids), and must NOT fire when two unrelated
    // sessions happen to see the same provider call id — that is a new
    // operation, not a replay.
    const operationId = sessionId ? `${sessionId}:${callId}` : callId;
    try {
      await operationLog.begin({
        operationId,
        sessionId: sessionId || 'unknown-session',
        ...(actorId ? { actorId } : {}),
        toolName: tool.name ?? 'unknown-tool',
        retryClass,
        generationId: generationId(),
        ...(target ? { target } : {}),
      });
      await operationLog.transition(operationId, OPERATION_STATES.RUNNING);
      // Dispatched is stamped BEFORE execute(): once execute starts, an
      // effect may leave peerd at any instant, and the record must already
      // say so if the SW dies mid-flight.
      await operationLog.markDispatched(operationId);
    } catch (error) {
      if (error instanceof OperationExistsError) {
        const record = await operationLog.get(operationId);
        if (record) return resumeExisting(record, retryClass);
      }
      // Tracking storage is DOWN (or died mid-sequence). Two postures:
      //   A/B/C — degrade to untracked execution: duplicates are invisible
      //   or idempotent, so losing the record loses nothing the contract
      //   protects, and a broken log must not brick the read/write surface.
      //   D/E — REFUSE. An untracked non-idempotent effect is one whose
      //   outcome could never be recovered: no record means a later
      //   interruption silently violates guarantee 1 (uncertainty would be
      //   unreportable) and guarantee 2 (nothing would stop the replay).
      //   The action is NOT run; that is the §14 security-degradation case.
      return refuseUntracked(retryClass, tool.name,
        `operation log unavailable (${error instanceof Error ? error.message : String(error)})`);
    }
    return { handle: { operationId, retryClass, toolName: tool.name ?? 'unknown-tool' } };
  };

  /**
   * Settle a tracked dispatch from its outcome. Returns null (nothing to
   * change) or a semantic rewrite the dispatcher applies to the result.
   *
   * @param {TrackingHandle} handle
   * @param {{ ok: boolean, error?: string, aborted?: boolean, resultDigest?: string,
   *   outcomeKind?: import('./failure-taxonomy.js').FailureOutcomeKind }} outcome
   * @returns {Promise<{ error: string, recovery: ReturnType<typeof describeRecovery>['agent'] } | null>}
   */
  const settleTracking = async (handle, outcome) => {
    const { operationId, retryClass } = handle;
    // Persistence failures are isolated per-branch below, NEVER allowed to
    // swallow the semantic report: if the settle write dies, the durable
    // record stays awaiting_remote and the next boot reconciles it to
    // outcome_unknown (a truthful uncertainty) — but the AGENT must still
    // hear the semantic state NOW, or it reads a raw timeout as a definite
    // failure and re-issues the non-idempotent action under a fresh call
    // id the replay guard cannot key on.
    if (outcome.ok) {
      // A lost success-settle only costs a false uncertainty at the next
      // boot — never a false claim — so success stays reported as success.
      await operationLog.transition(operationId, OPERATION_STATES.COMPLETED, {
        evidence: { kind: 'success-response' },
        ...(outcome.resultDigest ? { resultDigest: outcome.resultDigest } : {}),
      }).catch(() => {});
      return null;
    }

    const kind = failureKind(outcome.error);
    const cancelRequested = outcome.aborted === true || kind === 'aborted';
    // A TYPED outcome stamped at the throw site outranks every string
    // heuristic (failure-taxonomy.js): pre-effect-failure is definitive,
    // transport/host loss is ambiguous, full stop. Unstamped failures
    // fall back to the regex + taxonomy guesswork below.
    const ambiguous = outcome.outcomeKind
      ? outcome.outcomeKind !== FAILURE_OUTCOMES.PRE_EFFECT_FAILURE
      : isAmbiguousLoss(outcome.error, kind);

    if (!ambiguous && !cancelRequested) {
      // A definitive error response — the target refused before the
      // effect. Honest `failed`.
      await operationLog.transition(operationId, OPERATION_STATES.FAILED, {
        evidence: { kind: 'error-response-before-effect' },
      }).catch(() => {});
      return null;
    }

    const verdict = decideRecovery({ retryClass, dispatched: true, cancelRequested });
    try {
      const record = await operationLog.get(operationId);
      if (record && canTransition(record.state, verdict.state)) {
        await operationLog.transition(operationId, verdict.state);
      } else if (record) {
        await operationLog.settle(operationId, verdict);
      }
    } catch { /* durable copy deferred to the next boot's reconcile */ }
    try {
      if (verdict.state === OPERATION_STATES.CANCELLED) {
        // A clean cancel is settled, not a recovery case — describeRecovery
        // deliberately refuses settled verdicts, and the abort surface
        // already tells the user what happened.
        return {
          error: `cancelled: ${handle.toolName} was stopped before its effect `
            + `landed (${outcome.error ?? 'aborted'})`,
          recovery: {
            category: 'safe_to_retry', state: verdict.state, autoRetry: false,
            retryRequires: ['user-instruction'], verificationRequired: false,
            keepIdempotencyKey: verdict.keepIdempotencyKey, reason: verdict.reason,
          },
        };
      }
      const report = describeRecovery(verdict, {
        retryClass, operationId, toolName: handle.toolName,
      });
      return {
        error: `${verdict.state}: ${report.user} (${handle.toolName}: ${outcome.error ?? 'connection lost'})`,
        recovery: report.agent,
      };
    } catch {
      // Report building itself failed (should be unreachable) — fall back
      // to the tool's own outcome rather than masking it with a throw.
      return null;
    }
  };

  return { beginTracking, settleTracking };
};
