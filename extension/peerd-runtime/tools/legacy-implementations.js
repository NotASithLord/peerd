// @ts-check

// why: The service worker may load only the frozen implementations that still
// use its temporary legacy dispatcher. Explicit imports make each domain
// migration delete its executable dependency instead of keeping the broad
// built-in catalog reachable through a barrel.
import { sandboxCreateTool } from './defs/sandbox-create.js';
import { scriptTool } from './defs/script.js';
import { editFileTool } from './defs/edit-file.js';
import { a2aRunTool } from './defs/a2a-run.js';

export const LEGACY_TOOL_IMPLEMENTATIONS = Object.freeze([
  sandboxCreateTool,
  scriptTool,
  editFileTool,
  a2aRunTool,
]);
