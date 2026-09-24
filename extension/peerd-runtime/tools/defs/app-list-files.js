// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// app_list_files — enumerate files inside an App's OPFS subtree.

import { serializeListResult } from './columnar.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const appListFilesTool = composeTool("app_list_files", {

  execute: async (args, ctx) => {
    const authority = /** @type {{ listFiles?: Function } | undefined} */ (
      /** @type {any} */ (ctx).appAuthority);
    if (!authority?.listFiles) return { ok: false, error: 'app_not_available' };
    try {
      const files = await authority.listFiles(args.appId);
      return {
        ok: true,
        content: serializeListResult({ count: files.length, files }, 'files'),
      };
    } catch (e) {
      return { ok: false, error: `app_list_files_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
});
