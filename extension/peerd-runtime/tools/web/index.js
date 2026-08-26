// @ts-check
// peerd-runtime/tools/web — public surface of the web wrappers.
//
// WEB_TOOLS remains the universal web-wrapper inventory. Controller ownership
// removed it from service-worker registration. Two tools live here: `capture` — a user-facing screenshot of the
// active tab (its pixels are redacted before the model sees them) — and `view`,
// an actor-only screenshot whose pixels DO reach the model as a vision input (so
// it can reason about canvas/Figma/game pages the DOM tools go blind on); view's
// untrusted-image boundary is the same as read_page, hence actor-only.
//
// call_api, read_article, web_search, and submit_form were all REMOVED: the
// web actor (kind:'web') is the single entry point for web work now. It READS
// via fetch_url (sessionless / same-origin-scoped) or its drive-a-tab DOM
// tools, SEARCHES by navigating to a search engine and reading the results,
// and submits same-origin forms via its DOM tools (type/click). These
// capabilities stay off the orchestrator. The primitives (primitives.js) are intentionally NOT
// re-exported here; they're internal to the wrappers (fetch_url + capture + view).
/** @type {import('/shared/tool-types.js').Tool[]} */
export const WEB_TOOLS = [];
