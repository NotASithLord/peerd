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
    const authority = /** @type {{ readApp?: Function, deleteApp?: Function } | undefined} */ (
      /** @type {any} */ (ctx).appAuthority);
    if (!authority?.readApp || !authority.deleteApp) {
      return { ok: false, error: 'app_not_available' };
    }
    const rec = await authority.readApp(args.appId);
    if (!rec) return { ok: false, error: 'app_not_found' };
    try {
      await authority.deleteApp(args.appId);
      return {
        ok: true,
        content: JSON.stringify({ deleted: { id: args.appId, name: rec.name } }, null, 2),
      };
    } catch (e) {
      return { ok: false, error: `app_delete_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
});
