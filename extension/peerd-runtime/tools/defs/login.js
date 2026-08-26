// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const loginTool = composeTool('login', {
  execute: (_args, ctx) => /** @type {any} */ (ctx).pageAuthority
    .performConfirmedOwnedLogin(),
});
