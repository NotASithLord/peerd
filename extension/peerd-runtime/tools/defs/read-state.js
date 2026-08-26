// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const readStateTool = composeTool('read_state', {
  execute: (_args, ctx) => /** @type {any} */ (ctx).pageAuthority
    .readOwnedFrameworkState(),
});
