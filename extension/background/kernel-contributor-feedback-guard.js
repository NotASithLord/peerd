// @ts-check

const projectMessage = (/** @type {any} */ entry) => ({
  role: entry?.role === 'user' || entry?.role === 'assistant' ? entry.role : null,
  id: entry?.id,
  content: typeof entry?.content === 'string' && entry.content.length > 0 ? 'present' : '',
  synthetic: entry?.synthetic === true,
  streaming: entry?.streaming === true,
  error: entry?.error ? 'present' : null,
  stopReason: ['end_turn', 'aborted'].includes(entry?.stopReason) ? entry.stopReason : null,
  toolUses: Array.isArray(entry?.toolUses) ? entry.toolUses.map((/** @type {any} */ toolUse) => ({
    id: toolUse?.id,
    name: ['message_actor', 'actor_create'].includes(toolUse?.name) ? toolUse.name : null,
    input: { await: toolUse?.input?.await, sync: toolUse?.input?.sync },
  })) : [],
  actorReply: entry?.actorReply ? {
    parentToolUseId: entry.actorReply.parentToolUseId,
    parentToolUseIds: entry.actorReply.parentToolUseIds,
    correlationComplete: entry.actorReply.correlationComplete,
  } : null,
});

/**
 * Freeze feedback against the live turn/actor authorities before semantic
 * attribution receives a content-free transcript projection.
 * @param {any} message
 * @param {{load:()=>Promise<any>}} deps
 */
export const guardKernelContributorFeedback = async (message, { load }) => {
  const turn = await load().catch(() => null);
  const recoveryReady = typeof turn?.actorRecoveryReady === 'function'
    ? await turn.actorRecoveryReady().catch(() => false) : false;
  if (!recoveryReady) {
    return { ok: false, error: 'actor-recovery-pending', outcomeKnown: true };
  }
  if (typeof turn?.turnSlots?.isBusy !== 'function'
      || turn.turnSlots.isBusy(message.sessionId)
      || typeof turn?.actorMessaging?.hasInFlightFor !== 'function'
      || turn.actorMessaging.hasInFlightFor(message.sessionId)
      || typeof turn?.sessions?.get !== 'function') {
    return { ok: false, error: 'invalid-feedback-target', outcomeKnown: true };
  }
  const session = await turn.sessions.get(message.sessionId).catch(() => null);
  // why: an actor can settle and queue its parent reply while storage is read.
  if (turn.turnSlots.isBusy(message.sessionId)
      || turn.actorMessaging.hasInFlightFor(message.sessionId)
      || !session || session.kind === 'actor' || session.kind === 'spawned') {
    return { ok: false, error: 'invalid-feedback-target', outcomeKnown: true };
  }
  return {
    ok: true,
    messages: (Array.isArray(session.messages) ? session.messages : []).map(projectMessage),
  };
};
