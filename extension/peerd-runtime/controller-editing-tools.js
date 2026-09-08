// @ts-check

// why: patch parsing, conflict detection and result shaping are controller
// semantics. The kernel owns only the exact admitted App/Notebook target.
import { editFileTool } from './tools/defs/edit-file.js';

export const CONTROLLER_EDITING_TOOL_NAMES = Object.freeze(['edit_file']);

export const controllerHostsEditingTool = (/** @type {unknown} */ name) =>
  name === 'edit_file';

/** @param {string} name @param {unknown} args @param {Record<string,Function>} authority */
export const executeControllerEditingTool = async (name, args, authority) => {
  if (name !== 'edit_file') throw Object.assign(
    new Error('controller editing tool is unavailable'), {
      code: 'controller-editing-tool-unavailable', outcomeKnown: true,
    },
  );
  return editFileTool.execute(args, /** @type {any} */ ({ editingAuthority: authority }));
};
