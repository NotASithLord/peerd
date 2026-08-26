// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const navigateTool = composeTool('navigate', {
  execute: (_args, ctx) => /** @type {any} */ (ctx).pageAuthority.navigateOwnedTab(),
});
