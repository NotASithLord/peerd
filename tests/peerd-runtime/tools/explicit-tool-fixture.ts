import { dispatchToolCall as dispatchExplicitToolCall } from '../../../extension/peerd-runtime/tools/local-tool-dispatcher.js';
import { toToolDescriptor } from '../../../extension/peerd-runtime/tools/metadata/descriptor.js';

export const createExplicitToolFixture = () => {
  const fixtureTools = new Map<string, any>();
  return Object.freeze({
    set: (tool: any) => { fixtureTools.set(tool.name, tool); },
    clear: () => { fixtureTools.clear(); },
    descriptor: (name: string) => {
      const implementation = fixtureTools.get(name);
      return implementation ? toToolDescriptor(implementation) : undefined;
    },
    dispatch: (call: any, ctx: any) => {
      const implementation = fixtureTools.get(call?.name) ?? null;
      return dispatchExplicitToolCall(call, ctx, {
        descriptor: implementation ? toToolDescriptor(implementation) : undefined,
        execute: async (prepared) => {
          if (!implementation) return {
            ok: false,
            error: `tool_implementation_unavailable:${prepared.tool.name}`,
            code: 'tool-implementation-unavailable',
            outcomeKnown: true,
            outcomeKind: 'pre-effect-failure',
            retryable: true,
          };
          return implementation.execute(prepared.args, prepared.execCtx);
        },
      });
    },
  });
};
