// @ts-check

// why: tool definitions, code-run shaping and the choice of exact page
// capability belong to the controller. The injected authority object exposes
// only one-use, named operations already pinned to the admitted call.
import { openTabTool } from './tools/defs/open-tab.js';
import { readPageTool } from './tools/defs/read-page.js';
import { snapshotTool } from './tools/defs/snapshot.js';
import { readStateTool } from './tools/defs/read-state.js';
import { watchChangesTool } from './tools/defs/watch-changes.js';
import { queryDomTool } from './tools/defs/query-dom.js';
import { navigateTool } from './tools/defs/navigate.js';
import { typeTool } from './tools/defs/type.js';
import { clickTool } from './tools/defs/click.js';
import { loginTool } from './tools/defs/login.js';
import { pageCodeTool } from './tools/defs/page-code.js';
import { captureTool } from './tools/web/screenshot.js';
import { viewTool } from './tools/web/view.js';

const tools = Object.freeze({
  open_tab: openTabTool,
  read_page: readPageTool,
  snapshot: snapshotTool,
  read_state: readStateTool,
  watch_changes: watchChangesTool,
  query_dom: queryDomTool,
  navigate: navigateTool,
  type: typeTool,
  click: clickTool,
  login: loginTool,
  page_code: pageCodeTool,
  capture: captureTool,
  view: viewTool,
});

export const CONTROLLER_PAGE_TOOL_NAMES = Object.freeze(Object.keys(tools));

export const controllerHostsPageTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(tools, name);

/**
 * @param {string} name
 * @param {unknown} args
 * @param {Record<string,Function>} authority
 */
export const executeControllerPageTool = async (name, args, authority) => {
  const tool = tools[/** @type {keyof typeof tools} */ (name)];
  if (!tool) throw Object.assign(new Error('controller page tool is unavailable'), {
    code: 'controller-page-tool-unavailable', outcomeKnown: true,
  });
  return tool.execute(args, /** @type {any} */ ({ pageAuthority: authority }));
};
