// @ts-check

// The page-code worker may compose these already-admitted Web-actor tools.
// Names live in authority-safe data so the SW can admit the nested lifecycle
// without importing their schemas, implementations, or controller registry.
export const PAGE_PROGRAM_SEMANTIC_TOOL_NAMES = Object.freeze([
  'navigate',
  'click',
  'type',
  'snapshot',
  'read_page',
  'read_state',
  'watch_changes',
  'query_dom',
  'view',
  'login',
  'fetch_url',
  'read_doc',
  'read_result',
  'site_client_read',
  'site_client_write',
  'site_capture',
]);

export const APP_PROGRAM_SEMANTIC_TOOL_NAMES = Object.freeze([
  'app_observe',
  'app_act',
]);

export const APP_PROGRAM_EXACT_OPERATIONS = Object.freeze([
  'turn.app.observe',
  'turn.app.act',
]);

// why: parent binding is an authority decision, so every nested operation
// emitted by the sealed page-program client lives in one finite shared set.
// Keeping the set beside the model-visible surface prevents a newly composed
// helper from being projected yet rejected by the privileged host.
export const PAGE_PROGRAM_EXACT_OPERATIONS = Object.freeze([
  'turn.page.read', 'turn.page.snapshot', 'turn.page.read-state',
  'turn.page.watch-changes', 'turn.page.query-dom', 'turn.page.navigate',
  'turn.page.fill', 'turn.page.click', 'turn.page.login',
  'turn.page.capture-owned',
  'turn.resource.confirm-web-write', 'turn.resource.request-web-text',
  'turn.resource.extract-markdown', 'turn.resource.extract-document',
  'turn.resource.spill-result', 'turn.resource.read-result',
  'turn.site-client.read', 'turn.site-client.commit',
  'turn.site-client.capture-start', 'turn.site-client.capture-stop',
]);

const names = new Set(PAGE_PROGRAM_SEMANTIC_TOOL_NAMES);

/** @param {unknown} name */
export const isPageProgramSemanticTool = (name) =>
  typeof name === 'string' && names.has(name);
