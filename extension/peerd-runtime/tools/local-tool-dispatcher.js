// @ts-check
// Controller/test-only semantic lookup around the fixed authority lifecycle.

import { getTool, getToolDescriptor } from './registry.js';
import {
  executePreparedToolCall,
  prepareToolCall,
  settleToolCall,
} from './dispatcher.js';

/**
 * Execute a locally registered semantic tool through the shared authority
 * lifecycle. Production controller calls use an exact authority binding and
 * therefore never import this registry-backed convenience path into the SW.
 * @param {import('/shared/tool-types.js').ToolCall} call
 * @param {any} ctx
 * @param {{execute?:(prepared:Record<string, any>)=>Promise<any>|any}} [options]
 */
export const dispatchToolCall = async (call, ctx, options = {}) => {
  const descriptor = getToolDescriptor(call.name);
  const prepared = /** @type {any} */ (await prepareToolCall(call, ctx, descriptor));
  if (prepared?.prepared !== true) return prepared;
  const execute = options.execute ?? ((request) => {
    const implementation = getTool(request.tool.name);
    if (!implementation || getToolDescriptor(request.tool.name) !== request.tool) {
      return {
        ok: false,
        error: `tool_implementation_unavailable:${request.tool.name}`,
        code: 'tool-implementation-unavailable',
        outcomeKnown: true,
        outcomeKind: /** @type {const} */ ('pre-effect-failure'),
        retryable: true,
      };
    }
    return implementation.execute(request.args, request.execCtx);
  });
  return settleToolCall(prepared, await executePreparedToolCall(prepared, execute));
};
