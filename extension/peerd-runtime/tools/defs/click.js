// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const clickTool = composeTool('click', {
  execute: (_args, ctx) => /** @type {any} */ (ctx).pageAuthority.clickOwnedTarget(),
});
