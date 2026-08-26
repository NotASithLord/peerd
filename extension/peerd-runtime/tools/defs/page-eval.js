// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const pageEvalTool = composeTool('page_eval', {
  execute: (_args, ctx) => /** @type {any} */ (ctx).pageAuthority
    .evaluateOwnedPageMainWorld(),
});
