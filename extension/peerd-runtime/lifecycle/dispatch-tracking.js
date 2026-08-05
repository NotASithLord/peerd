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
import { FAILURE_OUTCOMES, isFailureOutcomeKind } from './failure-taxonomy.js';
import { bindConfirmation, consumeConfirmation } from './confirmation.js';

// --- Idempotency keys ------------------------------------------------------
//
// The deterministic key for Class C/D records (§8: same call + same args =
// same operation; a retry must reuse this key, never mint a fresh one).
//
// why CANONICAL serialization and not JSON.stringify: property order is an
// accident of how the args object was built — a model re-emitting the same
// call with `{b,a}` instead of `{a,b}`, or a hook rewriting args through a
// different code path, must produce the SAME key or the "reuse the original
// key on retry" rule silently breaks. Keys are sorted at every depth;
// ARRAY order is preserved because it is semantic.
//
// why SHA-256 and not a 32-bit hash: these keys are durable metadata today
// and the intended carrier for external idempotency headers (RFC-style
// Idempotency-Key) tomorrow. A 32-bit digest collides at ~77k distinct
// argument sets by the birthday bound — fine for a local dedup hint, not
// fine for something that may one day tell a payment API "this is the same
// request". 256 bits makes the collision question moot before it is asked.

// why a depth cap: args come from the model and could nest adversarially
// deep; a bounded walk keeps a pathological payload from blowing the stack
// on a path that must never fail a dispatch.
const CANONICAL_MAX_DEPTH = 8;

/**
 * Order-independent, stable serialization of an arbitrary args value.
 * Undefined/functions/symbols collapse to null (JSON.stringify's own
 * behavior for them), so the output is always valid JSON text.
 *
 * @param {unknown} value @param {number} [depth]
 * @returns {string}
 */
export const canonicalJson = (value, depth = 0) => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (depth >= CANONICAL_MAX_DEPTH) return '"[depth-capped]"';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry, depth + 1)).join(',')}]`;
  }
  const entries = Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(
      /** @type {Record<string, unknown>} */ (value)[key], depth + 1)}`);
  return `{${entries.join(',')}}`;
};

/**
 * SHA-256 of a string, lowercase hex. WebCrypto is present in every context
 * this runs in (service worker, offscreen worker, the bun test runner).
 * @param {string} text @returns {Promise<string>}
 */
export const sha256Hex = async (text) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * The durable idempotency key for one call: tool name + canonical args
 * digest. Same tool + same args (in any property order) → same key.
 *
 * @param {string} toolName @param {unknown} args @returns {Promise<string>}
 */
export const idempotencyKeyFor = async (toolName, args) =>
  `${toolName}:${await sha256Hex(canonicalJson(args ?? {}))}`;

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
 * The replay-identity store could not be read, so "has this already run?"
 * is unanswered. Named so the total wrapper's refusal reason says which
 * question went unanswered rather than leaking a raw storage message.
 */
class TombstoneUnreadableError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(`replay-identity lookup failed: ${message}`);
    this.name = 'TombstoneUnreadableError';
  }
}

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
 * @param {() => number} [deps.now]  injectable clock (confirmation proofs)
 */
export const makeDispatchTracker = ({ operationLog, generationId, retryClassFor, classifyFailure, now = Date.now }) => {
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
      //
      // why the force-settle is GENERATION-GATED: "in flight, unproven" only
      // means "outcome lost" when the driving generation is DEAD. A
      // current-generation record in awaiting_remote is still being driven
      // by a live handle in THIS SW — its execute() may resolve seconds
      // from now with real evidence, and pre-settling it to outcome_unknown
      // would discard that evidence (the duplicate is refused either way;
      // the mutation is the bug, not the refusal).
      const driverIsDead = record.generationId !== generationId();
      const verdict = decideRecovery({ retryClass, dispatched: true });
      const report = describeRecovery(verdict, {
        retryClass, operationId: record.operationId, toolName: record.toolName,
      });
      if (!settledUnknown && driverIsDead) {
        if (canTransition(record.state, OPERATION_STATES.OUTCOME_UNKNOWN)) {
          await operationLog.transition(record.operationId, OPERATION_STATES.OUTCOME_UNKNOWN)
            .catch(() => {});
        } else {
          await operationLog.settle(record.operationId, verdict).catch(() => {});
        }
      }
      return {
        refuse: {
          error: `outcome_unknown: ${record.toolName} was already dispatched and `
            + `its result is ${driverIsDead ? 'lost' : 'still pending'}. It may `
            + 'have completed — verify the external state before repeating it. '
            + 'Not re-executing automatically.',
          recovery: report.agent,
        },
      };
    }

    if (record.state === OPERATION_STATES.INTERRUPTED
        && retryClass !== RETRY_CLASSES.SIDE_EFFECT
        // The RECORD's class binds too: a call id whose recorded operation
        // was Class E re-presented under a softer classification is a
        // class-confusion replay, not a sanctioned retry — newAttempt would
        // refuse it anyway (RetryRefusedError), and that rejection must
        // surface as a REFUSAL, not bubble into the dispatcher's fail-open
        // catch and run untracked.
        && normalizeRetryClass(record.retryClass) !== RETRY_CLASSES.SIDE_EFFECT) {
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
   * @param {boolean} [input.confirmed]  the user approved a confirm
   *   round-trip for exactly this dispatch — a single-use, generation-bound
   *   proof is minted, CONSUMED, and persisted on the record (§8.3: the
   *   durable forensic chain shows what was approved, under which
   *   generation, and that the approval covers exactly one dispatch)
   * @param {Record<string, unknown>} [input.args]  post-hook args; C/D
   *   records derive their deterministic idempotency key from these
   * @returns {Promise<BeginOutcome>}
   */
  const beginTrackingInner = async ({ callId, tool, sessionId, actorId, target, confirmed, args }) => {
    const retryClass = normalizeRetryClass(retryClassFor(tool));
    if (retryClass === RETRY_CLASSES.PURE_READ) return null;
    if (typeof callId !== 'string' || !callId) return null;

    // The operation identity is SESSION-scoped. why: the replay guard must
    // fire on the same call re-driven within its own session (auto-resume
    // replaying pending tool_use ids), and must NOT fire when two unrelated
    // sessions happen to see the same provider call id — that is a new
    // operation, not a replay.
    const operationId = sessionId ? `${sessionId}:${callId}` : callId;
    // Tombstone check (D/E only — the only classes that mint them): a call
    // id whose FULL record was pruned still carries compact replay
    // identity; re-presenting it is refused exactly as the record would
    // have.
    //
    // why an unreadable tombstone store FAILS CLOSED rather than falling
    // through to begin(): this branch only runs for non-idempotent classes,
    // and the question it answers is "has this exact call already run?".
    // A storage error means that question is UNANSWERED — proceeding would
    // be assuming "no" with no evidence, which is the replay the guard
    // exists to prevent.
    if (retryClass === RETRY_CLASSES.SIDE_EFFECT
        || retryClass === RETRY_CLASSES.CONDITIONAL_ACTION) {
      const tombstone = await Promise.resolve(operationLog.getTombstone?.(operationId))
        .catch((error) => {
          throw new TombstoneUnreadableError(
            error instanceof Error ? error.message : String(error));
        });
      if (tombstone) {
        return {
          refuse: {
            error: tombstone.terminalState === OPERATION_STATES.COMPLETED
              ? `completed: ${tool.name ?? 'this action'} already completed on a `
                + 'previous dispatch of this same call (compacted record) — not '
                + 're-executing. Issue a NEW operation if a repeat is intended.'
              : `outcome_unknown: a previous dispatch of this same call ended `
                + `${tombstone.terminalState} and its full record was compacted. `
                + 'Verify the external state before repeating it. Not re-executing '
                + 'automatically.',
            recovery: {
              category: 'verify_before_retry',
              state: /** @type {import('./operation-state.js').OperationState} */ (
                tombstone.terminalState),
              autoRetry: false, retryRequires: ['user-instruction'],
              verificationRequired: tombstone.terminalState !== OPERATION_STATES.COMPLETED,
              keepIdempotencyKey: false,
              reason: 'replay of a compacted (tombstoned) operation',
            },
          },
        };
      }
    }
    // Class C/D: the deterministic idempotency key (same call + same args =
    // same operation; retries reuse it, never mint fresh — §4/§8).
    // Best-effort: the key is durable METADATA, not a gate — the replay
    // guard keys on operationId — so a digest failure degrades the record's
    // richness, never the dispatch's safety.
    const idempotencyKey = (retryClass === RETRY_CLASSES.IDEMPOTENT_WRITE
      || retryClass === RETRY_CLASSES.CONDITIONAL_ACTION)
      ? await idempotencyKeyFor(tool.name ?? 'tool', args).catch(() => undefined)
      : undefined;
    // An approved confirmation becomes a single-use proof, consumed BEFORE
    // dispatch and persisted on the record: generation-bound (a restart
    // invalidates it), target-bound, expiring — the durable chain the
    // contract's §8.3 verification asks for.
    //
    // TRUST BOUNDARY — what this proof does and does not mean. It is the
    // DISPATCHER'S OWN RECORD that it observed a valid approval for exactly
    // this operation and consumed it before dispatching. It is NOT a
    // cryptographic attestation from the UI: nothing here is signed, and
    // the side panel does not hand back a token peerd verifies. The proof
    // is minted service-worker-side from `confirmed`, which is the confirm
    // coordinator's own return value.
    //
    // So it defends against the failures inside peerd's trust boundary —
    // an approval being REPLAYED onto a second dispatch, SURVIVING a
    // restart that should have invalidated it, drifting to a DIFFERENT
    // target or operation, or outliving its window — and it gives audit a
    // truthful record of what was approved. It does not, and cannot,
    // defend against a compromised service worker: code that can call this
    // function can also fabricate `confirmed: true`. Raising that bar
    // needs a signed capability from the UI surface, which is a separate
    // design (and would change this from evidence into attestation).
    const confirmationProof = confirmed === true
      ? consumeConfirmation(bindConfirmation({
        operationId,
        action: tool.name ?? 'unknown-tool',
        target: target || `tool:${tool.name ?? 'unknown-tool'}`,
        generationId: generationId(),
        now: now(),
      }))
      : undefined;
    try {
      await operationLog.begin({
        operationId,
        sessionId: sessionId || 'unknown-session',
        ...(actorId ? { actorId } : {}),
        toolName: tool.name ?? 'unknown-tool',
        retryClass,
        generationId: generationId(),
        ...(target ? { target } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(confirmationProof ? {
          confirmationRef: `${operationId}:confirm`,
          confirmationProof,
        } : {}),
      });
      await operationLog.transition(operationId, OPERATION_STATES.RUNNING);
      // Dispatched is stamped BEFORE execute(): once execute starts, an
      // effect may leave peerd at any instant, and the record must already
      // say so if the SW dies mid-flight.
      await operationLog.markDispatched(operationId);
    } catch (error) {
      if (error instanceof OperationExistsError) {
        // resumeExisting must never REJECT into the dispatcher's fail-open
        // catch — that would convert a refusal-worthy replay into an
        // UNTRACKED execution. Any error inside the resume decision takes
        // the same fail-closed posture as a storage failure.
        try {
          const record = await operationLog.get(operationId);
          if (record) return await resumeExisting(record, retryClass);
        } catch (resumeError) {
          return refuseUntracked(retryClass, tool.name,
            `replay resolution failed (${resumeError instanceof Error ? resumeError.message : String(resumeError)})`);
        }
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
      // If the record was force-parked outcome_unknown while this dispatch
      // was executing (a refused duplicate of a dead generation's record),
      // the LATE positive evidence is exactly what resolveUnknown exists
      // for — record it rather than discard it.
      await operationLog.transition(operationId, OPERATION_STATES.COMPLETED, {
        evidence: { kind: 'success-response' },
        ...(outcome.resultDigest ? { resultDigest: outcome.resultDigest } : {}),
      }).catch(() =>
        operationLog.resolveUnknown(operationId, { kind: 'success-response' })
          .catch(() => {}));
      return null;
    }

    const kind = failureKind(outcome.error);
    const cancelRequested = outcome.aborted === true || kind === 'aborted';
    // A TYPED outcome stamped at the throw site outranks every string
    // heuristic (failure-taxonomy.js): pre-effect-failure is definitive,
    // transport/host loss is ambiguous, full stop. Unstamped failures
    // fall back to the regex + taxonomy guesswork below.
    // VALIDATED first — outcomeKind can cross relay boundaries carrying
    // garbage; an unknown value falls back to the heuristics, never trusted.
    const typedKind = isFailureOutcomeKind(outcome.outcomeKind)
      ? outcome.outcomeKind
      : undefined;
    // The burden of proof is INVERTED by class. For a DISPATCHED Class D/E
    // action, `failed` is a positive claim — "the effect did not occur" —
    // and only an explicit typed pre-effect-failure carries that proof. An
    // unrecognized error string proves nothing about whether the effect
    // landed, so the default is uncertainty; the string heuristics may only
    // WIDEN ambiguity, never establish definitive non-execution. A/B/C keep
    // the heuristic split: a wrong `failed` there is retryable and harmless.
    const conservative = retryClass === RETRY_CLASSES.SIDE_EFFECT
      || retryClass === RETRY_CLASSES.CONDITIONAL_ACTION;
    const ambiguous = typedKind
      ? typedKind !== FAILURE_OUTCOMES.PRE_EFFECT_FAILURE
      : (conservative || isAmbiguousLoss(outcome.error, kind));

    if (!ambiguous && !cancelRequested) {
      // A definitive error response — the target refused before the
      // effect. Honest `failed`. Same late-evidence recovery as the
      // success path for a record parked outcome_unknown mid-execute.
      await operationLog.transition(operationId, OPERATION_STATES.FAILED, {
        evidence: { kind: 'error-response-before-effect' },
      }).catch(() =>
        operationLog.resolveUnknown(operationId, { kind: 'error-response-before-effect' })
          .catch(() => {}));
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

  /**
   * beginTracking is a TOTAL function: it resolves to a refusal, a handle,
   * or null — it never rejects. why this matters more than it looks: the
   * dispatcher's call site is the last branch point before execute(), so a
   * rejection there is indistinguishable from "tracking is optional" and
   * would degrade a non-idempotent dispatch to untracked execution. Every
   * expected failure is already handled inside (storage down, duplicate
   * record, unreadable replay identity); this wrapper is the backstop for
   * the UNexpected — a throwing injected classifier, a generationId() that
   * blows up, a storage layer rejecting somewhere new after a refactor.
   *
   * The refusal it produces is class-correct: if even classification threw,
   * the class defaults to E (refuse), never to "probably safe".
   *
   * @param {Parameters<typeof beginTrackingInner>[0]} input
   * @returns {Promise<BeginOutcome>}
   */
  const beginTracking = async (input) => {
    try {
      return await beginTrackingInner(input);
    } catch (error) {
      /** @type {import('./retry-class.js').RetryClass} */
      let retryClass = RETRY_CLASSES.SIDE_EFFECT;
      try { retryClass = normalizeRetryClass(retryClassFor(input?.tool)); }
      catch { /* classification itself threw — stay at E, the closed default */ }
      return refuseUntracked(retryClass, input?.tool?.name,
        error instanceof TombstoneUnreadableError
          ? error.message
          : `tracking failed unexpectedly (${error instanceof Error ? error.message : String(error)})`);
    }
  };

  return { beginTracking, settleTracking };
};
