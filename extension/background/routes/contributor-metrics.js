// @ts-check
// Human-only Contributor Metrics routes. These are deliberately outside the
// generic settings route: backup/import must not carry consent, and first-party
// engine pages must not inherit a human participation/feedback capability.

/**
 * @param {Object} deps
 * @param {{ status: Function, enable: Function, disableAndClear: Function, recordFeedback: Function }} deps.contributorStore
 * @param {{ get: (sessionId: string) => Promise<any> }} deps.sessions
 * @param {(sender: unknown) => boolean} deps.isActualOptionsSender
 * @param {(sender: unknown) => boolean} deps.isActualSidepanelSender
 * @param {(sender: unknown) => boolean} deps.isActualHomeSender
 * @param {(sessionId: string) => boolean} deps.isSessionBusy
 * @param {(rootSessionId: string) => boolean} deps.hasInFlightFor
 * @param {() => Promise<boolean>} deps.actorRecoveryReady
 * @param {(messages: unknown) => Map<string, { humanMessageId: string, toolUseIds: string[] }>} deps.contributorFeedbackTargets
 * @param {string} deps.channel
 * @returns {Record<string, Function>}
 */
export const makeContributorRoutes = (deps) => {
  const {
    contributorStore, sessions, isActualOptionsSender, isActualSidepanelSender,
    isActualHomeSender, isSessionBusy, hasInFlightFor, actorRecoveryReady,
    contributorFeedbackTargets, channel,
  } = deps;
  // Store/web builds retain their existing no-contribution posture. Returning
  // no handlers is stronger than a UI-only gate: another first-party page
  // cannot discover or invoke the local consent surface by guessing route names.
  if (channel !== 'preview' && channel !== 'dev') return Object.freeze({});
  return ({
  'contributor/status': async (_msg = {}, /** @type {unknown} */ sender = undefined) =>
    isActualOptionsSender(sender)
      ? { ok: true, status: await contributorStore.status() }
      : { ok: false, error: 'trusted-options-sender-required' },

  'contributor/enable': async (_msg = {}, /** @type {unknown} */ sender = undefined) =>
    isActualOptionsSender(sender)
      ? { ok: true, status: await contributorStore.enable() }
      : { ok: false, error: 'trusted-options-sender-required' },

  'contributor/disable': async (_msg = {}, /** @type {unknown} */ sender = undefined) =>
    isActualOptionsSender(sender)
      ? { ok: true, status: await contributorStore.disableAndClear() }
      : { ok: false, error: 'trusted-options-sender-required' },

  'contributor/feedback': async (/** @type {any} */ msg = {}, /** @type {unknown} */ sender = undefined) => {
    if (!isActualSidepanelSender(sender) && !isActualHomeSender(sender)) {
      return { ok: false, error: 'trusted-chat-sender-required' };
    }
    if (msg.verdict !== 'worked' && msg.verdict !== 'didnt_work') {
      return { ok: false, error: 'invalid-feedback' };
    }
    if (typeof msg.sessionId !== 'string' || typeof msg.messageId !== 'string') {
      return { ok: false, error: 'invalid-feedback-target' };
    }
    // A background restart clears the live actor counters before durable
    // mailbox recovery has written its passive receipts. Fail closed during
    // that window so an old assistant answer cannot be labeled final first.
    if (typeof actorRecoveryReady !== 'function' || !(await actorRecoveryReady())) {
      return { ok: false, error: 'actor-recovery-pending' };
    }
    // A tool-use step is pushed before dispatch, so message persistence alone
    // cannot prove that the answer is final. The live slot is authoritative;
    // fail closed if the dependency is absent or this chat is still running.
    if (typeof isSessionBusy !== 'function' || isSessionBusy(msg.sessionId)
        || typeof hasInFlightFor !== 'function' || hasInFlightFor(msg.sessionId)) {
      return { ok: false, error: 'invalid-feedback-target' };
    }
    const session = await sessions.get(msg.sessionId).catch(() => null);
    // Recheck after the storage await: an actor can settle and queue/claim its
    // parent reply while the session read is in flight.
    if (isSessionBusy(msg.sessionId) || hasInFlightFor(msg.sessionId)) {
      return { ok: false, error: 'invalid-feedback-target' };
    }
    if (!session || session.kind === 'actor' || session.kind === 'spawned') {
      return { ok: false, error: 'invalid-feedback-target' };
    }
    const messages = Array.isArray(session.messages) ? session.messages : [];
    if (typeof contributorFeedbackTargets !== 'function') {
      return { ok: false, error: 'invalid-feedback-target' };
    }
    const target = contributorFeedbackTargets(messages).get(msg.messageId);
    if (!target) return { ok: false, error: 'invalid-feedback-target' };
    const contextKeys = target.toolUseIds.map((toolUseId) => `${msg.sessionId}:${toolUseId}`);
    const result = await contributorStore.recordFeedback({
      // A provider retry may replace the final assistant record while the real
      // human turn remains the same. Pinning to that user message preserves one
      // idempotent verdict for the task instead of one vote per generated reply.
      selectionKey: `${msg.sessionId}:${target.humanMessageId}`,
      verdict: msg.verdict,
      candidateContextKeys: contextKeys,
    });
    return { ok: true, ...result };
  },
  });
};
