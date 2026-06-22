// @ts-check
// Tool registry.
//
// Modules with a public surface this small (4 functions) often resist
// growing into something more sophisticated for a while — that's fine.
// Registration is a verb the SW invokes at boot; lookup is a verb the
// dispatcher invokes per call. Both stay synchronous and side-effecting
// against module-level state.
//
// Tests should call clearTools() in setup so each case starts from a
// clean slate.

/** @typedef {import('/shared/tool-types.js').Tool} Tool */

/** @type {Map<string, Tool>} */
const tools = new Map();

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
};

/** @param {string} name @returns {Tool | undefined} */
export const getTool = (name) => tools.get(name);

/** @returns {Tool[]} */
export const listTools = () => [...tools.values()];

/** Clear all registered tools. Test-only — production code never calls this. */
export const clearTools = () => { tools.clear(); };
