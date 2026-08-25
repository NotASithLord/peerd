// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// app_delete — destroy an App.
//
// Closes the tab (if open), drops the IDB body, removes the metadata
// record. Irreversible. Use after confirming with the user.

/** @type {import('/shared/tool-types.js').Tool} */
export const appDeleteTool = composeTool("app_delete", {

  execute: async (args, ctx) => {
    if (typeof args?.appId !== 'string') return { ok: false, error: 'appId_required' };
    // why: appClient / appRegistry ride the opaque ctx contract (not on
    // ToolContext); narrow to the surface this tool touches.
    const appClient = /** @type {{ delete?: (appId: string) => Promise<unknown> } | undefined} */ (
      /** @type {any} */ (ctx).appClient);
    const appRegistry = /** @type {{ get: (appId: string) => Promise<{ name: string } | null | undefined> } | undefined} */ (
      /** @type {any} */ (ctx).appRegistry);
    if (!appClient?.delete) return { ok: false, error: 'app_not_available' };
    const rec = await appRegistry?.get(args.appId);
    if (!rec) return { ok: false, error: 'app_not_found' };
    try {
      await appClient.delete(args.appId);
      return {
        ok: true,
        content: JSON.stringify({ deleted: { id: args.appId, name: rec.name } }, null, 2),
      };
    } catch (e) {
      return { ok: false, error: `app_delete_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
});
