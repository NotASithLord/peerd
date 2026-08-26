// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
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
 *   confirm?: (p: { tool: string, kind: string, origins: string[], summary: string, sessionId: string | null }, signal?: AbortSignal) => Promise<ConfirmAnswer>,
 *   dweb?: { share: (appId: string) => Promise<{ ok?: boolean, error?: string, uri?: string, hash?: string, dwapp_id?: string, warning?: string, cleanupPending?: boolean }> } | null,
 * }} DwebShareCtx
 */

/** @type {DwebTool} */
export const dwebShareTool = composeTool("dweb_share", {

  execute: async (args, ctx) => {
    // why: narrow ctx to the dweb-only slots (dweb surface + force-confirm) the
    // SW injects for dweb builds — absent/loosely-typed on the base ToolContext.
    const authority = /** @type {{publishConfirmedApp?:(appId:string)=>Promise<any>}|undefined} */ (
      /** @type {{dwebAuthority?:unknown}} */ (ctx).dwebAuthority);
    if (typeof authority?.publishConfirmedApp !== 'function') return {
      ok: false, error: 'dweb_unavailable', content: 'The dweb is not enabled in this build.',
      outcomeKind: 'pre-effect-failure',
    };
    const appId = String(args?.appId ?? '').trim();
    if (!appId) return { ok: false, error: 'appId_required', outcomeKind: 'pre-effect-failure' };
    const r = await authority.publishConfirmedApp(appId);
    if (r?.error === 'dweb_unavailable') return {
      ok: false, error: 'dweb_unavailable', content: 'The dweb is not enabled in this build.',
      outcomeKind: 'pre-effect-failure',
    };
    if (r?.declined === true) return {
      ok: false, error: 'declined', content: 'User declined to publish to the dweb.',
      outcomeKind: 'pre-effect-failure',
    };
    if (!r?.ok) {
      const error = r?.error ?? 'share_failed';
      const preEffect = ['dweb-disabled', 'dweb-start-failed', 'app-not-found'].includes(error);
      return { ok: false, error, ...(preEffect ? { outcomeKind: 'pre-effect-failure' } : {}) };
    }
    return {
      ok: true,
      content: JSON.stringify({
        shared: true,
        uri: r.uri,
        hash: r.hash,
        dwapp_id: r.dwapp_id ?? r.hash,
        ...(r.cleanupPending ? {
          cleanupPending: true,
          warning: r.warning ?? 'previous-version-cleanup-pending',
          recovery: 'The new version is public. Cleanup of an older served version is pending and will be retried on the next share or delete.',
        } : {}),
      }, null, 2),
    };
  },
});
