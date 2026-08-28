// @ts-check

import {
  CONTROLLER_LOCAL_TOOL_NAMES,
} from './controller-local-tools.js';
import {
  CONTROLLER_ACTOR_TOOL_NAMES,
} from './controller-actor-tools.js';
import {
  CONTROLLER_POD_TOOL_NAMES,
} from './controller-pod-tools.js';
import {
  CONTROLLER_REPOSITORY_TOOL_NAMES,
} from './controller-repository-tools.js';
import {
  CONTROLLER_VM_TOOL_NAMES,
} from './controller-vm-tools.js';
import {
  CONTROLLER_NOTEBOOK_TOOL_NAMES,
} from './controller-notebook-tools.js';
import {
  CONTROLLER_APP_TOOL_NAMES,
} from './controller-app-tools.js';
import {
  CONTROLLER_PERSISTENCE_TOOL_NAMES,
} from './controller-persistence-tools.js';
import {
  CONTROLLER_PAGE_TOOL_NAMES,
} from './controller-page-tools.js';
import {
  CONTROLLER_RESOURCE_TOOL_NAMES,
} from './controller-resource-tools.js';
import {
  CONTROLLER_SITE_CLIENT_TOOL_NAMES,
} from './controller-site-client-tools.js';
import {
  CONTROLLER_EXECUTION_TOOL_NAMES,
} from './controller-execution-tools.js';
import {
  CONTROLLER_EDITING_TOOL_NAMES,
} from './controller-editing-tools.js';
import {
  CONTROLLER_INTROSPECTION_TOOL_NAMES,
} from './controller-introspection-tools.js';
import {
  CONTROLLER_SCHEDULE_TOOL_NAMES,
} from './controller-schedule-tools.js';
import {
  CONTROLLER_DWEB_TOOL_NAMES,
} from './controller-dweb-tools.js';
import {
  filterActorSurface,
  filterByGoalActive,
  mainAgentDescriptors,
} from './tools/exposure.js';

/** @type {ReadonlyArray<readonly [string, readonly string[]]>} */
const authorityTools = [
  ['local', CONTROLLER_LOCAL_TOOL_NAMES],
  ['actor', CONTROLLER_ACTOR_TOOL_NAMES],
  ['pod', CONTROLLER_POD_TOOL_NAMES],
  ['repository', CONTROLLER_REPOSITORY_TOOL_NAMES],
  ['vm', CONTROLLER_VM_TOOL_NAMES],
  ['notebook', CONTROLLER_NOTEBOOK_TOOL_NAMES],
  ['app', CONTROLLER_APP_TOOL_NAMES],
  ['persistence', CONTROLLER_PERSISTENCE_TOOL_NAMES],
  ['page', CONTROLLER_PAGE_TOOL_NAMES],
  ['resource', CONTROLLER_RESOURCE_TOOL_NAMES],
  ['siteclient', CONTROLLER_SITE_CLIENT_TOOL_NAMES],
  ['execution', CONTROLLER_EXECUTION_TOOL_NAMES],
  ['editing', CONTROLLER_EDITING_TOOL_NAMES],
  ['introspection', CONTROLLER_INTROSPECTION_TOOL_NAMES],
  ['schedule', CONTROLLER_SCHEDULE_TOOL_NAMES],
  ['dweb', CONTROLLER_DWEB_TOOL_NAMES],
];

const ownedRows = authorityTools.flatMap(([authorityClass, names]) =>
  names.map((name) => /** @type {[string,string]} */ ([name, authorityClass])));
const ownedNames = ownedRows.map(([name]) => name);
if (new Set(ownedNames).size !== ownedNames.length) {
  throw new TypeError('controller-tool-owner-duplicate');
}

const ownership = new Map(ownedRows);

export const CONTROLLER_OWNED_TOOL_NAMES = Object.freeze([...ownedNames]);

export const controllerAuthorityClassForTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' ? ownership.get(name) ?? null : null;

export const controllerHostsTool = (/** @type {unknown} */ name) =>
  controllerAuthorityClassForTool(name) !== null;

// Semantic tool narrowing is projected into exact host operations before a
// spawned session is persisted. The authority kernel stores and intersects the
// resulting operation set; it never needs this tool-name map in its native graph.
const operationGrantRows = {
  now: [],
  complete_goal: ['turn.goal.complete'],
  actor_create: ['turn.actor.spawn-sync', 'turn.actor.spawn-async'],
  actor_tasks: ['turn.actor.tasks'],
  actor_cancel: ['turn.actor.cancel'],
  message_actor: ['turn.actor.message'],
  pod_exec: ['turn.pod.resolve', 'turn.pod.read-remote', 'turn.pod.confirm-git', 'turn.pod.exec'],
  pod_status: ['turn.pod.resolve', 'turn.pod.status'],
  pod_cancel: ['turn.pod.resolve', 'turn.pod.cancel'],
  pod_read: ['turn.pod.resolve', 'turn.pod.read-file'],
  pod_write: ['turn.pod.resolve', 'turn.pod.write-file'],
  pod_destroy: ['turn.repository.read-pod', 'turn.repository.destroy-pod'],
  repo_history: [
    'turn.repository.read-status', 'turn.repository.read-history',
    'turn.repository.read-remote', 'turn.repository.read-diff',
  ],
  repo_version: [
    'turn.repository.read-status', 'turn.repository.read-history',
    'turn.repository.read-diff', 'turn.repository.confirm-restore',
    'turn.repository.checkpoint', 'turn.repository.branch',
    'turn.repository.checkout', 'turn.repository.restore',
  ],
  repo_remote: [
    'turn.repository.read-remote', 'turn.repository.confirm-remote',
    'turn.repository.link', 'turn.repository.fetch', 'turn.repository.push',
  ],
  vm_boot: ['turn.vm.read', 'turn.vm.list', 'turn.vm.set-default', 'turn.vm.run'],
  vm_import: ['turn.vm.import-file'],
  vm_write_file: ['turn.vm.write-text-file'],
  vm_delete: ['turn.vm.read', 'turn.vm.destroy'],
  js_notebook: [
    'turn.notebook.read', 'turn.notebook.list',
    'turn.notebook.set-default', 'turn.notebook.run',
  ],
  js_write_file: ['turn.notebook.write-file'],
  js_read_file: ['turn.notebook.read-file'],
  js_delete: ['turn.notebook.read', 'turn.notebook.destroy'],
  app_update: ['turn.app.update'],
  app_open: ['turn.app.open'],
  app_search: ['turn.app.search'],
  app_delete: ['turn.app.read', 'turn.app.delete'],
  app_write_file: ['turn.app.write-file'],
  app_read_file: ['turn.app.read-file'],
  app_list_files: ['turn.app.list-files'],
  app_delete_file: ['turn.app.delete-file'],
  app_observe: ['turn.app.observe'],
  app_act: ['turn.app.act'],
  app_code: ['turn.app.run-code'],
  read_memory: ['turn.memory.read-scope', 'turn.memory.read-subtree'],
  remember: ['turn.memory.write'],
  todo_init: ['turn.todo.read', 'turn.todo.replace'],
  todo_check: ['turn.todo.read', 'turn.todo.replace'],
  todo_add: ['turn.todo.read', 'turn.todo.replace'],
  open_tab: ['turn.page.open-tab'],
  read_page: ['turn.page.read'],
  snapshot: ['turn.page.snapshot'],
  read_state: ['turn.page.read-state'],
  watch_changes: ['turn.page.watch-changes'],
  query_dom: ['turn.page.query-dom'],
  navigate: ['turn.page.navigate'],
  type: ['turn.page.fill'],
  click: ['turn.page.click'],
  login: ['turn.page.login'],
  page_code: ['turn.page.run-program'],
  capture: ['turn.page.capture-foreground'],
  view: ['turn.page.capture-owned'],
  read_doc: ['turn.resource.extract-document', 'turn.resource.spill-result'],
  fetch_url: [
    'turn.resource.confirm-web-write', 'turn.resource.request-web-text',
    'turn.resource.extract-markdown', 'turn.resource.spill-result',
  ],
  read_result: ['turn.resource.read-result'],
  site_client_read: ['turn.site-client.read'],
  site_client_run: ['turn.site-client.run'],
  site_client_write: ['turn.site-client.read', 'turn.site-client.commit'],
  site_capture: ['turn.site-client.capture-start', 'turn.site-client.capture-stop'],
  sandbox_create: [
    'turn.execution.create-webvm', 'turn.execution.create-notebook',
    'turn.execution.create-pod', 'turn.execution.create-app',
  ],
  script: ['turn.execution.run-script', 'turn.execution.spill-script'],
  edit_file: ['turn.editing.read-target', 'turn.editing.write-target'],
  actor_list: ['turn.introspection.actor-roster'],
  inspect: [
    'turn.introspection.provider-posture', 'turn.introspection.storage-snapshot',
    'turn.introspection.automatable-tabs', 'turn.introspection.denylist-patterns',
    'turn.introspection.audit-entries',
  ],
  load_skill: ['turn.introspection.installed-skill'],
  schedule_create: ['turn.schedule.arm-confirmed-routine'],
  schedule_list: ['turn.schedule.read-routines'],
  schedule_cancel: ['turn.schedule.cancel-routine'],
  dweb_discover: ['turn.dweb.discover-apps'],
  dweb_share: ['turn.dweb.publish-confirmed-app'],
  dweb_install: ['turn.dweb.install-confirmed-app'],
  dweb_peers: ['turn.dweb.read-peers'],
  dweb_block: ['turn.dweb.set-peer-blocked'],
  dweb_discovery: ['turn.dweb.set-discovery-enabled'],
  a2a_run: ['turn.dweb.run-mesh-program'],
};

/** @type {Readonly<Record<string,readonly string[]>>} */
export const CONTROLLER_OPERATION_GRANTS = Object.freeze(Object.fromEntries(
  Object.entries(operationGrantRows).map(([name, operations]) =>
    [name, Object.freeze(operations)]),
));

export const controllerOperationsForTools = (/** @type {Iterable<string>} */ names) =>
  Object.freeze([...new Set([...names].flatMap((name) =>
    CONTROLLER_OPERATION_GRANTS[name] ?? []))]);

export const controllerOperationsForSpawnedTools = (
  /** @type {Iterable<string>} */ visibleNames,
  /** @type {unknown} */ requestedNames,
  /** @type {boolean} */ allowRecursion,
) => {
  const spawnable = filterByGoalActive(filterActorSurface(mainAgentDescriptors(
    [...visibleNames].map((name) => ({ name })),
  )), false).filter((tool) => allowRecursion || tool.name !== 'actor_create');
  const requested = Array.isArray(requestedNames)
    ? new Set(requestedNames.filter((name) => typeof name === 'string')) : null;
  return controllerOperationsForTools(spawnable
    .filter((tool) => !requested || requested.has(tool.name))
    .map((tool) => tool.name));
};
