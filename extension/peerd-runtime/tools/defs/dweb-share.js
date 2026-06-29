// @ts-check
// dweb_share — publish one of the user's Apps to the dweb app store, peer to peer.
//
// The app's signed bundle goes out over the always-on base network: announced by
// gossip (peers hear fast) AND stored in the DHT (late joiners find it). Any peer
// can then fetch + verify + install it, no server in the path. Public and
// outward-facing, so it CONFIRMS every time: the EXTERNAL action class confirms
// under the normal toggle, and the execute below ALSO force-confirms when the
// toggle is off (publishing always needs a yes). dweb-only — the exposure layer
// hides it from the agent unless the dweb is enabled (invisible on the store build).

// why: 'dweb' is the network primitive — outside the base Primitive union (the
// dweb module + its tools are pruned on the store build). ctx.dweb and the
// force-confirm slots (ctx.permission, ctx.confirm) are SW-injected; the
// dweb-side confirm prompt is a richer shape than the base ToolContext's confirm,
// so ctx is narrowed at the use site.
/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ConfirmAnswer} ConfirmAnswer */
/** @typedef {import('/shared/tool-types.js').ToolResult | { ok: false, error: string, content?: string }} DwebToolResult */
/** @typedef {Omit<Tool, 'primitive' | 'execute'> & { primitive: 'dweb', execute: (args: any, ctx: ToolContext) => Promise<DwebToolResult> }} DwebTool */

/**
 * The dweb tools' confirm + dweb slots, injected by the SW only on a
 * dweb-enabled build. dweb.share is an RPC into the pruned-on-store module.
 * @typedef {{
 *   permission?: { confirmActions?: boolean },
 *   confirm?: (p: { tool: string, kind: string, origins: string[], summary: string, sessionId: string | null }) => Promise<ConfirmAnswer>,
 *   dweb?: { share: (appId: string) => Promise<{ ok?: boolean, error?: string, uri?: string, hash?: string, dwapp_id?: string }> } | null,
 * }} DwebShareCtx
 */

/** @type {DwebTool} */
export const dwebShareTool = {
  name: 'dweb_share',
  primitive: 'dweb',
  dweb: true,
  description: [
    'Publish one of the user\'s Apps to the dweb app store so peers can discover',
    'and install it peer-to-peer (no server). Pass the app id (from actor_list). The',
    'app travels as a signed bundle over the base network and shows up in peers\'',
    'Discover view. Use after building an app the user wants to share. CONFIRMS',
    'with the user every time — it is public and outward-facing.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: { appId: { type: 'string', description: 'The app id to publish (from actor_list).' } },
    required: ['appId'],
  },
  sideEffect: 'mutate_external',
  origins: () => [],

  execute: async (args, ctx) => {
    // why: narrow ctx to the dweb-only slots (dweb surface + force-confirm) the
    // SW injects for dweb builds — absent/loosely-typed on the base ToolContext.
    const dctx = /** @type {DwebShareCtx} */ (/** @type {unknown} */ (ctx));
    if (!dctx.dweb) return { ok: false, error: 'dweb_unavailable', content: 'The dweb is not enabled in this build.' };
    const appId = String(args?.appId ?? '').trim();
    if (!appId) return { ok: false, error: 'appId_required' };
    // Publishing is public, so confirm even if the global confirm toggle is OFF
    // (the dispatcher's gate already confirms it when the toggle is on).
    if (dctx.permission?.confirmActions === false && dctx.confirm) {
      const ans = await dctx.confirm({
        tool: 'dweb_share', kind: 'dweb_publish', origins: [],
        summary: `Publish app "${appId}" to the dweb app store? Peers will be able to discover and install it.`,
        sessionId: ctx.session?.sessionId ?? null,
      });
      if (ans !== 'yes_once' && ans !== 'yes_session') {
        return { ok: false, error: 'declined', content: 'User declined to publish to the dweb.' };
      }
    }
    const r = await dctx.dweb.share(appId);
    if (!r?.ok) return { ok: false, error: r?.error ?? 'share_failed' };
    return {
      ok: true,
      content: JSON.stringify({ shared: true, uri: r.uri, hash: r.hash, dwapp_id: r.dwapp_id ?? r.hash }, null, 2),
    };
  },
};
