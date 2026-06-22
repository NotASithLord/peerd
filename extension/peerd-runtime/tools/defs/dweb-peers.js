// @ts-check
// dweb_peers — who I'm connected to on the dweb, and my discovery state.
//
// Read-only window onto the base network: the peers I hold a link to (and any I've
// only heard via presence), plus the sovereign discovery state — whether discovery
// is on, how many peers subscribe to my feed, my Library size, and whom I've
// blocked. Pairs with dweb_discover (apps) and dweb_block (moderation). dweb-only.

// why: 'dweb' is the network primitive — outside the base Primitive union (the
// dweb module + its tools are pruned on the store build). ctx.dweb is an
// SW-injected slot absent from the base ToolContext; narrowed inside execute.
/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult | { ok: false, error: string, content?: string }} DwebToolResult */
/** @typedef {Omit<Tool, 'primitive' | 'execute'> & { primitive: 'dweb', execute: (args: any, ctx: ToolContext) => Promise<DwebToolResult> }} DwebTool */

/**
 * The peers response from the offscreen base host (RPC boundary into the
 * pruned-on-store dweb module).
 * @typedef {{ ok?: boolean, error?: string, running?: boolean, did?: string, discovery?: unknown, peers?: Array<{ did: string, name?: string, linked?: boolean, path?: string }> }} PeersResult
 */

/** @type {DwebTool} */
export const dwebPeersTool = {
  name: 'dweb_peers',
  primitive: 'dweb',
  dweb: true,
  description: [
    'List the peers I am connected to on the dweb right now, plus my discovery',
    'state: whether discovery is on, how many peers subscribe to my feed, my',
    'Library size, and which publishers I have blocked. Read-only. Use it to find a',
    "peer's did (e.g. to pass to dweb_block) or to confirm I am connected.",
  ].join(' '),
  schema: { type: 'object', properties: {} },
  sideEffect: 'read',
  origins: () => [],

  execute: async (_args, ctx) => {
    // why: narrow the SW-injected ctx.dweb slot to the one op this tool uses.
    const dweb = /** @type {{ peers: () => Promise<PeersResult> } | null | undefined} */ (
      /** @type {{ dweb?: unknown }} */ (ctx).dweb);
    if (!dweb) return { ok: false, error: 'dweb_unavailable', content: 'The dweb is not enabled in this build.' };
    const r = await dweb.peers();
    if (!r?.ok) return { ok: false, error: r?.error ?? 'peers_failed' };
    const peers = (r.peers ?? []).map((p) => ({ did: p.did, name: p.name ?? null, linked: !!p.linked, path: p.path ?? null }));
    return {
      ok: true,
      content: JSON.stringify({
        running: !!r.running,
        did: r.did ?? null,
        peerCount: peers.length,
        peers,
        discovery: r.discovery ?? null,
      }, null, 2),
    };
  },
};
