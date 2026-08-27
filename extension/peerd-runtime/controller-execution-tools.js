// @ts-check

// why: engine selection, creation-result presentation and headless result
// shaping are feature semantics. The service worker exposes only exact
// run-bound engine creation, headless execution and spill custody operations.
import { sandboxCreateTool } from './tools/defs/sandbox-create.js';
import { scriptTool } from './tools/defs/script.js';

export const CONTROLLER_EXECUTION_TOOL_NAMES = Object.freeze([
  'sandbox_create', 'script',
]);

const tools = Object.freeze({ sandbox_create: sandboxCreateTool, script: scriptTool });

export const controllerHostsExecutionTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(tools, name);

/**
 * @param {string} name @param {unknown} args
 * @param {Record<string,Function>} authority @param {Record<string,any>} projection
 */
export const executeControllerExecutionTool = async (
  name, args, authority, projection = {},
) => {
  const tool = tools[/** @type {keyof typeof tools} */ (name)];
  if (!tool) throw Object.assign(new Error('controller execution tool is unavailable'), {
    code: 'controller-execution-tool-unavailable', outcomeKnown: true,
  });
  return tool.execute(args, /** @type {any} */ ({
    executionAuthority: authority,
    session: {
      sessionId: projection.sessionId,
      kind: projection.sessionKind,
    },
  }));
};
