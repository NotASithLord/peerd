// @ts-check
// message_actor — talk to the agent that OWNS a tab-hosted instance.
//
// DESIGN-17: each WebVM / Notebook / App is driven by an ACTOR (a per-instance
// agent that exclusively holds that environment's tools). The main agent no
// longer mutates an instance by id; it messages the instance's actor, which
// does the work in its own focused context and replies on a later turn. Thin
// wrapper — the mailbox / sender-gate / runaway-guard / correlation all live in
// subagent/actor-messaging.js (bound + injected as ctx.messageActor by the
// SW). The exposure gate refuses this tool on an actor session, so an actor
// can't recursively message another actor.

/**
 * The ctx slot message_actor reads (an SW-injected extra, not on the base
 * ToolContext contract).
 * @typedef {Object} MessageActorCtx
 * @property {(req: { to: string, message: string, senderSessionId?: string|null, inbound?: boolean, toolUseId?: string }) => Promise<{ ok: boolean, content?: string, error?: string }>} [messageActor]
 * @property {{ sessionId?: string }} [session]
 * @property {boolean} [inbound]
 * @property {string} [toolUseId]
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const messageActorTool = {
  name: 'message_actor',
  primitive: 'subagent',
  description: [
    'Delegate a GOAL to an ACTOR. For WEB WORK, address `to:"web"` and delegate',
    'INTENT ("get the cheapest in-stock price for X") — the web actor is the single',
    'entry point and PICKS THE MECHANISM itself: a sessionless secure fetch (no tab)',
    'for data reachable without login, or opening + driving a tab for logged-in /',
    'JS-rendered pages. Don\'t pre-open a tab or pick fetch-vs-render for it. (To act',
    'on a SPECIFIC already-open tab, address its tabId from list_tabs / open_tab.) For',
    'a WebVM / Notebook / App, address the instance id from vm_list / js_list /',
    'app_list. Each actor is a GenServer (an OTP process): a registered name,',
    'started on first message, holding that environment\'s tools and doing the work in',
    'its own focused context. message_actor is a cast: you hand off the goal and',
    'don\'t wait; the reply lands as a fenced note on a LATER turn. When your next step',
    'needs a value back ("read the price") it\'s a call — same later-turn reply, you',
    'just await it. Nothing to poll either way. An actor is STATEFUL and handles one',
    'message at a time (its mailbox): reuse the same `to` for follow-up (no',
    're-orientation); message a DIFFERENT tab/instance for independent work — separate',
    'actors run in parallel. Your ONLY path to act on a page or mutate an instance.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Who to address: "web" for general web work (the web actor picks fetch-vs-render — prefer this for open-ended web tasks); an API integration\'s ORIGIN (a bare host like "api.github.com" or a full origin) for repeated, focused work against ONE API — it is fetch-only, keyless, origin-locked, and ACCUMULATES what it learns about that API across messages; a specific open page\'s tabId (from list_tabs / open_tab); OR a vm/notebook/app instance id (from vm_list / js_list / app_list). An actor is minted on first message; an API integration auto-forms the first time you address its origin.',
      },
      message: {
        type: 'string',
        description: 'The request for the actor, in natural language. Self-contained — the actor sees only this, not your conversation.',
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
      senderSessionId: c.session?.sessionId,
      // The sender gate keys on this — an untrusted-origin (inbound) turn is
      // refused. ctx.inbound = synthetic && !trusted (folded by the turn driver):
      // a goal continuation or an actor reply-wake is trusted → not inbound.
      inbound: c.inbound === true,
      // DESIGN-17 P1 glass pane: THIS tool call's id (SW-injected into ctx, the
      // same thread spawn_subagent uses) keys the actor's live display stream
      // to this card, so its work renders inline like a subagent transcript.
      toolUseId: c.toolUseId,
    });
    // Narrow the orchestrator's {ok, content?, error?} into the ToolResult union.
    return res.ok
      ? { ok: true, content: res.content ?? 'message delivered' }
      : { ok: false, error: res.error ?? 'message_actor failed' };
  },
};
