// @ts-check

// Notebook run and file semantics shared by both sealed agent heaps. OPFS,
// worker execution, registry, tab, and repository custody stay behind the
// exact authority methods supplied for one admitted call.

import { jsNotebookTool } from './tools/defs/js-notebook.js';
import { jsWriteFileTool } from './tools/defs/js-write-file.js';
import { jsReadFileTool } from './tools/defs/js-read-file.js';
import { jsDeleteTool } from './tools/defs/js-delete.js';

const tools = Object.freeze({
  js_notebook: jsNotebookTool,
  js_write_file: jsWriteFileTool,
  js_read_file: jsReadFileTool,
  js_delete: jsDeleteTool,
});

export const CONTROLLER_NOTEBOOK_TOOL_NAMES = Object.freeze(Object.keys(tools));

export const controllerHostsNotebookTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(tools, name);

/** @param {string} name @param {unknown} args @param {Record<string,Function>} authority @param {{signal:AbortSignal}} execution */
export const executeControllerNotebookTool = async (name, args, authority, execution) => {
  const tool = tools[/** @type {keyof typeof tools} */ (name)];
  if (!tool) throw Object.assign(new Error('controller Notebook tool is unavailable'), {
    code: 'controller-notebook-tool-unavailable', outcomeKnown: true,
  });
  return tool.execute(args, /** @type {any} */ ({
    notebookAuthority: authority, abortSignal: execution.signal,
  }));
};
