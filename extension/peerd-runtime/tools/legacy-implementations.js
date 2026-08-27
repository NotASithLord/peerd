// @ts-check

// why: The service worker may load only the frozen implementations that still
// use its temporary legacy dispatcher. Explicit imports make each domain
// migration delete its executable dependency instead of keeping the broad
// built-in catalog reachable through a barrel.
import { readDocTool } from './defs/read-doc.js';
import { fetchUrlTool } from './defs/fetch-url.js';
import { readResultTool } from './defs/read-result.js';
import { siteClientRunTool } from './defs/site-client-run.js';
import { siteClientReadTool } from './defs/site-client-read.js';
import { siteClientWriteTool } from './defs/site-client-write.js';
import { siteCaptureTool } from './defs/site-capture.js';
import { sandboxCreateTool } from './defs/sandbox-create.js';
import { scriptTool } from './defs/script.js';
import { editFileTool } from './defs/edit-file.js';
import { a2aRunTool } from './defs/a2a-run.js';

export const LEGACY_TOOL_IMPLEMENTATIONS = Object.freeze([
  readDocTool,
  fetchUrlTool,
  readResultTool,
  siteClientRunTool,
  siteClientReadTool,
  siteClientWriteTool,
  siteCaptureTool,
  sandboxCreateTool,
  scriptTool,
  editFileTool,
  a2aRunTool,
]);
