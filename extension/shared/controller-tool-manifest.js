// @ts-check

import {
  TOOL_EXECUTION_PROTOCOL,
  compileToolEffectManifest,
} from './tool-execution-protocol.js';

const manifestSource = {
  protocol: TOOL_EXECUTION_PROTOCOL,
  digest: '7bbbfe8ffd7df3cc15e0015f6053b6976b139720f5e88279ae99b3430a4942f0',
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
      effects: [],
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
    app_observe: {
      projectionKeys: ['actorInstanceId'], effects: [], resultBytes: 2 * 1024 * 1024,
    },
    app_act: {
      projectionKeys: ['actorInstanceId'], effects: [], resultBytes: 2 * 1024 * 1024,
    },
    app_code: {
      projectionKeys: ['sessionId', 'actorInstanceId'], effects: [],
      argumentBytes: 1024 * 1024, resultBytes: 2 * 1024 * 1024,
    },
    read_memory: {
      projectionKeys: ['sessionId', 'activeTabOrigin', 'goalActive'], effects: [],
      resultBytes: 2 * 1024 * 1024,
    },
    remember: {
      projectionKeys: ['sessionId', 'activeTabOrigin', 'goalActive'], effects: [],
      argumentBytes: 1024 * 1024,
    },
    todo_init: {
      projectionKeys: ['sessionId', 'activeTabOrigin', 'goalActive'], effects: [],
      argumentBytes: 256 * 1024,
    },
    todo_check: {
      projectionKeys: ['sessionId', 'activeTabOrigin', 'goalActive'], effects: [],
    },
    todo_add: {
      projectionKeys: ['sessionId', 'activeTabOrigin', 'goalActive'], effects: [],
      argumentBytes: 256 * 1024,
    },
    open_tab: { projectionKeys: [], effects: [], argumentBytes: 4 * 1024 },
    read_page: { projectionKeys: [], effects: [], resultBytes: 2 * 1024 * 1024 },
    snapshot: { projectionKeys: [], effects: [], resultBytes: 2 * 1024 * 1024 },
    read_state: { projectionKeys: [], effects: [], resultBytes: 2 * 1024 * 1024 },
    watch_changes: { projectionKeys: [], effects: [], resultBytes: 512 * 1024 },
    query_dom: { projectionKeys: [], effects: [], resultBytes: 2 * 1024 * 1024 },
    page_eval: {
      projectionKeys: [], effects: [], argumentBytes: 256 * 1024,
      resultBytes: 2 * 1024 * 1024,
    },
    page_exec: {
      projectionKeys: [], effects: [], argumentBytes: 512 * 1024,
      resultBytes: 2 * 1024 * 1024,
    },
    page_keys: { projectionKeys: [], effects: [], argumentBytes: 16 * 1024 },
    navigate: { projectionKeys: [], effects: [], argumentBytes: 8 * 1024 },
    type: { projectionKeys: [], effects: [], argumentBytes: 256 * 1024 },
    click: { projectionKeys: [], effects: [], argumentBytes: 32 * 1024 },
    login: { projectionKeys: [], effects: [], argumentBytes: 32 * 1024 },
    page_code: {
      projectionKeys: [], effects: [], argumentBytes: 1024 * 1024,
      resultBytes: 8 * 1024 * 1024,
    },
    capture: { projectionKeys: [], effects: [], resultBytes: 8 * 1024 * 1024 },
    view: { projectionKeys: [], effects: [], resultBytes: 8 * 1024 * 1024 },
    actor_list: { projectionKeys: [], effects: [], resultBytes: 2 * 1024 * 1024 },
    inspect: { projectionKeys: [], effects: [], resultBytes: 2 * 1024 * 1024 },
    wait_until: { projectionKeys: [], effects: [], resultBytes: 4 * 1024 },
    load_skill: {
      projectionKeys: ['sessionId', 'messageCount', 'trimCovered'], effects: [],
      resultBytes: 2 * 1024 * 1024,
    },
    schedule_create: { projectionKeys: [], effects: [], argumentBytes: 64 * 1024 },
    schedule_list: { projectionKeys: [], effects: [], resultBytes: 2 * 1024 * 1024 },
    schedule_cancel: { projectionKeys: [], effects: [], argumentBytes: 4 * 1024 },
    dweb_discover: { projectionKeys: ['sessionId', 'dwebAvailable'], effects: [] },
    dweb_share: { projectionKeys: ['sessionId', 'dwebAvailable'], effects: [] },
    dweb_install: { projectionKeys: ['sessionId', 'dwebAvailable'], effects: [] },
    dweb_peers: { projectionKeys: ['sessionId', 'dwebAvailable'], effects: [] },
    dweb_block: { projectionKeys: ['sessionId', 'dwebAvailable'], effects: [] },
    dweb_discovery: { projectionKeys: ['sessionId', 'dwebAvailable'], effects: [] },
    dweb_guide: { projectionKeys: ['sessionId', 'dwebAvailable'], effects: [] },
  },
};

export const CONTROLLER_TOOL_MANIFEST = compileToolEffectManifest(manifestSource);

export const controllerHostsTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(CONTROLLER_TOOL_MANIFEST.tools, name);

const localTools = new Set(['now', 'complete_goal']);
const actorTools = new Set(['actor_create', 'actor_tasks', 'actor_cancel', 'message_actor']);
const podTools = new Set(['pod_exec', 'pod_status', 'pod_cancel', 'pod_read', 'pod_write']);
const repositoryTools = new Set(['pod_destroy', 'repo_history', 'repo_version', 'repo_remote']);
const vmTools = new Set(['vm_boot', 'vm_import', 'vm_write_file', 'vm_delete']);
const notebookTools = new Set(['js_notebook', 'js_write_file', 'js_read_file', 'js_delete']);
const appTools = new Set([
  'app_update', 'app_open', 'app_search', 'app_delete',
  'app_write_file', 'app_read_file', 'app_list_files', 'app_delete_file',
  'app_observe', 'app_act', 'app_code',
]);
const persistenceTools = new Set([
  'read_memory', 'remember', 'todo_init', 'todo_check', 'todo_add',
]);
const pageTools = new Set([
  'open_tab', 'read_page', 'snapshot', 'read_state', 'watch_changes',
  'query_dom', 'page_eval', 'page_exec', 'page_keys', 'navigate', 'type',
  'click', 'login', 'page_code', 'capture', 'view',
]);
const introspectionTools = new Set([
  'actor_list', 'inspect', 'wait_until', 'load_skill',
]);
const scheduleTools = new Set(['schedule_create', 'schedule_list', 'schedule_cancel']);
const dwebTools = new Set([
  'dweb_discover', 'dweb_share', 'dweb_install', 'dweb_peers',
  'dweb_block', 'dweb_discovery', 'dweb_guide',
]);

export const controllerToolDomain = (/** @type {unknown} */ name) =>
  typeof name !== 'string' ? null
    : localTools.has(name) ? 'local'
      : actorTools.has(name) ? 'actor'
      : podTools.has(name) ? 'pod'
        : repositoryTools.has(name) ? 'repository'
          : vmTools.has(name) ? 'vm'
            : notebookTools.has(name) ? 'notebook'
              : appTools.has(name) ? 'app'
                : persistenceTools.has(name) ? 'persistence'
                  : pageTools.has(name) ? 'page'
                    : introspectionTools.has(name) ? 'introspection'
                      : scheduleTools.has(name) ? 'schedule'
                        : dwebTools.has(name) ? 'dweb'
                          : null;
