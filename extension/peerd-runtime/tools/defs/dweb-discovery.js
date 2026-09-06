// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// dweb_discovery — the sovereign on/off switch for receiving discovery metadata.
//
// "I don't want to see shit": turn discovery OFF and we stop asking peers for
// their feeds AND tell current upstreams to stop sending — no node can push us
// metadata we didn't subscribe for. Turn it back ON to re-subscribe to our peers.
// Local, reversible. dweb-only.

// why: 'dweb' is the network primitive — outside the base Primitive union (the
// dweb module + its tools are pruned on the store build). ctx.dweb is an
// SW-injected slot absent from the base ToolContext; narrowed inside execute.
// The error+content shape is the real (inert-on-error) return value modelled.
/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult | { ok: false, error: string, content?: string }} DwebToolResult */
/** @typedef {Omit<Tool, 'primitive' | 'execute'> & { primitive: 'dweb', execute: (args: any, ctx: ToolContext) => Promise<DwebToolResult> }} DwebTool */

/** @type {DwebTool} */
export const dwebDiscoveryTool = composeTool("dweb_discovery", {

  execute: async (args, ctx) => {
    // why: narrow the SW-injected ctx.dweb slot to the one op this tool uses.
    const authority = /** @type {{setDiscoveryEnabled?:(enabled:boolean)=>Promise<any>}|undefined} */ (
      /** @type {{dwebAuthority?:unknown}} */ (ctx).dwebAuthority);
    if (typeof authority?.setDiscoveryEnabled !== 'function') return { ok: false, error: 'dweb_unavailable', content: 'The dweb is not enabled in this build.' };
    if (typeof args?.enabled !== 'boolean') return { ok: false, error: 'enabled_required', content: 'Pass { enabled: true|false }.' };
    const r = await authority.setDiscoveryEnabled(args.enabled);
    if (r?.error === 'dweb_unavailable') return { ok: false, error: 'dweb_unavailable', content: 'The dweb is not enabled in this build.' };
    if (!r?.ok) return { ok: false, error: r?.error ?? 'set_discovery_failed' };
    return { ok: true, content: JSON.stringify({ discovery: args.enabled ? 'on' : 'off' }, null, 2) };
  },
});
