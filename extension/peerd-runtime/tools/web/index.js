// @ts-check
// peerd-runtime/tools/web — public surface of the web wrappers.
//
// WEB_TOOLS is registered by the SW alongside BUILTIN_TOOLS and
// CLOCK_TOOLS. The escalation policy is exposed for testing; the
// primitives are intentionally NOT re-exported here — they're
// internal to the wrappers.

// call_api + read_article were REMOVED: the web actor (kind:'web') is the single entry
// point for web reads now — fetch_url (sessionless / same-origin-scoped) covers
// call_api's function, and the actor's drive-a-tab path covers read_article's. The
// orchestrator keeps web_search (URL discovery) + the page-action wrappers below.
export { webSearchTool }    from './search.js';
export { submitFormTool }   from './form.js';
export { captureTool }      from './screenshot.js';

import { webSearchTool }   from './search.js';
import { submitFormTool }  from './form.js';
import { captureTool }     from './screenshot.js';

/** @type {import('/shared/tool-types.js').Tool[]} */
export const WEB_TOOLS = [
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
