// @ts-check

// why: The service worker may load only the frozen implementations that still
// use its temporary legacy dispatcher. Explicit imports make each domain
// migration delete its executable dependency instead of keeping the broad
// built-in catalog reachable through a barrel.
import { readDocTool } from './defs/read-doc.js';
import { fetchUrlTool } from './defs/fetch-url.js';
import { readWebCacheTool } from './defs/read-web-cache.js';
import { siteClientRunTool } from './defs/site-client-run.js';
import { siteClientReadTool } from './defs/site-client-read.js';
import { siteClientWriteTool } from './defs/site-client-write.js';
import { siteCaptureTool } from './defs/site-capture.js';
import { sandboxCreateTool } from './defs/sandbox-create.js';
import { scriptTool } from './defs/script.js';
import { readRunCacheTool } from './defs/read-run-cache.js';
import { editFileTool } from './defs/edit-file.js';
import { toolboxWriteTool } from './defs/toolbox-write.js';
import { toolboxListTool } from './defs/toolbox-list.js';
import { toolboxDeleteTool } from './defs/toolbox-delete.js';
import { a2aRunTool } from './defs/a2a-run.js';

export const LEGACY_TOOL_IMPLEMENTATIONS = Object.freeze([
  readDocTool,
  fetchUrlTool,
  readWebCacheTool,
  siteClientRunTool,
  siteClientReadTool,
  siteClientWriteTool,
  siteCaptureTool,
  sandboxCreateTool,
  scriptTool,
  readRunCacheTool,
  editFileTool,
  toolboxWriteTool,
  toolboxListTool,
  toolboxDeleteTool,
  a2aRunTool,
]);
