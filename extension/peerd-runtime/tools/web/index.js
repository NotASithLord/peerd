// @ts-check
// peerd-runtime/tools/web — public surface of the web wrappers.
//
// WEB_TOOLS is registered by the SW alongside BUILTIN_TOOLS and
// CLOCK_TOOLS. The escalation policy is exposed for testing; the
// primitives are intentionally NOT re-exported here — they're
// internal to the wrappers.

export { callApiTool }      from './api.js';
export { readArticleTool }  from './read.js';
export { webSearchTool }    from './search.js';
export { submitFormTool }   from './form.js';
export { captureTool }      from './screenshot.js';

import { callApiTool }     from './api.js';
import { readArticleTool } from './read.js';
import { webSearchTool }   from './search.js';
import { submitFormTool }  from './form.js';
import { captureTool }     from './screenshot.js';

/** @type {import('/shared/tool-types.js').Tool[]} */
export const WEB_TOOLS = [
  callApiTool,
  readArticleTool,
  webSearchTool,
  submitFormTool,
  captureTool,
];

// Policy exposed for tests + future skill authors.
export {
  shouldEscalate,
  looksLikeSpaShell,
  matchesAntiBotTemplate,
  satisfiesExpects,
} from './policy.js';
