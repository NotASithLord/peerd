// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const openTabTool = composeTool('open_tab', {
  execute: (_args, ctx) => /** @type {any} */ (ctx).pageAuthority
    .openProtectedBackgroundTab(),
});
