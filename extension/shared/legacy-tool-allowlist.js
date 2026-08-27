// @ts-check

// Temporary migration boundary. This list is deliberately explicit: adding a
// tool to the semantic catalog cannot silently grant it the service worker's
// legacy dispatcher. Every retained domain cutover removes names here in the
// same commit, and the list is deleted with turn.tool.dispatch.
export const LEGACY_TOOL_ALLOWLIST = Object.freeze([
  'site_client_run',
  'site_client_read',
  'site_client_write',
  'site_capture',
  'sandbox_create',
  'script',
  'edit_file',
  'a2a_run',
]);

const allowed = new Set(LEGACY_TOOL_ALLOWLIST);

export const legacyToolAllowed = (/** @type {unknown} */ name) =>
  typeof name === 'string' && allowed.has(name);
