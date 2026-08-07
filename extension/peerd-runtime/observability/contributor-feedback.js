// @ts-check
// Pure task-attribution core for the optional Contributor Metrics feedback UI.
// Async actor replies can land after a newer human turn, so nearest-message
// heuristics are not enough: the reply carries its parent tool-use identity and
// this fold routes the later terminal answer back to the task that launched it.

/** @param {any} message */
const isHumanTurn = (message) => message?.role === 'user'
  && message?.synthetic !== true
  && typeof message?.id === 'string'
  && message.id.length > 0
  && typeof message?.content === 'string'
  && message.content.length > 0;

/** @param {any} message */
const isTerminalAssistant = (message) => message?.role === 'assistant'
  && typeof message?.id === 'string'
  && typeof message?.content === 'string'
  && message.content.length > 0
  && message?.streaming !== true
  && !message?.error
  && (!Array.isArray(message?.toolUses) || message.toolUses.length === 0)
  && message?.stopReason === 'end_turn';

/**
 * Return the terminal feedback targets keyed by assistant message id.
 * Each value identifies the real human task and every tool context folded into
 * it, including late correlated actor-reply continuations.
 *
 * @param {unknown} input
 * @returns {Map<string, { humanMessageId: string, toolUseIds: string[] }>}
 */
export const contributorFeedbackTargets = (input) => {
  const messages = Array.isArray(input) ? input : [];
  /** @typedef {{ humanMessageId: string, toolUseIds: Set<string>, pendingActorIds: Set<string>, receivedActorIds: Set<string>, finalAssistantId: string|null }} Task */
  /** @type {Task[]} */
  const tasks = [];
  // null means the provider reused one tool-use id across tasks. A later reply
  // carrying that id is ambiguous and must take the uncorrelated fail-closed
  // path rather than deterministically attaching to whichever task wrote last.
  /** @type {Map<string, Task|null>} */
  const taskByToolUseId = new Map();
  /** @type {Task|null} */
  let currentTask = null;
  /** @type {Task|null} */
  let actorReplyTask = null;
  let unattributedActorReply = false;

  for (const message of messages) {
    if (isHumanTurn(message)) {
      currentTask = {
        humanMessageId: message.id,
        toolUseIds: new Set(), pendingActorIds: new Set(), receivedActorIds: new Set(),
        finalAssistantId: null,
      };
      tasks.push(currentTask);
      actorReplyTask = null;
      unattributedActorReply = false;
      continue;
    }

    if (message?.role === 'user' && message?.synthetic === true && message?.actorReply) {
      const parentToolUseIds = [...new Set([
        ...(typeof message.actorReply.parentToolUseId === 'string'
          ? [message.actorReply.parentToolUseId] : []),
        ...(Array.isArray(message.actorReply.parentToolUseIds)
          ? message.actorReply.parentToolUseIds.filter((/** @type {unknown} */ id) => typeof id === 'string') : []),
      ].filter((id) => id.length > 0))];
      const replyTasks = parentToolUseIds.map((id) => taskByToolUseId.get(id) ?? null);
      const firstReplyTask = replyTasks[0] ?? null;
      const correlationComplete = message.actorReply.correlationComplete !== false
        && parentToolUseIds.length > 0
        && firstReplyTask !== null
        && replyTasks.every((task) => task === firstReplyTask);
      actorReplyTask = correlationComplete ? firstReplyTask : null;
      unattributedActorReply = actorReplyTask === null;
      if (unattributedActorReply) {
        // Legacy/recovery rows without a parent identity cannot be attributed
        // safely. Suppress every earlier candidate rather than guessing the
        // nearest human turn and poisoning a task label.
        for (const task of tasks) task.finalAssistantId = null;
      }
      if (actorReplyTask) {
        for (const parentToolUseId of parentToolUseIds) {
          actorReplyTask.receivedActorIds.add(parentToolUseId);
        }
        // The pre-reply assistant text was only an async-delivery acknowledgement;
        // once the receipt arrives it cannot remain the task's terminal answer.
        actorReplyTask.finalAssistantId = null;
      }
      continue;
    }

    if (message?.role !== 'assistant') continue;
    const owner = unattributedActorReply ? null : (actorReplyTask ?? currentTask);
    if (!owner) continue;
    for (const toolUse of Array.isArray(message.toolUses) ? message.toolUses : []) {
      if (typeof toolUse?.id !== 'string' || toolUse.id.length === 0) continue;
      owner.toolUseIds.add(toolUse.id);
      const existingOwner = taskByToolUseId.get(toolUse.id);
      if (existingOwner && existingOwner !== owner) taskByToolUseId.set(toolUse.id, null);
      else if (!taskByToolUseId.has(toolUse.id)) taskByToolUseId.set(toolUse.id, owner);
      const asynchronousActorCall = (toolUse?.name === 'message_actor' && toolUse?.input?.await !== true)
        || (toolUse?.name === 'actor_create' && toolUse?.input?.sync !== true);
      if (asynchronousActorCall) {
        owner.pendingActorIds.add(toolUse.id);
        owner.finalAssistantId = null;
      }
    }
    if (isTerminalAssistant(message)) {
      owner.finalAssistantId = message.id;
      if (actorReplyTask || unattributedActorReply) {
        actorReplyTask = null;
        unattributedActorReply = false;
      }
    }
  }

  const targets = new Map();
  for (const task of tasks) {
    if (!task.finalAssistantId) continue;
    const waiting = [...task.pendingActorIds]
      .some((toolUseId) => !task.receivedActorIds.has(toolUseId));
    if (waiting) continue;
    targets.set(task.finalAssistantId, {
      humanMessageId: task.humanMessageId,
      toolUseIds: [...task.toolUseIds],
    });
  }
  return targets;
};
