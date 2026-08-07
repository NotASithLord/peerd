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
 * @param {string} deps.channel
 * @returns {Record<string, Function>}
 */
export const makeContributorRoutes = (deps) => {
  const {
    contributorStore, sessions, isActualOptionsSender, isActualSidepanelSender,
    isActualHomeSender, isSessionBusy, hasInFlightFor, channel,
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
    // A tool-use step is pushed before dispatch, so message persistence alone
    // cannot prove that the answer is final. The live slot is authoritative;
    // fail closed if the dependency is absent or this chat is still running.
    if (typeof isSessionBusy !== 'function' || isSessionBusy(msg.sessionId)
        || typeof hasInFlightFor !== 'function' || hasInFlightFor(msg.sessionId)) {
      return { ok: false, error: 'invalid-feedback-target' };
    }
    const session = await sessions.get(msg.sessionId).catch(() => null);
    if (!session || session.kind === 'actor' || session.kind === 'spawned') {
      return { ok: false, error: 'invalid-feedback-target' };
    }
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const targetIndex = messages.findIndex((/** @type {any} */ message) =>
      message?.id === msg.messageId && message?.role === 'assistant'
        && typeof message?.content === 'string' && message.content.length > 0
        && message?.streaming !== true && !message?.error
        && (!Array.isArray(message?.toolUses) || message.toolUses.length === 0)
        && message?.stopReason === 'end_turn');
    if (targetIndex < 0) return { ok: false, error: 'invalid-feedback-target' };
    const laterInTurn = messages.slice(targetIndex + 1).find((/** @type {any} */ message) => {
      const nextHumanTurn = message?.role === 'user' && message?.synthetic !== true
        && typeof message?.content === 'string' && message.content.length > 0;
      return nextHumanTurn || message?.role === 'assistant';
    });
    if (laterInTurn?.role === 'assistant') {
      return { ok: false, error: 'invalid-feedback-target' };
    }
    let turnStart = targetIndex - 1;
    while (turnStart >= 0) {
      const candidate = messages[turnStart];
      if (candidate?.role === 'user' && candidate?.synthetic !== true
          && typeof candidate?.content === 'string' && candidate.content.length > 0) break;
      turnStart -= 1;
    }
    const humanTurn = messages[turnStart];
    if (turnStart < 0 || typeof humanTurn?.id !== 'string' || humanTurn.id.length === 0) {
      return { ok: false, error: 'invalid-feedback-target' };
    }
    const contextKeys = messages.slice(turnStart + 1, targetIndex + 1)
      .flatMap((/** @type {any} */ message) => Array.isArray(message?.toolUses) ? message.toolUses : [])
      .map((/** @type {any} */ toolUse) => typeof toolUse?.id === 'string'
        ? `${msg.sessionId}:${toolUse.id}`
        : null)
      .filter(Boolean);
    const result = await contributorStore.recordFeedback({
      // A provider retry may replace the final assistant record while the real
      // human turn remains the same. Pinning to that user message preserves one
      // idempotent verdict for the task instead of one vote per generated reply.
      selectionKey: `${msg.sessionId}:${humanTurn.id}`,
      verdict: msg.verdict,
      candidateContextKeys: contextKeys,
    });
    return { ok: true, ...result };
  },
  });
};
