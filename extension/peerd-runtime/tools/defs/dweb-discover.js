// @ts-check
// dweb_discover — list the Apps peers are sharing on the dweb right now.
//
// Read-only window onto the peer-to-peer app store: the gossip-heard cache plus
// any DHT hits the offscreen base host holds. Returns each app's name, publisher,
// and peerd:// uri (feed the uri to dweb_install). dweb-only (hidden unless the
// dweb is enabled).

// why: 'dweb' is the network primitive — outside the base Primitive union (the
// dweb module + its tools are pruned on the store build), so the tool object is
// typed as Tool with the primitive overridden. The dweb surface (ctx.dweb) is an
// SW-injected slot absent from the base ToolContext; it's narrowed inside execute.
/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
// why: the dweb tools attach an explanatory `content` on some error results (an
// inert field the dispatcher ignores on errors — it only reads `.error` — but
// part of the real returned value). Model it honestly rather than drop it: the
// base ToolResult plus that error+content shape.
/** @typedef {import('/shared/tool-types.js').ToolResult | { ok: false, error: string, content?: string }} DwebToolResult */
/** @typedef {Omit<Tool, 'primitive' | 'execute'> & { primitive: 'dweb', execute: (args: any, ctx: ToolContext) => Promise<DwebToolResult> }} DwebTool */

/**
 * The gossip-heard discovery response from the offscreen base host (an RPC
 * boundary into the pruned-on-store dweb module — the shape is what the host
 * returns over browser.runtime.sendMessage).
 * @typedef {{ ok?: boolean, error?: string, apps?: Array<{ name?: string, dwapp_id?: string, uri?: string, publisher?: string, from?: string }> }} DiscoverResult
 */

/** @type {DwebTool} */
export const dwebDiscoverTool = {
  name: 'dweb_discover',
  primitive: 'dweb',
  dweb: true,
  description: [
    'List Apps peers are sharing on the dweb right now — the peer-to-peer app',
    'store. Returns each app\'s name, publisher, and peerd:// uri (pass the uri to',
    'dweb_install). Read-only. Returns an empty list if no peers are sharing or the',
    'base network is not up yet.',
  ].join(' '),
  schema: { type: 'object', properties: {} },
  sideEffect: 'read',
  origins: () => [],

  execute: async (_args, ctx) => {
    // why: ctx.dweb is an SW-injected slot (null when the dweb is off) absent
    // from the base ToolContext; narrow it to the one discover() op used here.
    const dweb = /** @type {{ discover: () => Promise<DiscoverResult> } | null | undefined} */ (
      /** @type {{ dweb?: unknown }} */ (ctx).dweb);
    if (!dweb) return { ok: false, error: 'dweb_unavailable', content: 'The dweb is not enabled in this build.' };
    const r = await dweb.discover();
    if (!r?.ok) return { ok: false, error: r?.error ?? 'discover_failed' };
    const apps = (r.apps ?? []).map((a) => ({
      name: a.name,
      dwapp_id: a.dwapp_id,
      uri: a.uri,
      publisher: a.publisher ?? a.from ?? null,
    }));
    return { ok: true, content: JSON.stringify({ count: apps.length, apps }, null, 2) };
  },
};
