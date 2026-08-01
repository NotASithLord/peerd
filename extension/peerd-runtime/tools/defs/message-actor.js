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
 * @property {(req: { to: string, message: string, senderSessionId?: string|null, inbound?: boolean, toolUseId?: string, oneShot?: boolean, awaitReply?: boolean, awaitSignal?: any, degradeToAsync?: boolean, awaitCapMs?: number }) => Promise<{ ok: boolean, content?: string, error?: string }>} [messageActor]
 * @property {{ sessionId?: string, kind?: string }} [session]
 * @property {boolean} [inbound]
 * @property {string} [toolUseId]
 * @property {{ aborted: boolean, addEventListener: Function, removeEventListener?: Function }} [abortSignal]
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const messageActorTool = {
  name: 'message_actor',
  primitive: 'spawned',
  description: [
    'Delegate a GOAL to an ACTOR. For WEB WORK, address `to:"web"` and delegate',
    'INTENT ("get the cheapest in-stock price for X") — the web actor is the single',
    'entry point and PICKS THE MECHANISM itself: a sessionless secure fetch (no tab)',
    'for data reachable without login, or opening + driving a tab for logged-in /',
    'JS-rendered pages. Don\'t pre-open a tab or pick fetch-vs-render for it. (To act',
    'on a SPECIFIC already-open tab, address its tabId from actor_list / open_tab.) For',
    'a WebVM / Notebook / App, address the instance id from actor_list. Each actor is',
    'started on first message, holds that environment\'s tools, and does the work in',
    'its own focused context. By DEFAULT you send a goal and don\'t wait — the reply',
    'lands as a fenced note on a LATER turn; fan out several actors this way and',
    'synthesize as their replies land. But for a SINGLE primary task whose answer you',
    'need NOW to answer the user ("find X and tell me"), set `await:true`: the actor\'s',
    'substance comes straight back in THIS tool result and you reply with it, never an',
    '"I\'ll report back" deferral. Nothing to poll either way. An actor is STATEFUL and handles one',
    'message at a time (its mailbox): reuse the same `to` for follow-up (no',
    're-orientation); message a DIFFERENT tab/instance for independent work — separate',
    'actors run in parallel. Your ONLY path to act on a page or mutate an instance.',
    'While a reply is pending you know NOTHING about the actor\'s progress — tell the',
    'user what you ASKED for, never narrate what the actor "is doing" (it may fail).',
    'If an actor claims it cannot do something its kind CAN do (the web actor can',
    'ALWAYS render — navigate opens its tab itself), re-send the goal restating that',
    'capability instead of accepting the refusal or bouncing it to the user.',
    '(When you are an EPHEMERAL actor, the reply comes back directly in THIS tool result',
    'instead of a later turn — use it and continue.)',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Who to address: "web" for general web work (the web actor picks fetch-vs-render — prefer this for open-ended web tasks); "site:<origin>" (e.g. "site:https://github.com") for work ON ONE SITE THE USER HAS AN ACCOUNT ON — that helper opens and drives a real tab but works on that site and nowhere else, so it can sign in and act normally where the general web helper is not allowed to go; an API integration\'s ORIGIN (a bare host like "api.github.com" or a full origin) for repeated, focused work against ONE API — fetch-only, keyless, origin-locked, and it ACCUMULATES what it learns about that API across messages; a specific open page\'s tabId; OR a vm/notebook/app instance id. Every addressable handle (tabId, instance id, formed origin) is listed by actor_list. An actor is minted on first message; an API integration and a site helper both auto-form the first time you address them.',
      },
      message: {
        type: 'string',
        description: 'The request for the actor, in natural language. Self-contained — the actor sees only this, not your conversation.',
      },
      oneShot: {
        type: 'boolean',
        description: 'SANDBOX INSTANCES ONLY (a vm/notebook/app id — never "web", a tabId, an API origin, or "dweb"; those are refused). Set true when ONE round in your own sandbox settles it — a concrete command or read whose raw result IS the answer ("run `python3 …`", "cat the config"). The actor does the single action and hands its result straight back, skipping the extra turn it would otherwise spend re-summarizing — faster and cheaper. Leave false (default) for open-ended or multi-step work, and always for web/API/dweb targets (their replies are untrusted content and always return summarized). If the action errors, the actor recovers normally regardless.',
      },
      await: {
        type: 'boolean',
        description: 'WAIT for the actor\'s reply IN THIS turn and receive its summarized (fenced) substance as this tool\'s result, instead of the default fire-and-continue (reply on a LATER turn). Set true for ONE primary task whose answer you need now to respond to the user — so you reply with the substance, not an "I\'ll report back" deferral. Leave false (default) to fan out several actors in parallel, or when you will act on the reply on a later turn. If the actor takes more than a few minutes, the wait ends with a "still working" note and its reply lands on a later turn instead (it is never dropped). An ephemeral actor\'s reply always returns here regardless of this flag.',
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
    // Narrow the orchestrator's {ok, content?, error?} into the ToolResult union.
    return res.ok
      ? { ok: true, content: res.content ?? 'message delivered' }
      : { ok: false, error: res.error ?? 'message_actor failed' };
  },
};
