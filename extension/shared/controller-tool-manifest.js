// @ts-check

import {
  TOOL_EXECUTION_PROTOCOL,
  compileToolEffectManifest,
} from './tool-execution-protocol.js';

const manifestSource = {
  protocol: TOOL_EXECUTION_PROTOCOL,
  digest: '08c7e3f5a2932a653451c160cd599ff9ba1f5e405c7624979272f2d56ee73fcd',
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
    vm_boot: {
      projectionKeys: ['sessionId'], effects: [], resultBytes: 2 * 1024 * 1024,
    },
    vm_import: {
      projectionKeys: ['sessionId'], effects: [], argumentBytes: 4 * 1024,
    },
    vm_write_file: {
      projectionKeys: ['sessionId'], effects: [], argumentBytes: 1024 * 1024,
    },
    vm_delete: {
      projectionKeys: ['sessionId'], effects: [],
    },
    js_notebook: {
      projectionKeys: ['sessionId'], effects: [], argumentBytes: 1024 * 1024,
      resultBytes: 2 * 1024 * 1024,
    },
    js_write_file: {
      projectionKeys: ['sessionId'], effects: [], argumentBytes: 1024 * 1024,
    },
    js_read_file: {
      projectionKeys: ['sessionId'], effects: [], resultBytes: 2 * 1024 * 1024,
    },
    js_delete: {
      projectionKeys: ['sessionId'], effects: [],
    },
    app_update: {
      projectionKeys: ['sessionId'], effects: [], argumentBytes: 2 * 1024 * 1024,
    },
    app_open: {
      projectionKeys: ['sessionId'], effects: [],
    },
    app_search: {
      projectionKeys: ['sessionId'], effects: [], resultBytes: 2 * 1024 * 1024,
    },
    app_delete: {
      projectionKeys: ['sessionId'], effects: [],
    },
    app_write_file: {
      projectionKeys: ['sessionId'], effects: [], argumentBytes: 1024 * 1024,
    },
    app_read_file: {
      projectionKeys: ['sessionId'], effects: [], resultBytes: 2 * 1024 * 1024,
    },
    app_list_files: {
      projectionKeys: ['sessionId'], effects: [],
    },
    app_delete_file: {
      projectionKeys: ['sessionId'], effects: [],
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
const vmTools = new Set(['vm_boot', 'vm_import', 'vm_write_file', 'vm_delete']);
const notebookTools = new Set(['js_notebook', 'js_write_file', 'js_read_file', 'js_delete']);
const appTools = new Set([
  'app_update', 'app_open', 'app_search', 'app_delete',
  'app_write_file', 'app_read_file', 'app_list_files', 'app_delete_file',
]);

export const controllerToolDomain = (/** @type {unknown} */ name) =>
  typeof name !== 'string' ? null
    : actorTools.has(name) ? 'actor'
      : podTools.has(name) ? 'pod'
        : repositoryTools.has(name) ? 'repository'
          : vmTools.has(name) ? 'vm'
            : notebookTools.has(name) ? 'notebook'
              : appTools.has(name) ? 'app'
                : null;
