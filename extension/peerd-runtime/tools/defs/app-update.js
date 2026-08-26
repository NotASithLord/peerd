// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// app_update — modify an existing App.
//
// Convenience: replace the entry file's content (HTML) and/or rename.
// For granular updates to a SPECIFIC file (style.css, script.js,
// data.json), use app_write_file. For deleting a non-entry file,
// app_delete_file.

const MAX_HTML_CHARS = 1_000_000;

/** @type {import('/shared/tool-types.js').Tool} */
export const appUpdateTool = composeTool("app_update", {

  execute: async (args, ctx) => {
    const authority = /** @type {{ updateApp?: Function } | undefined} */ (
      /** @type {any} */ (ctx).appAuthority);
    if (!authority?.updateApp) return { ok: false, error: 'app_not_available' };
    if (typeof args?.html === 'string' && args.html.length > MAX_HTML_CHARS) {
      return { ok: false, error: `html_too_large: ${args.html.length} > ${MAX_HTML_CHARS}` };
    }
    try {
      const record = await authority.updateApp(
        args.appId, args.name, args.html, args.tags, args.entryFile,
      );
      if (!record) return { ok: false, error: 'app_not_found' };
      return {
        ok: true,
        content: JSON.stringify({
          id: record.id,
          name: record.name,
          entryFile: record.entryFile,
          updatedAt: record.updatedAt,
        }, null, 2),
      };
    } catch (e) {
      return { ok: false, error: `app_update_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
});
