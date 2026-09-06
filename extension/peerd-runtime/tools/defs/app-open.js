// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// app_open — focus or spawn the tab for an App.

/** @type {import('/shared/tool-types.js').Tool} */
export const appOpenTool = composeTool("app_open", {

  execute: async (args, ctx) => {
    if (typeof args?.appId !== 'string') return { ok: false, error: 'appId_required' };
    const authority = /** @type {{ openApp?: Function } | undefined} */ (
      /** @type {any} */ (ctx).appAuthority);
    if (!authority?.openApp) return { ok: false, error: 'app_not_available' };
    try {
      const id = await authority.openApp(args.appId);
      return { ok: true, content: JSON.stringify({ opened: id }, null, 2) };
    } catch (e) {
      return { ok: false, error: `app_open_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
});
