// @ts-check

// why: dossier presentation, write planning and run/capture result shaping are
// Web-feature semantics. Exact origin, store, confirmation, worker and document
// custody remain behind the run-bound site-client authority.
import { siteClientRunTool } from './tools/defs/site-client-run.js';
import { siteClientReadTool } from './tools/defs/site-client-read.js';
import { siteClientWriteTool } from './tools/defs/site-client-write.js';
import { siteCaptureTool } from './tools/defs/site-capture.js';

const tools = Object.freeze({
  site_client_run: siteClientRunTool,
  site_client_read: siteClientReadTool,
  site_client_write: siteClientWriteTool,
  site_capture: siteCaptureTool,
});

export const CONTROLLER_SITE_CLIENT_TOOL_NAMES = Object.freeze(Object.keys(tools));

export const controllerHostsSiteClientTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(tools, name);

/** @param {string} name @param {unknown} args @param {Record<string,Function>} authority */
export const executeControllerSiteClientTool = async (name, args, authority) => {
  const tool = tools[/** @type {keyof typeof tools} */ (name)];
  if (!tool) throw Object.assign(new Error('controller site-client tool is unavailable'), {
    code: 'controller-site-client-tool-unavailable', outcomeKnown: true,
  });
  return tool.execute(args, /** @type {any} */ ({ siteClientAuthority: authority }));
};
