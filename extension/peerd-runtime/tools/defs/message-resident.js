// @ts-check
// message_resident — talk to the agent that OWNS a tab-hosted instance.
//
// DESIGN-17: each WebVM / Notebook / App is driven by a RESIDENT (a per-instance
// agent that exclusively holds that environment's tools). The main agent no
// longer mutates an instance by id; it messages the instance's resident, which
// does the work in its own focused context and replies on a later turn. Thin
// wrapper — the mailbox / sender-gate / runaway-guard / correlation all live in
// subagent/resident-messaging.js (bound + injected as ctx.messageResident by the
// SW, only when the RESIDENT_TAB_AGENTS flag is on; the exposure gate refuses
// this tool by name when it's off, so a stray call fails closed here too).

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
    'Send a request to the RESIDENT that owns a tab-hosted instance (a WebVM,',
    'Notebook, or App). The resident holds that environment\'s tools and does',
    'the work — running commands, editing files, building the UI — in its own',
    'focused context. ASYNC: returns immediately; the resident\'s reply arrives',
    'as a fenced note on a LATER turn. Do NOT wait or poll. `to` is the instance',
    'id (from the create/list tools); `message` is the natural-language request.',
    'Use this instead of the instance\'s own *_write_file / *_update / boot tools —',
    'those now live ONLY on the resident.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'The tab-hosted instance id to address (e.g. an app/vm/notebook id from app_list / vm_list / js_list).',
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
