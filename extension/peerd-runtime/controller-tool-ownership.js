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
