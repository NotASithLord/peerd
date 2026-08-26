// @ts-check

// App lifecycle and file semantics shared by both sealed agent heaps. OPFS,
// registry, tab, repository, and session custody stay behind the exact App
// authority supplied for one admitted call.

import { appUpdateTool } from './tools/defs/app-update.js';
import { appOpenTool } from './tools/defs/app-open.js';
import { appSearchTool } from './tools/defs/app-search.js';
import { appDeleteTool } from './tools/defs/app-delete.js';
import { appWriteFileTool } from './tools/defs/app-write-file.js';
import { appReadFileTool } from './tools/defs/app-read-file.js';
import { appListFilesTool } from './tools/defs/app-list-files.js';
import { appDeleteFileTool } from './tools/defs/app-delete-file.js';
import { appObserveTool } from './tools/defs/app-observe.js';
import { appActTool } from './tools/defs/app-act.js';
import { appCodeTool } from './tools/defs/app-code.js';

export const CONTROLLER_APP_TOOL_NAMES = Object.freeze([
  'app_update', 'app_open', 'app_search', 'app_delete',
  'app_write_file', 'app_read_file', 'app_list_files', 'app_delete_file',
  'app_observe', 'app_act', 'app_code',
]);

const tools = Object.freeze({
  app_update: appUpdateTool,
  app_open: appOpenTool,
  app_search: appSearchTool,
  app_delete: appDeleteTool,
  app_write_file: appWriteFileTool,
  app_read_file: appReadFileTool,
  app_list_files: appListFilesTool,
  app_delete_file: appDeleteFileTool,
  app_observe: appObserveTool,
  app_act: appActTool,
  app_code: appCodeTool,
});

export const controllerHostsAppTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(tools, name);

/** @param {string} name @param {unknown} args @param {Record<string,Function>} authority @param {Record<string,unknown>} [projection] */
export const executeControllerAppTool = async (name, args, authority, projection = {}) => {
  const tool = tools[/** @type {keyof typeof tools} */ (name)];
  if (!tool) throw Object.assign(new Error('controller App tool is unavailable'), {
    code: 'controller-app-tool-unavailable', outcomeKnown: true,
  });
  return tool.execute(args, /** @type {any} */ ({
    appAuthority: authority,
    actorInstanceId: projection.actorInstanceId,
  }));
};
