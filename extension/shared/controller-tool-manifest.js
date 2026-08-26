// @ts-check

import {
  TOOL_EXECUTION_PROTOCOL,
  compileToolEffectManifest,
} from './tool-execution-protocol.js';

const manifestSource = {
  protocol: TOOL_EXECUTION_PROTOCOL,
  digest: '98cbe4f2fbc50a5beb3a945689afab399c6e0da8b2b3e1fa453de7034130c5fc',
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
    pod_exec: {
      projectionKeys: ['sessionId'],
      effects: [],
      argumentBytes: 1024 * 1024,
      resultBytes: 2 * 1024 * 1024,
    },
    pod_status: {
      projectionKeys: ['sessionId'],
      effects: [],
    },
    pod_cancel: {
      projectionKeys: ['sessionId'],
      effects: [],
    },
    pod_read: {
      projectionKeys: ['sessionId'],
      effects: [],
      resultBytes: 2 * 1024 * 1024,
    },
    pod_write: {
      projectionKeys: ['sessionId'],
      effects: [],
      argumentBytes: 1024 * 1024,
    },
    pod_destroy: {
      projectionKeys: [],
      effects: [],
    },
    repo_history: {
      projectionKeys: ['actorType', 'actorInstanceId'],
      effects: [],
      resultBytes: 2 * 1024 * 1024,
    },
    repo_version: {
      projectionKeys: ['actorType', 'actorInstanceId'],
      effects: [],
    },
    repo_remote: {
      projectionKeys: ['actorType', 'actorInstanceId'],
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
const podTools = new Set(['pod_exec', 'pod_status', 'pod_cancel', 'pod_read', 'pod_write']);
const repositoryTools = new Set(['pod_destroy', 'repo_history', 'repo_version', 'repo_remote']);

export const controllerToolDomain = (/** @type {unknown} */ name) =>
  typeof name !== 'string' ? null
    : actorTools.has(name) ? 'actor'
      : podTools.has(name) ? 'pod'
        : repositoryTools.has(name) ? 'repository'
          : null;
