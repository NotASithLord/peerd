// @ts-check

// why: parsing, document/result shaping, fencing and paging are feature
// semantics. The controller receives only exact run-bound resource operations;
// browser, network and opaque spill custody stay in the service worker.
import { fetchUrlTool } from './tools/defs/fetch-url.js';
import { readDocTool } from './tools/defs/read-doc.js';
import { readResultTool } from './tools/defs/read-result.js';

const tools = Object.freeze({
  read_doc: readDocTool,
  fetch_url: fetchUrlTool,
  read_result: readResultTool,
});

export const CONTROLLER_RESOURCE_TOOL_NAMES = Object.freeze(Object.keys(tools));

export const controllerHostsResourceTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(tools, name);

/**
 * @param {string} name
 * @param {unknown} args
 * @param {Record<string,Function>} authority
 * @param {{runtimeCapabilities?:unknown}} projection
 */
export const executeControllerResourceTool = async (
  name, args, authority, projection = {},
) => {
  const tool = tools[/** @type {keyof typeof tools} */ (name)];
  if (!tool) throw Object.assign(new Error('controller resource tool is unavailable'), {
    code: 'controller-resource-tool-unavailable', outcomeKnown: true,
  });
  return tool.execute(args, /** @type {any} */ ({
    resourceAuthority: authority,
    runtimeCapabilities: projection.runtimeCapabilities,
  }));
};
