// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const readPageTool = composeTool('read_page', {
  execute: (_args, ctx) => /** @type {any} */ (ctx).pageAuthority.readOwnedPage(),
});
