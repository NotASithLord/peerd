// @ts-check

// The page-code worker may compose these already-admitted Web-actor tools.
// Names live in authority-safe data so the SW can admit the nested lifecycle
// without importing their schemas, implementations, or controller registry.
export const PAGE_PROGRAM_SEMANTIC_TOOL_NAMES = Object.freeze([
  'fetch_url',
  'read_doc',
  'read_result',
  'site_client_read',
  'site_client_write',
  'site_capture',
]);

const names = new Set(PAGE_PROGRAM_SEMANTIC_TOOL_NAMES);

/** @param {unknown} name */
export const isPageProgramSemanticTool = (name) =>
  typeof name === 'string' && names.has(name);
