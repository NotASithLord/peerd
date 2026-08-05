// @ts-check
// Lifecycle boot — what every fresh service-worker generation does first.
//
// The imperative shell's one entry point into the recovery contract: mint
// the new generation (persisting the seq so it stays monotonic), settle the
// dead generation's orphaned operations through the reconciler, append the
// plan's audit trail, and park each parent-session notification where BOTH
// audiences will see it — the user via the injected notify callback, the
// agent via drainNoticesFor(), which the turn driver folds into the next
// turn's <context> block (same semantic distinction on both sides, §14).
//
// All IO injected (storage kv, audit appender, notifier, entropy, clock);
// bun-tested with in-memory adapters, exercised against real
// chrome.storage in the in-browser suite.

import { mintGeneration } from './generation.js';
import { reconcileAtStartup } from './reconcile.js';
import { describeRecovery } from './recovery-report.js';
import { OPERATION_STATES } from './operation-state.js';
import { createOperationLog } from './operation-log.js';
import { LIFECYCLE_EVENTS, lifecycleAuditEntry } from './audit-events.js';

export const GENERATION_KEY = 'peerd.lifecycle.generation';
export const PENDING_NOTICES_KEY = 'peerd.lifecycle.pendingNotices';

// Notices kept per session before oldest are dropped — a bound, not a
// history (the operation log holds the durable record).
const MAX_NOTICES_PER_SESSION = 8;

/**
 * @param {Object} deps
 * @param {{ get: (key: string) => Promise<any>,
 *   set: (key: string, value: any) => Promise<void> }} deps.storage
 * @param {(entry: Record<string, unknown>) => Promise<unknown>} [deps.appendAudit]
 * @param {(sessionId: string, userText: string) => unknown} [deps.notify]
 * @param {(sessionId: string) => Promise<string>} [deps.resolveNoticeSession]
 *   maps an operation's session to the session whose NEXT TURN should hear
 *   the notice. why: most side effects dispatch inside ACTOR sessions,
 *   which may never take another turn (ephemeral children) — the shell
 *   passes a parent-chain walk so the notice lands on the root chat, where
 *   the turn driver actually drains it. Default: identity.
 * @param {() => string} deps.nonce   injected entropy (crypto.randomUUID)
 * @param {() => number} [deps.now]
 */
export const makeLifecycleBoot = ({
  storage, appendAudit, notify, resolveNoticeSession, nonce, now = Date.now,
}) => {
  if (!storage || typeof nonce !== 'function') {
    throw new TypeError('makeLifecycleBoot: storage and nonce are required');
  }

  const operationLog = createOperationLog({ storage, now });

  // The notices mutation queue. why: park (init + engine reaps) and drain
  // (every turn start) are read-modify-writes of ONE kv key from
  // concurrent callers — exactly the post-restart moment when both fire.
  // Unserialized, a stale drain write erases a just-parked notice forever
  // (the agent never hears the do-not-repeat instruction), and a stale
  // park write resurrects a just-delivered one (read-once broken). The
  // queue holds only the RMW; slow work (session resolution's parent
  // walk) stays outside the slot.
  /** @type {Promise<unknown>} */
  let noticesQueueTail = Promise.resolve();
  /** @template T @param {() => Promise<T>} job @returns {Promise<T>} */
  const enqueueNotices = (job) => {
    const run = noticesQueueTail.then(job, job);
    noticesQueueTail = run.then(() => undefined, () => undefined);
    return run;
  };

  /** @returns {Promise<Record<string, unknown[]>>} fail-safe normalized */
  const loadPending = async () => {
    const raw = await storage.get(PENDING_NOTICES_KEY).catch(() => null);
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? /** @type {Record<string, unknown[]>} */ (raw)
      : {};
  };

  /**
   * Park one notice for a session's next turn (+ the immediate user note).
   * Routed through resolveNoticeSession (outside the queue slot); fail-safe
   * normalization on a corrupted pending store (a torn write can leave a
   * primitive here — treat it as empty and repair by overwrite). Used by
   * init() for reconcile notifications and by the shell for engine reaps.
   *
   * @param {string} operationSessionId
   * @param {{ recoveryRecord: Record<string, unknown>, user: string }} notice
   */
  const parkNotice = async (operationSessionId, { recoveryRecord, user }) => {
    const sessionId = await Promise.resolve(
      resolveNoticeSession?.(operationSessionId) ?? operationSessionId,
    ).catch(() => operationSessionId) || operationSessionId;
    await enqueueNotices(async () => {
      const pending = await loadPending();
      const list = Array.isArray(pending[sessionId]) ? pending[sessionId] : [];
      list.push({ recoveryRecord, user, at: now() });
      pending[sessionId] = list.slice(-MAX_NOTICES_PER_SESSION);
      await storage.set(PENDING_NOTICES_KEY, pending).catch(() => {});
    });
    try { notify?.(sessionId, user); } catch { /* panel gone */ }
  };

  /**
   * Run the §5.3 startup sequence. Idempotent per SW start; a repeated call
   * mints a fresh generation and finds nothing left to settle.
   */
  const init = async () => {
    const previous = await storage.get(GENERATION_KEY).catch(() => undefined);
    const generation = mintGeneration(
      previous && typeof previous === 'object' ? previous : null,
      { nonce: nonce(), now: now() },
    );
    // Persist BEFORE reconciling: if we die mid-reconcile, the next boot
    // must still see this seq (monotonicity is what stale-authority
    // refusal keys on).
    await storage.set(GENERATION_KEY, generation);

    const records = await operationLog.listNonterminal();
    const plan = reconcileAtStartup({ records, generation });

    for (const transition of plan.transitions) {
      // Per-record isolation: one malformed record must not stop the rest
      // of the sweep from settling.
      await operationLog.settle(transition.operationId, transition.verdict)
        .catch(() => {});
    }

    if (appendAudit) {
      for (const entry of plan.auditEvents) {
        await Promise.resolve(appendAudit(entry)).catch(() => {});
      }
    }

    // Park + deliver the notifications. The pending store is what the NEXT
    // turn drains into the agent's context; notify() is the immediate
    // user-facing surface (a chat note) — best-effort, the durable copy is
    // the one that matters.
    // Surface any unknown-compaction evidence from prior sessions: the
    // discard of unresolved uncertainty is itself reported (§14), never
    // silent. Audited + parked for each affected session's next turn.
    const overflow = await operationLog.drainUnknownOverflow?.().catch(() => null);
    if (overflow) {
      if (appendAudit) {
        await Promise.resolve(appendAudit(lifecycleAuditEntry({
          event: LIFECYCLE_EVENTS.OUTCOME_UNKNOWN_OVERFLOW,
          detail: {
            droppedCount: overflow.droppedCount,
            oldestDroppedAt: overflow.oldestDroppedAt,
          },
        }))).catch(() => {});
      }
      const affected = Array.isArray(overflow.sessionsAffected)
        ? overflow.sessionsAffected : [];
      for (const sid of affected.slice(0, 8)) {
        await parkNotice(sid, {
          recoveryRecord: {
            operation: 'outcome_unknown_overflow',
            droppedCount: overflow.droppedCount,
            recoveryState: 'compacted',
          },
          user: `${overflow.droppedCount} unresolved operation record(s) with `
            + 'uncertain outcomes were compacted to bound storage. Verify the '
            + 'audit log or external state before repeating older actions.',
        }).catch(() => {});
      }
    }

    for (const notification of plan.notifications) {
      const { recoveryRecord } = notification;
      const transition = plan.transitions.find(
        (t) => t.operationId === recoveryRecord.operationId);
      const verdict = transition?.verdict;
      const user = verdict
        && (verdict.state === OPERATION_STATES.INTERRUPTED
          || verdict.state === OPERATION_STATES.OUTCOME_UNKNOWN)
        ? describeRecovery(verdict, { toolName: recoveryRecord.operation }).user
        : `${recoveryRecord.operation} was settled as ${recoveryRecord.recoveryState} after an interruption.`;
      await parkNotice(notification.sessionId, { recoveryRecord, user });
    }

    return { generation, plan };
  };

  /**
   * Drain a session's pending recovery notices into a context block for the
   * agent's next turn — read-and-clear, so a notice is delivered once. why
   * text and not raw JSON alone: the agent needs the same sentence the user
   * saw plus the structured record; both ride the block.
   *
   * @param {string} sessionId
   * @returns {Promise<string>} '' when nothing is pending
   */
  const drainNoticesFor = async (sessionId) => {
    if (!sessionId) return '';
    // The read-and-clear rides the same queue as park — a stale drain
    // write must never erase a notice parked between its read and write.
    const list = await enqueueNotices(async () => {
      const pending = await loadPending();
      const entry = pending[sessionId];
      if (!Array.isArray(entry) || entry.length === 0) return null;
      delete pending[sessionId];
      await storage.set(PENDING_NOTICES_KEY, pending).catch(() => {});
      return entry;
    }).catch(() => null);
    if (!list) return '';
    const lines = /** @type {Array<{ user: string, recoveryRecord: unknown }>} */ (list)
      .map((n) => `- ${n.user}\n  ${JSON.stringify(n.recoveryRecord)}`);
    return '<interruption-recovery>\nA previous browser session ended while '
      + 'work was in flight. Recovered operation states:\n'
      + `${lines.join('\n')}\n`
      + 'Do not repeat any operation marked outcome_unknown without verifying '
      + 'the external state first.\n</interruption-recovery>';
  };

  /**
   * §2.5 — explicit user cancellation dominates recovery: when a session is
   * deleted/archived, its pending notices are purged (a deleted chat's
   * operations must not resurrect as notes elsewhere) and its nonterminal
   * operations settle `cancelled` (the user ended the work; nothing may
   * auto-resume it at the next boot). Best-effort per record.
   *
   * @param {string} sessionId
   */
  const purgeSession = async (sessionId) => {
    if (!sessionId) return;
    await enqueueNotices(async () => {
      const pending = await loadPending();
      if (sessionId in pending) {
        delete pending[sessionId];
        await storage.set(PENDING_NOTICES_KEY, pending).catch(() => {});
      }
    }).catch(() => {});
    const open = await operationLog.listNonterminal().catch(() => []);
    for (const record of open.filter((r) => r.sessionId === sessionId)) {
      await operationLog.settle(record.operationId, {
        state: OPERATION_STATES.CANCELLED,
        autoRetry: false,
        retryRequires: [],
        keepIdempotencyKey: false,
        verificationRequired: false,
        recreateResource: false,
        reason: 'session deleted by the user; cancellation dominates recovery',
      }).catch(() => {});
    }
  };

  return { operationLog, init, drainNoticesFor, parkNotice, purgeSession };
};
