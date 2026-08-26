// @ts-check

// WebVM semantics shared by the orchestrator controller and isolated actor heap.
// Registry, tab, network, disk, and VM-process custody remain behind the exact
// authority methods supplied for one admitted tool call.

import { vmBootTool } from './tools/defs/vm-boot.js';
import { vmImportTool } from './tools/defs/vm-import.js';
import { vmWriteFileTool } from './tools/defs/vm-write-file.js';
import { vmDeleteTool } from './tools/defs/vm-delete.js';

export const CONTROLLER_VM_TOOL_NAMES = Object.freeze([
  'vm_boot', 'vm_import', 'vm_write_file', 'vm_delete',
]);

const tools = Object.freeze({
  vm_boot: vmBootTool,
  vm_import: vmImportTool,
  vm_write_file: vmWriteFileTool,
  vm_delete: vmDeleteTool,
});

export const controllerHostsVmTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(tools, name);

/**
 * @param {string} name
 * @param {unknown} args
 * @param {Record<string,Function>} authority
 */
export const executeControllerVmTool = async (name, args, authority) => {
  const tool = tools[/** @type {keyof typeof tools} */ (name)];
  if (!tool) throw Object.assign(new Error('controller VM tool is unavailable'), {
    code: 'controller-vm-tool-unavailable', outcomeKnown: true,
  });
  return tool.execute(args, /** @type {any} */ ({ vmAuthority: authority }));
};
