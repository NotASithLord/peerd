// @ts-check
// Controller/test-only semantic lookup around the fixed authority lifecycle.

import { getTool, getToolDescriptor } from './registry.js';
import {
  executePreparedToolCall,
  prepareToolCall,
  settleToolCall,
} from './dispatcher.js';
import { compileUserHook } from './hooks/compile.js';
import { DEFAULT_HOOKS } from './hooks/defaults/index.js';

/**
 * Build the complete hook population inside each fresh semantic realm. Default
 * hooks are code-owned and therefore cannot disappear with controller lease
 * retirement; user hooks are recompiled from the bounded durable projection.
 * @param {unknown} records
 */
export const semanticHooksFor = (records) => Object.freeze([
  ...DEFAULT_HOOKS,
  ...(Array.isArray(records) ? records.flatMap((record) => {
    if (record?.enabled === false) return [];
    try {
      const compiled = compileUserHook(record);
      // The executable realm does not need the mutable persistence record.
      // Freeze the code-bearing hook itself so another user hook cannot alter
      // a later hook or an always-on policy hook through shared references.
      const { _record: _persistenceOnly, ...hook } = compiled;
      return [Object.freeze(hook)];
    } catch (cause) {
      const id = typeof record?.id === 'string' && record.id
        ? record.id.slice(0, 128) : 'invalid-user-hook';
      const detail = /** @type {{message?:string}} */ (cause)?.message ?? 'compile failed';
      const event = record?.event === 'post-tool-use'
        ? 'post-tool-use' : 'pre-tool-use';
      return [Object.freeze({
        id: `${id}-compile-failure`, event, enabled: true, order: -1, match: '*',
        run: () => {
          if (event === 'post-tool-use') throw new Error(
            `${id}: configured post-hook unavailable (${detail.slice(0, 256)})`,
          );
          return {
            action: /** @type {const} */ ('block'),
            reason: `${id}: configured pre-hook unavailable (${detail.slice(0, 256)}) — failing closed`,
          };
        },
      })];
    }
  }) : []),
]);

/**
 * Execute a locally registered semantic tool through the shared authority
 * lifecycle. Production controller calls use an exact authority binding and
 * therefore never import this registry-backed convenience path into the SW.
 * @param {import('/shared/tool-types.js').ToolCall} call
 * @param {any} ctx
 * @param {{descriptor?:any,execute?:(prepared:Record<string, any>)=>Promise<any>|any}} [options]
 */
export const dispatchToolCall = async (call, ctx, options = {}) => {
  const descriptor = options.descriptor?.name === call.name
    ? options.descriptor : getToolDescriptor(call.name);
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
