// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// message_actor — talk to the agent that OWNS a tab-hosted instance.
//
// DESIGN-17: each WebVM / Notebook / App is driven by an ACTOR (a per-instance
// agent that exclusively holds that environment's tools). The main agent no
// longer mutates an instance by id; it messages the instance's actor, which
// does the work in its own focused context and replies on a later turn. Thin
// wrapper — the mailbox / sender-gate / runaway-guard / correlation all live in
// actor/actor-messaging.js (bound + injected as ctx.messageActor by the
// SW). The exposure gate refuses this tool on an actor session, so an actor
// can't recursively message another actor.

// why a wall-clock cap on the orchestrator's opt-in await: the orchestrator's
// turn has NO timeout of its own (only user Stop), so a slow or hung web
// delegation awaited in-band would block the turn indefinitely. At the cap the
// await DEGRADES TO ASYNC — the actor is NOT cancelled, it keeps working and its
// reply lands as the usual later-turn fenced note — so the user gets a prompt
// "still working" answer instead of a frozen turn. A few minutes: long enough
// that most primary web tasks resolve in-band, short enough to never read as
// hung. Ephemeral children don't use this — their awaitSignal is their own
// wall-clock cap, and they have no later turn to degrade to.
const ORCHESTRATOR_AWAIT_CAP_MS = 3 * 60_000;

/**
 * The ctx slot message_actor reads (an SW-injected extra, not on the base
 * ToolContext contract).
 * @typedef {Object} MessageActorCtx
 * @property {(req: { to: string, message: string, senderSessionId?: string|null, inbound?: boolean, toolUseId?: string, oneShot?: boolean, awaitReply?: boolean, awaitSignal?: any, degradeToAsync?: boolean, awaitCapMs?: number }) => Promise<{ ok: boolean, content?: string, error?: string, structured?: Record<string, unknown>, outcomeKind?: 'pre-effect-failure', actorDeliveryId?: string, actorCorrelationId?: string, actorTerminal?: boolean, actorOutcomeKnown?: boolean, actorPerformed?: boolean, actorAborted?: boolean }>} [messageActor]
 * @property {{ sessionId?: string, kind?: string }} [session]
 * @property {boolean} [inbound]
 * @property {string} [toolUseId]
 * @property {{ aborted: boolean, addEventListener: Function, removeEventListener?: Function }} [abortSignal]
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const messageActorTool = composeTool("message_actor", {

  execute: async (args, ctx) => {
    const c = /** @type {MessageActorCtx} */ (/** @type {unknown} */ (ctx));
    if (typeof c.messageActor !== 'function') {
      // Flag off / not wired — fail closed (the gate also refuses by name).
      return { ok: false, error: 'message_actor is not enabled' };
    }
    const res = await c.messageActor({
      to: args?.to,
      message: args?.message,
      // one round suffices (concrete command / read) → the actor returns its raw
      // result without a summarize turn. The loop falls back to a full turn on error.
      oneShot: args?.oneShot === true,
      senderSessionId: c.session?.sessionId,
      // The sender gate keys on this — an untrusted-origin (inbound) turn is
      // refused. ctx.inbound = synthetic && !trusted (folded by the turn driver):
      // a goal continuation or an actor reply-wake is trusted → not inbound.
      inbound: c.inbound === true,
      // DESIGN-17 P1 glass pane: THIS tool call's id (SW-injected into ctx, the
      // same thread actor_create uses) keys the actor's live display stream
      // to this card, so its work renders inline like an actor transcript.
      toolUseId: c.toolUseId,
      // The actor reply mode. An ephemeral child ALWAYS awaits: it has no later
      // turn for the reply-wake to re-enter (PR #134; waking its session would
      // rebuild it on the main exposure surface). The orchestrator OPTS IN with
      // await:true for a single primary task, so it answers the user with the
      // substance THIS turn instead of a deferral — its awaited reply races the
      // turn's abort signal (below) so Stop / the turn timeout unwinds it.
      // Either way the reply resolves INTO this tool result, still wrapUntrusted-fenced.
      awaitReply: c.session?.kind === 'spawned' || args?.await === true,
      // The caller's abort signal: spawn.js threads the child's; the turn-driver
      // threads the orchestrator's turn signal. Lets an awaited reply race the
      // caller's wall-clock timeout / Stop / cancel, so a hung actor turn can't
      // park the await past its budget (#1/#3).
      awaitSignal: c.abortSignal,
      // The orchestrator opt-in (await:true from a NON-ephemeral sender) gets a
      // wall-clock cap that DEGRADES TO ASYNC — its turn signal has no timeout of
      // its own, so without this a slow web delegation would block the turn until
      // Stop. Gated to a long-lived sender: an ephemeral child (kind:'spawned')
      // has no later turn to degrade to, so it keeps the abort-only semantics and
      // relies on its own wall-clock awaitSignal.
      degradeToAsync: args?.await === true && c.session?.kind !== 'spawned',
      awaitCapMs: ORCHESTRATOR_AWAIT_CAP_MS,
    });
    // Keep the internal delivery id until the caller's tool-result message is
    // durably appended. The session store acknowledges the mailbox only after
    // that commit, closing the crash window without exposing the id to the model.
    const raw = /** @type {any} */ (res);
    const actorHostState = {
      ...(res.actorCorrelationId ? { actorCorrelationId: res.actorCorrelationId } : {}),
      ...(typeof res.actorTerminal === 'boolean'
        ? { actorTerminal: res.actorTerminal }
        : res.ok ? {} : { actorTerminal: true }),
      ...(typeof res.actorOutcomeKnown === 'boolean'
        ? { actorOutcomeKnown: res.actorOutcomeKnown }
        : res.ok ? {} : { actorOutcomeKnown: raw.outcomeKnown !== false }),
      ...(typeof res.actorPerformed === 'boolean'
        ? { actorPerformed: res.actorPerformed }
        : typeof raw.performed === 'boolean' ? { actorPerformed: raw.performed } : {}),
      ...(res.actorAborted === true ? { actorAborted: true } : {}),
    };
    return res.ok
      ? {
        ok: true,
        content: res.content ?? 'message delivered',
        ...actorHostState,
        ...(res.actorDeliveryId ? { actorDeliveryId: res.actorDeliveryId } : {}),
      }
      : {
        ok: false,
        error: res.error ?? 'message_actor failed',
        ...(res.content ? { content: res.content } : {}),
        ...(res.structured ? { structured: res.structured } : {}),
        ...(res.outcomeKind
          ? { outcomeKind: res.outcomeKind }
          : actorHostState.actorPerformed === false
            ? { outcomeKind: /** @type {const} */ ('pre-effect-failure') }
            : {}),
        ...actorHostState,
        ...(res.actorDeliveryId ? { actorDeliveryId: res.actorDeliveryId } : {}),
      };
  },
});
