// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// app_delete_file — delete a single file from an App's OPFS subtree.
//
// Refuses to delete the entry file (would brick the app).

/** @type {import('/shared/tool-types.js').Tool} */
export const appDeleteFileTool = composeTool("app_delete_file", {

  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string') return { ok: false, error: 'path_required' };
    const authority = /** @type {{ deleteFile?: Function } | undefined} */ (
      /** @type {any} */ (ctx).appAuthority);
    if (!authority?.deleteFile) return { ok: false, error: 'app_not_available' };
    try {
      await authority.deleteFile(args.appId, args.path);
      return { ok: true, content: JSON.stringify({ deleted: args.path }, null, 2) };
    } catch (e) {
      return { ok: false, error: `app_delete_file_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
});
