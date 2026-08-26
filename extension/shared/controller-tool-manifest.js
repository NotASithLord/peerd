// @ts-check

import {
  TOOL_EXECUTION_PROTOCOL,
  compileToolEffectManifest,
} from './tool-execution-protocol.js';

const manifestSource = {
  protocol: TOOL_EXECUTION_PROTOCOL,
  digest: 'd34b1856e74b2dc1cf522b389c3d0e30859905621220aa60d24c92a6d4954fe6',
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
    actor_create: {
      projectionKeys: ['sessionId', 'sessionDepth', 'sessionKind', 'inbound'],
      effects: [],
    },
    actor_tasks: {
      projectionKeys: [],
      effects: [],
    },
    actor_cancel: {
      projectionKeys: [],
      effects: [],
    },
    message_actor: {
      projectionKeys: ['sessionId', 'sessionKind', 'inbound'],
      effects: [],
    },
  },
};

export const CONTROLLER_TOOL_MANIFEST = compileToolEffectManifest(manifestSource);

// The generic effect host is temporary and may execute only the two tools it
// already owned. Actor tools use exact named actor authority operations.
export const CONTROLLER_EFFECT_TOOL_MANIFEST = compileToolEffectManifest({
  ...manifestSource,
  tools: {
    now: manifestSource.tools.now,
    complete_goal: manifestSource.tools.complete_goal,
  },
});

export const controllerHostsTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(CONTROLLER_TOOL_MANIFEST.tools, name);

const actorTools = new Set(['actor_create', 'actor_tasks', 'actor_cancel', 'message_actor']);

export const controllerToolDomain = (/** @type {unknown} */ name) =>
  typeof name === 'string' && actorTools.has(name) ? 'actor' : null;
