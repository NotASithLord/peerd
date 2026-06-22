// @ts-check
// dweb_block — the sovereign moderation lever: ban (or un-ban) a dweb peer.
//
// Blocking a did is unilateral and LOCAL: we drop them from our discovery feed,
// blocklist them (we never relay or seed their content again), purge their cards
// from our Library, and cut the link. Un-blocking lifts that and re-subscribes.
// Local-only, reversible, no outward effect — so it does not force-confirm; the
// agent acts on the user's behalf the way mute does. dweb-only.

// why: 'dweb' is the network primitive — outside the base Primitive union (the
// dweb module + its tools are pruned on the store build). ctx.dweb is an
// SW-injected slot absent from the base ToolContext; narrowed inside execute.
/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult | { ok: false, error: string, content?: string }} DwebToolResult */
/** @typedef {Omit<Tool, 'primitive' | 'execute'> & { primitive: 'dweb', execute: (args: any, ctx: ToolContext) => Promise<DwebToolResult> }} DwebTool */

/** @type {DwebTool} */
export const dwebBlockTool = {
  name: 'dweb_block',
  primitive: 'dweb',
  dweb: true,
  description: [
    'Block (ban) or un-block a dweb peer/publisher by did. Blocking drops them from',
    'my discovery feed, purges their apps from my Library, refuses their content, and',
    'cuts the link — unilateral and local. Pass { did, block:false } to lift a block.',
    "Get dids from dweb_peers or dweb_discover (the app's publisher).",
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      did: { type: 'string', description: 'The peer/publisher did:key to block or un-block.' },
      block: { type: 'boolean', description: 'true to block (default), false to un-block.' },
      reason: { type: 'string', description: 'Optional note recorded in the audit log.' },
    },
    required: ['did'],
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    // why: narrow the SW-injected ctx.dweb slot to the one op this tool uses.
    const dweb = /** @type {{ block: (o: { did: string, block: boolean, reason?: string }) => Promise<{ ok?: boolean, error?: string }> } | null | undefined} */ (
      /** @type {{ dweb?: unknown }} */ (ctx).dweb);
    if (!dweb) return { ok: false, error: 'dweb_unavailable', content: 'The dweb is not enabled in this build.' };
    const did = String(args?.did ?? '').trim();
    if (!did) return { ok: false, error: 'did_required' };
    const block = args?.block !== false;
    const r = await dweb.block({ did, block, reason: args?.reason });
    if (!r?.ok) return { ok: false, error: r?.error ?? 'block_failed' };
    return { ok: true, content: JSON.stringify({ did, blocked: block }, null, 2) };
  },
};
