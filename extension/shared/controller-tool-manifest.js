// @ts-check

import {
  TOOL_EXECUTION_PROTOCOL,
  compileToolEffectManifest,
} from './tool-execution-protocol.js';

export const CONTROLLER_TOOL_MANIFEST = compileToolEffectManifest({
  protocol: TOOL_EXECUTION_PROTOCOL,
  digest: '81b7b8a5e79cfa98372778db825044c4faa6d2d8b5e651b363d6eb3f3abffc72',
  tools: {
    now: {
      projectionKeys: [],
      effects: [],
      argumentBytes: 64,
      projectionBytes: 64,
      resultBytes: 4 * 1024,
      pendingEffects: 1,
    },
    complete_goal: {
      projectionKeys: [],
      effects: [{
        method: 'endGoal', operation: 'goal.end', riskClass: 'control',
        requestSchema: {
          type: 'object', properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
        resultSchema: {
          type: 'object', properties: { ended: { type: 'boolean' } }, required: ['ended'],
        },
      }],
    },
  },
});

export const controllerHostsTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(CONTROLLER_TOOL_MANIFEST.tools, name);
