// @ts-check

import { structuredClonePayloadFits } from '/shared/structured-clone-size.js';

export const CONTRIBUTOR_FEEDBACK_MAX_MESSAGES = 256;
export const CONTRIBUTOR_FEEDBACK_MAX_TOOL_USES = 512;
export const CONTRIBUTOR_FEEDBACK_MAX_IDS_PER_REPLY = 128;
export const CONTRIBUTOR_FEEDBACK_MAX_ID_CHARS = 200;
export const CONTRIBUTOR_FEEDBACK_MAX_PROJECTION_BYTES = 64 * 1024;

/** @param {unknown} value @param {boolean} [nullable] */
const boundedId = (value, nullable = false) => nullable && value == null
  ? null
  : typeof value === 'string' && value.length > 0
      && value.length <= CONTRIBUTOR_FEEDBACK_MAX_ID_CHARS ? value : undefined;

/** @param {unknown} input */
const projectMessages = (input) => {
  if (!Array.isArray(input) || input.length > CONTRIBUTOR_FEEDBACK_MAX_MESSAGES) return null;
  let toolUseCount = 0;
  const projected = [];
  for (const entry of input) {
    const toolUses = Array.isArray(entry?.toolUses) ? entry.toolUses : [];
    toolUseCount += toolUses.length;
    if (toolUseCount > CONTRIBUTOR_FEEDBACK_MAX_TOOL_USES) return null;
    const projectedTools = [];
    for (const toolUse of toolUses) {
      const id = boundedId(toolUse?.id, true);
      if (id === undefined) return null;
      projectedTools.push({
        id,
        name: ['message_actor', 'actor_create'].includes(toolUse?.name) ? toolUse.name : null,
        input: { await: toolUse?.input?.await === true, sync: toolUse?.input?.sync === true },
      });
    }
    let actorReply = null;
    if (entry?.actorReply) {
      const parentToolUseId = boundedId(entry.actorReply.parentToolUseId, true);
      const rawIds = Array.isArray(entry.actorReply.parentToolUseIds)
        ? entry.actorReply.parentToolUseIds : [];
      if (parentToolUseId === undefined
          || rawIds.length > CONTRIBUTOR_FEEDBACK_MAX_IDS_PER_REPLY) return null;
      const parentToolUseIds = [];
      for (const value of rawIds) {
        const id = boundedId(value);
        if (id === undefined) return null;
        parentToolUseIds.push(id);
      }
      actorReply = {
        parentToolUseId,
        parentToolUseIds,
        correlationComplete: entry.actorReply.correlationComplete !== false,
      };
    }
    const id = boundedId(entry?.id, true);
    if (id === undefined) return null;
    projected.push({
      role: entry?.role === 'user' || entry?.role === 'assistant' ? entry.role : null,
      id,
      content: typeof entry?.content === 'string' && entry.content.length > 0 ? 'present' : '',
      synthetic: entry?.synthetic === true,
      streaming: entry?.streaming === true,
      error: entry?.error ? 'present' : null,
      stopReason: ['end_turn', 'aborted'].includes(entry?.stopReason) ? entry.stopReason : null,
      toolUses: projectedTools,
      actorReply,
    });
  }
  return structuredClonePayloadFits(projected, CONTRIBUTOR_FEEDBACK_MAX_PROJECTION_BYTES)
    ? projected : null;
};

/**
 * Freeze feedback against the live turn/actor authorities before semantic
 * attribution receives a content-free transcript projection.
 * @param {any} message
 * @param {{load:()=>Promise<any>}} deps
 */
export const guardKernelContributorFeedback = async (message, { load }) => {
  if (boundedId(message?.sessionId) === undefined || boundedId(message?.messageId) === undefined) {
    return { ok: false, error: 'invalid-feedback-target', outcomeKnown: true };
  }
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
  const messages = projectMessages(session.messages);
  return messages
    ? { ok: true, messages }
    : { ok: false, error: 'feedback-projection-too-large', outcomeKnown: true };
};
