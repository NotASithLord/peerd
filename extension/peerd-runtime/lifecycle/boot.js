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
    if (plan.notifications.length > 0) {
      const pending = (await storage.get(PENDING_NOTICES_KEY).catch(() => null)) ?? {};
      for (const notification of plan.notifications) {
        const { recoveryRecord } = notification;
        // Route to the session that will actually take a next turn. A
        // failed resolution falls back to the operation's own session —
        // a possibly-undrained notice beats a lost one.
        const sessionId = await Promise.resolve(
          resolveNoticeSession?.(notification.sessionId) ?? notification.sessionId,
        ).catch(() => notification.sessionId) || notification.sessionId;
        const transition = plan.transitions.find(
          (t) => t.operationId === recoveryRecord.operationId);
        const verdict = transition?.verdict;
        const user = verdict
          && (verdict.state === OPERATION_STATES.INTERRUPTED
            || verdict.state === OPERATION_STATES.OUTCOME_UNKNOWN)
          ? describeRecovery(verdict, { toolName: recoveryRecord.operation }).user
          : `${recoveryRecord.operation} was settled as ${recoveryRecord.recoveryState} after an interruption.`;
        const list = Array.isArray(pending[sessionId]) ? pending[sessionId] : [];
        list.push({ recoveryRecord, user, at: now() });
        pending[sessionId] = list.slice(-MAX_NOTICES_PER_SESSION);
        try { notify?.(sessionId, user); } catch { /* panel gone */ }
      }
      await storage.set(PENDING_NOTICES_KEY, pending).catch(() => {});
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
    const pending = (await storage.get(PENDING_NOTICES_KEY).catch(() => null)) ?? {};
    const list = pending[sessionId];
    if (!Array.isArray(list) || list.length === 0) return '';
    delete pending[sessionId];
    await storage.set(PENDING_NOTICES_KEY, pending).catch(() => {});
    const lines = list.map((/** @type {{ user: string, recoveryRecord: unknown }} */ n) =>
      `- ${n.user}\n  ${JSON.stringify(n.recoveryRecord)}`);
    return '<interruption-recovery>\nA previous browser session ended while '
      + 'work was in flight. Recovered operation states:\n'
      + `${lines.join('\n')}\n`
      + 'Do not repeat any operation marked outcome_unknown without verifying '
      + 'the external state first.\n</interruption-recovery>';
  };

  return { operationLog, init, drainNoticesFor };
};
