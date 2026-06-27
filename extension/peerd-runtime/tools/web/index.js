// @ts-check
// peerd-runtime/tools/web — public surface of the web wrappers.
//
// WEB_TOOLS is registered by the SW alongside BUILTIN_TOOLS and
// CLOCK_TOOLS. Only `capture` remains here — a user-facing screenshot
// of the active tab (its pixels are redacted before the model sees them).
//
// call_api, read_article, web_search, and submit_form were all REMOVED: the
// web actor (kind:'web') is the single entry point for web work now. It READS
// via fetch_url (sessionless / same-origin-scoped) or its drive-a-tab DOM
// tools, SEARCHES by navigating to a search engine and reading the results,
// and submits FORMS via its DOM tools (type/click/page_keys) — none of which
// the orchestrator holds. The primitives (primitives.js) are intentionally NOT
// re-exported here; they're internal to the wrappers (fetch_url + capture).
export { captureTool } from './screenshot.js';

import { captureTool } from './screenshot.js';

/** @type {import('/shared/tool-types.js').Tool[]} */
export const WEB_TOOLS = [
  captureTool,
];
