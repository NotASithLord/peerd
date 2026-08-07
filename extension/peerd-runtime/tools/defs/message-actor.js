// @ts-check
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
 * @property {(req: { to: string, message: string, senderSessionId?: string|null, inbound?: boolean, toolUseId?: string, oneShot?: boolean, awaitReply?: boolean, awaitSignal?: any, degradeToAsync?: boolean, awaitCapMs?: number }) => Promise<{ ok: boolean, content?: string, error?: string, actorDeliveryId?: string }>} [messageActor]
 * @property {{ sessionId?: string, kind?: string }} [session]
 * @property {boolean} [inbound]
 * @property {string} [toolUseId]
 * @property {{ aborted: boolean, addEventListener: Function, removeEventListener?: Function }} [abortSignal]
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const messageActorTool = {
  name: 'message_actor',
  primitive: 'spawned',
  // why the address forms live in the DESCRIPTION, not the `to` schema field:
  // the schema is JSON-serialized into the descriptor every turn, so per-field
  // prose is the most expensive place to keep it. The routing knowledge the
  // model needs to PICK a target reads once here; the field stays a terse
  // pointer to actor_list. No target form was dropped — web / site: / API
  // origin / tabId / instance id all survive.
  description: [
    'Delegate a GOAL to an ACTOR — your ONLY path to act on a page or mutate an',
    'instance. For WEB WORK address `to:"web"` and delegate INTENT ("get the',
    'cheapest in-stock price for X"): the web actor is the single entry point and',
    'PICKS THE MECHANISM itself — a sessionless secure fetch, or opening + driving a',
    'tab — so don\'t pre-open a tab or pick fetch-vs-render. Other address forms, all',
    'listed by actor_list: a tabId to act on ONE already-open page; a vm/notebook/app',
    'instance id; "site:<origin>" (e.g. "site:https://github.com") to work on ONE site',
    'the user is logged into (drives a real tab, that site only, so it can sign in',
    'where "web" may not go); or an API integration\'s ORIGIN (a bare host like',
    '"api.github.com" — fetch-only, keyless, origin-locked, ACCUMULATING what it',
    'learns across messages). An actor is minted on first message, holds that',
    'environment\'s tools, and works in its own focused context. By DEFAULT you send',
    'a goal and DON\'T wait — the reply lands as a fenced note on a LATER turn; fan',
    'out several actors and synthesize as replies land. For a SINGLE primary task',
    'whose answer you need NOW ("find X and tell me"), set `await:true`: the actor\'s',
    'substance comes straight back in THIS result and you answer with it, never an',
    '"I\'ll report back" deferral. Nothing to poll either way. An actor is STATEFUL',
    'and handles one message at a time: reuse the same `to` for follow-up (no',
    're-orientation); message a DIFFERENT tab/instance for independent, parallel',
    'work. While a reply is pending you know NOTHING about progress — tell the user',
    'what you ASKED, never narrate what the actor "is doing" (it may fail). If an',
    'actor claims it cannot do something its kind CAN (the web actor can ALWAYS',
    'render — navigate opens its tab itself), re-send restating that capability',
    'instead of accepting the refusal or bouncing it to the user. (As an EPHEMERAL',
    'actor the reply comes back directly in THIS result — use it and continue.)',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'An address form from actor_list (see the description): "web", a tabId, a vm/notebook/app instance id, "site:<origin>", or an API origin. Minted on first message.',
      },
      message: {
        type: 'string',
        description: 'The request, in natural language. Self-contained — the actor sees only this, not your conversation.',
      },
      oneShot: {
        type: 'boolean',
        description: 'Sandbox instances ONLY (a vm/notebook/app id; refused for web/API/tabId/dweb). true when ONE round settles it — a concrete command or read whose raw result IS the answer — so the actor hands that result straight back, skipping its summarize turn. Default false for open-ended or multi-step work.',
      },
      await: {
        type: 'boolean',
        description: 'Wait for the reply IN this turn — its summarized (fenced) substance returns as this result — instead of the default later-turn wake. true for ONE primary task you must answer now; false (default) to fan out several actors. Past a few minutes the wait ends with a "still working" note and the reply lands on a later turn (never dropped). An ephemeral actor always returns here regardless.',
      },
    },
    required: ['to', 'message'],
  },
  // write, not mutate_external — every effect the actor produces goes through
  // the actor's OWN gated turn; nothing escapes here that isn't gated there.
  sideEffect: 'write',
  origins: () => [],

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
    return res.ok
      ? {
        ok: true,
        content: res.content ?? 'message delivered',
        ...(res.actorDeliveryId ? { actorDeliveryId: res.actorDeliveryId } : {}),
      }
      : {
        ok: false,
        error: res.error ?? 'message_actor failed',
        ...(res.actorDeliveryId ? { actorDeliveryId: res.actorDeliveryId } : {}),
      };
  },
};
