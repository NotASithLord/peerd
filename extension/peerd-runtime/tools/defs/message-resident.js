// @ts-check
// message_resident — talk to the agent that OWNS a tab-hosted instance.
//
// DESIGN-17: each WebVM / Notebook / App is driven by a RESIDENT (a per-instance
// agent that exclusively holds that environment's tools). The main agent no
// longer mutates an instance by id; it messages the instance's resident, which
// does the work in its own focused context and replies on a later turn. Thin
// wrapper — the mailbox / sender-gate / runaway-guard / correlation all live in
// subagent/resident-messaging.js (bound + injected as ctx.messageResident by the
// SW). The exposure gate refuses this tool on a resident session, so a resident
// can't recursively message another resident.

/**
 * The ctx slot message_resident reads (an SW-injected extra, not on the base
 * ToolContext contract).
 * @typedef {Object} MessageResidentCtx
 * @property {(req: { to: string, message: string, senderSessionId?: string|null, inbound?: boolean, toolUseId?: string }) => Promise<{ ok: boolean, content?: string, error?: string }>} [messageResident]
 * @property {{ sessionId?: string }} [session]
 * @property {boolean} [inbound]
 * @property {string} [toolUseId]
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const messageResidentTool = {
  name: 'message_resident',
  primitive: 'subagent',
  description: [
    'Delegate a focused GOAL to the RESIDENT that owns a tab — a web PAGE (address',
    'by its tabId from list_tabs / open_tab), or a WebVM / Notebook / App (address',
    'by its instance id from vm_list / js_list / app_list). The resident holds that',
    'environment\'s tools and does the work — driving the page, running commands,',
    'editing files, building the UI — in its own focused context, then replies.',
    'ASYNC, always: returns immediately; the reply arrives as a fenced note on a',
    'LATER turn. NEVER wait or poll — fire it and continue or end your turn; react',
    'to each reply when it lands. A resident is STATEFUL: reuse the same `to` for',
    'follow-up work on the same page/instance (no re-orientation); message a',
    'DIFFERENT tab/instance for independent work — they run in parallel. This is',
    'your ONLY path to act on a page or mutate an instance.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Who to address: a web page\'s tabId (from list_tabs / open_tab) OR a vm/notebook/app instance id (from vm_list / js_list / app_list). Every open tab has a resident, minted on first message.',
      },
      message: {
        type: 'string',
        description: 'The request for the resident, in natural language. Self-contained — the resident sees only this, not your conversation.',
      },
    },
    required: ['to', 'message'],
  },
  // write, not mutate_external — every effect the resident produces goes through
  // the resident's OWN gated turn; nothing escapes here that isn't gated there.
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    const c = /** @type {MessageResidentCtx} */ (/** @type {unknown} */ (ctx));
    if (typeof c.messageResident !== 'function') {
      // Flag off / not wired — fail closed (the gate also refuses by name).
      return { ok: false, error: 'message_resident is not enabled' };
    }
    const res = await c.messageResident({
      to: args?.to,
      message: args?.message,
      senderSessionId: c.session?.sessionId,
      // The sender gate keys on this — an untrusted-origin (inbound) turn is
      // refused. ctx.inbound = synthetic && !trusted (folded by the turn driver):
      // a goal continuation or a resident reply-wake is trusted → not inbound.
      inbound: c.inbound === true,
      // DESIGN-17 P1 glass pane: THIS tool call's id (SW-injected into ctx, the
      // same thread spawn_subagent uses) keys the resident's live display stream
      // to this card, so its work renders inline like a subagent transcript.
      toolUseId: c.toolUseId,
    });
    // Narrow the orchestrator's {ok, content?, error?} into the ToolResult union.
    return res.ok
      ? { ok: true, content: res.content ?? 'message delivered' }
      : { ok: false, error: res.error ?? 'message_resident failed' };
  },
};
