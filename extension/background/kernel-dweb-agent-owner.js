// @ts-check

import { makeDwebInboundRateCap } from './dweb-inbound-rate-cap.js';

export const DWEB_AGENT_ROOM = 'peerd-agent';
const NO_REPORT = 'NO_REPORT';

/** @param {Record<string,any>} deps */
export const createKernelDwebAgentOwner = (deps) => {
  if (!deps?.meshDispatch || !deps.conversations || !deps.turnSlots
      || typeof deps.active !== 'function' || typeof deps.runActorTurn !== 'function') {
    throw new TypeError('kernel-dweb-agent-config-invalid');
  }
  const { allow } = deps.rateCap ?? makeDwebInboundRateCap();
  /** @type {Map<string,Promise<void>>} */
  const conversationTails = new Map();
  let roomJoined = false;
  let wakeSequence = 0;

  const enabled = () => deps.active() && !deps.isLocked();
  const appendAudit = (/** @type {any} */ event) => {
    deps.appendAudit(event).catch(() => {});
  };
  const ordered = (/** @type {string} */ conversationId,
    /** @type {()=>Promise<void>} */ operation) => {
    const previous = conversationTails.get(conversationId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    conversationTails.set(conversationId, tail);
    void tail.finally(() => {
      if (conversationTails.get(conversationId) === tail) conversationTails.delete(conversationId);
    });
    return result;
  };

  const syncRoom = async () => {
    if (!enabled()) {
      if (!roomJoined) return;
      roomJoined = false;
      await deps.sendMessage({
        type: 'dweb/base-host/room', roomId: DWEB_AGENT_ROOM, op: 'leave',
      }).catch(() => {});
      return;
    }
    if (roomJoined) return;
    const response = await deps.withPublication(async (/** @type {()=>boolean} */ current) => {
      if (!current() || !enabled() || roomJoined) return null;
      await deps.ensureFeature();
      return deps.sendMessage({
        type: 'dweb/base-host/room', roomId: DWEB_AGENT_ROOM,
        op: 'join', name: 'peerd agent',
      });
    }).catch(() => null);
    if (response?.ok && enabled()) roomJoined = true;
  };

  const revokePeer = async (/** @type {string} */ did) => {
    if (deps.approvedDids?.delete(did)) await deps.persistApproved?.();
    deps.conversations.closeDid(did);
  };

  const handleInbound = (/** @type {{from?:string,data?:unknown}} */ event) => {
    if (!enabled()) return;
    const did = typeof event?.from === 'string' ? event.from : 'unknown';
    const routed = deps.meshDispatch.handleInbound(did, event?.data);
    if (routed.consumed) return;
    if (!allow(did)) {
      appendAudit({ type: 'dweb_agent_rate_capped', details: { did } });
      return;
    }
    const delivery = routed.deliver;
    const rawConversationId = typeof delivery?.convId === 'string' ? delivery.convId : null;
    const conversationId = rawConversationId && rawConversationId.length <= 128
      ? rawConversationId : null;
    let ownsConversation = false;
    if (conversationId && delivery) {
      deps.conversations.adopt(conversationId, did);
      ownsConversation = deps.conversations.ownedBy(conversationId, did);
    }
    const canReply = ownsConversation && delivery?.kind === 'ask';
    const body = typeof event?.data === 'string'
      ? event.data : JSON.stringify(event?.data ?? null);
    appendAudit({
      type: 'dweb_agent_inbound',
      details: { did, chars: body.length, ...(conversationId ? { convId: conversationId } : {}) },
    });
    const recoveryKey = `dweb-inbound:${++wakeSequence}`;
    const wake = async () => {
      await deps.isolationReady();
      if (!enabled()) return;
      if (!deps.isolationAvailable()) {
        appendAudit({
          type: 'dweb_agent_inbound_dropped',
          details: { did, reason: 'actor_isolation_unavailable', performed: false },
        });
        return;
      }
      await deps.runWhenRecoveryReady(recoveryKey, async () => {
        if (!enabled()) return;
        /** @type {Array<{role:'peer'|'self',message:string,ts:number}>} */
        let priorTurns = [];
        if (ownsConversation && conversationId && delivery) {
          if (!deps.conversations.ownedBy(conversationId, did)) return;
          priorTurns = deps.conversations.turnsFor(conversationId);
          deps.conversations.record(conversationId, 'peer', delivery.message);
        }
        const actor = await deps.resolveActor();
        if (!actor || !enabled()) return;
        const fenced = deps.wrapUntrusted({
          origin: did, tool: 'mesh_inbound', body: body.slice(0, 16 * 1024),
        });
        const thread = priorTurns.length
          ? `\n\nEarlier turns in this conversation (oldest first):\n${deps.wrapUntrusted({
            origin: did, tool: 'mesh_thread',
            body: priorTurns.map((turn) => `${turn.role === 'self' ? 'you' : 'peer'}: ${turn.message}`).join('\n'),
          })}` : '';
        const prompt = canReply
          ? `A mesh peer is having an ongoing conversation with your agent (their did is in the fence origin). Read their latest message and the thread, then END with either ${NO_REPORT} or a one-paragraph reply to send back to the PEER.${thread}\n\n${fenced}`
          : `A mesh peer sent your agent a direct message (their did is in the fence origin). Observe it, update your ledger, block if abusive, and END with either ${NO_REPORT} or a one-paragraph note for the user.\n\n${fenced}`;
        await new Promise((resolve) => {
          deps.turnSlots.runWhenIdleClaimed(actor.actorSessionId, (/** @type {any} */ lease) => {
            void (async () => {
              const before = ((await deps.sessions.get(actor.actorSessionId))?.messages ?? []).length;
              const result = await deps.runActorTurn({
                actorSessionId: actor.actorSessionId, message: prompt,
                instanceId: 'dweb', kind: 'dweb', oneShot: false,
                inbound: true, turnLease: lease,
              });
              if (result?.stopped) return;
              const messages = result?.turnSnapshot?.messages ?? [];
              const note = result?.result
                ?? deps.finalAssistantText({ messages: messages.slice(before) }) ?? '';
              if (!note.trim() || note.includes(NO_REPORT)) return;
              if (canReply) {
                const id = /** @type {string} */ (conversationId);
                const consented = await deps.confirmReply(id, did, actor.actorSessionId);
                if (consented && enabled() && deps.conversations.ownedBy(id, did)) {
                  const sent = await deps.meshDispatch.reply(did, delivery.reqId, note, id);
                  if (sent?.ok === true) {
                    deps.conversations.record(id, 'self', note);
                    appendAudit({ type: 'a2a_reply_sent', details: { did, convId: id } });
                    return;
                  }
                  appendAudit({
                    type: 'a2a_reply_failed',
                    details: {
                      did, convId: id, error: sent?.error ?? 'mesh send failed',
                      ...(typeof sent?.performed === 'boolean'
                        ? { performed: sent.performed } : {}),
                      ...(typeof sent?.outcomeKnown === 'boolean'
                        ? { outcomeKnown: sent.outcomeKnown } : {}),
                      ...(typeof sent?.outcomeKind === 'string'
                        ? { outcomeKind: sent.outcomeKind } : {}),
                      ...(typeof sent?.retryable === 'boolean'
                        ? { retryable: sent.retryable } : {}),
                    },
                  });
                }
              }
              const activeSessionId = await deps.currentSessionId();
              if (!activeSessionId) return;
              const userText = `Your dweb agent flagged inbound mesh activity:\n\n${deps.wrapUntrusted({
                origin: 'dweb', tool: 'message_actor', body: note,
              })}`;
              const generation = deps.turnSlots.generation(activeSessionId);
              deps.turnSlots.runWhenIdleClaimed(activeSessionId, (/** @type {any} */ parentLease) => {
                if (deps.turnSlots.generation(activeSessionId) !== generation) {
                  parentLease.release();
                  return;
                }
                void deps.runAgentTurn({
                  sessionId: activeSessionId, userText, synthetic: true, trusted: false,
                  actorReply: { kind: 'dweb', instanceId: 'dweb', failed: false },
                  turnLease: parentLease,
                }).catch(() => {}).finally(() => parentLease.release());
              });
            })().catch(() => {}).finally(() => {
              lease.release();
              resolve(undefined);
            });
          });
        });
      });
    };
    const operation = ownsConversation && conversationId
      ? ordered(conversationId, wake) : wake();
    void operation.catch(() => {});
  };

  const onMessage = (/** @type {any} */ message, /** @type {any} */ sender) => {
    if (!deps.isOffscreenSender(sender)
        || message?.type !== 'dweb/base-room/event'
        || message.roomId !== DWEB_AGENT_ROOM || message.event !== 'direct') return false;
    handleInbound(message.data ?? {});
    return false;
  };

  return Object.freeze({
    onMessage, handleInbound, syncRoom, revokePeer,
    roomStopped: () => { roomJoined = false; },
    roomJoined: () => roomJoined,
  });
};
