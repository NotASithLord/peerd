// @ts-check
// Full execution and inert policy inventories share names, not authority.

import {
  resolveDescriptorOrigins,
  retryClassForDescriptor,
  toToolDescriptor,
} from './metadata/descriptor.js';

/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {ReturnType<typeof import('./metadata/descriptor.js').toToolDescriptor>} ToolDescriptor */

/** @type {Map<string, Tool>} */
const tools = new Map();
/** @type {Map<string, ToolDescriptor>} */
const registeredDescriptors = new Map();

/**
 * Register a tool. Subsequent calls with the same name replace the
 * previous registration — useful for tests that swap in a fake.
 *
 * @param {Tool} tool
 */
export const registerTool = (tool) => {
  if (!tool || typeof tool.name !== 'string' || !tool.name) {
    throw new TypeError('registerTool: tool.name is required');
  }
  if (typeof tool.execute !== 'function') {
    throw new TypeError(`registerTool: tool '${tool.name}' has no execute()`);
  }
  if (typeof tool.primitive !== 'string') {
    throw new TypeError(`registerTool: tool '${tool.name}' is missing the primitive field`);
  }
  tools.set(tool.name, tool);
  registeredDescriptors.set(tool.name, toToolDescriptor(tool));
};

/** @param {string} name @returns {Tool | undefined} */
export const getTool = (name) => tools.get(name);

/** @returns {Tool[]} */
export const listTools = () => [...tools.values()];

/** Clear all registered tools. Test-only — production code never calls this. */
export const clearTools = () => {
  tools.clear();
  registeredDescriptors.clear();
};

/** Full registrations override metadata without exposing execute authority. @param {string} name */
export const getToolDescriptor = (name) => registeredDescriptors.get(name);

export const listToolDescriptors = () => [...registeredDescriptors.values()];

/** @param {string} name @param {any} args @param {any} ctx */
export const resolveRegisteredToolOrigins = (name, args, ctx) => {
  const descriptor = getToolDescriptor(name);
  return descriptor ? resolveDescriptorOrigins(descriptor, args, ctx) : [];
};

/** @param {string} name */
export const retryClassForRegisteredTool = (name) =>
  retryClassForDescriptor(getToolDescriptor(name));
