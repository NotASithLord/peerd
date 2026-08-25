// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
import { executeNow } from './execute.js';
import { executeWaitUntil } from './wait-execute.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const nowTool = composeTool("now", {
  execute: async () => executeNow(),
});

/** @type {import('/shared/tool-types.js').Tool} */
export const waitUntilTool = composeTool("wait_until", {
  execute: (args, ctx) => executeWaitUntil(args, { signal: ctx.abortSignal }),
});

/** @type {import('/shared/tool-types.js').Tool[]} */
export const CLOCK_TOOLS = [nowTool, waitUntilTool];
