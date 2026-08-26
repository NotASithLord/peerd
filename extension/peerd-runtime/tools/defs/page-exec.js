// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const pageExecTool = composeTool('page_exec', {
  execute: (_args, ctx) => /** @type {any} */ (ctx).pageAuthority
    .evaluateOwnedPageDebugger(),
});
