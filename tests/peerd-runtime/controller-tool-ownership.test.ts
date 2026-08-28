import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_METADATA_ORDER } from '../../extension/peerd-runtime/tools/metadata/catalog.js';
import {
  CONTROLLER_OPERATION_GRANTS,
  CONTROLLER_OWNED_TOOL_NAMES,
  controllerAuthorityClassForTool,
  controllerOperationsForTools,
  controllerToolNamesForSpawnedTools,
} from '../../extension/peerd-runtime/controller-tool-ownership.js';
import {
  CONTROLLER_DOMAIN_OPERATIONS,
  controllerDomainOperationPolicy,
} from '../../extension/shared/controller-kernel-quota.js';
import {
  CONTROLLER_LOCAL_TOOL_NAMES,
  controllerHostsLocalTool,
} from '../../extension/peerd-runtime/controller-local-tools.js';
import {
  CONTROLLER_ACTOR_TOOL_NAMES,
  controllerHostsActorTool,
} from '../../extension/peerd-runtime/controller-actor-tools.js';
import {
  CONTROLLER_POD_TOOL_NAMES,
  controllerHostsPodTool,
} from '../../extension/peerd-runtime/controller-pod-tools.js';
import {
  CONTROLLER_REPOSITORY_TOOL_NAMES,
  controllerHostsRepositoryTool,
} from '../../extension/peerd-runtime/controller-repository-tools.js';
import {
  CONTROLLER_VM_TOOL_NAMES,
  controllerHostsVmTool,
} from '../../extension/peerd-runtime/controller-vm-tools.js';
import {
  CONTROLLER_NOTEBOOK_TOOL_NAMES,
  controllerHostsNotebookTool,
} from '../../extension/peerd-runtime/controller-notebook-tools.js';
import {
  CONTROLLER_APP_TOOL_NAMES,
  controllerHostsAppTool,
} from '../../extension/peerd-runtime/controller-app-tools.js';
import {
  CONTROLLER_PERSISTENCE_TOOL_NAMES,
  controllerHostsPersistenceTool,
} from '../../extension/peerd-runtime/controller-persistence-tools.js';
import {
  CONTROLLER_PAGE_TOOL_NAMES,
  controllerHostsPageTool,
} from '../../extension/peerd-runtime/controller-page-tools.js';
import {
  CONTROLLER_RESOURCE_TOOL_NAMES,
  controllerHostsResourceTool,
} from '../../extension/peerd-runtime/controller-resource-tools.js';
import {
  CONTROLLER_SITE_CLIENT_TOOL_NAMES,
  controllerHostsSiteClientTool,
} from '../../extension/peerd-runtime/controller-site-client-tools.js';
import {
  CONTROLLER_EXECUTION_TOOL_NAMES,
  controllerHostsExecutionTool,
} from '../../extension/peerd-runtime/controller-execution-tools.js';
import {
  CONTROLLER_EDITING_TOOL_NAMES,
  controllerHostsEditingTool,
} from '../../extension/peerd-runtime/controller-editing-tools.js';
import {
  CONTROLLER_INTROSPECTION_TOOL_NAMES,
  controllerHostsIntrospectionTool,
} from '../../extension/peerd-runtime/controller-introspection-tools.js';
import {
  CONTROLLER_SCHEDULE_TOOL_NAMES,
  controllerHostsScheduleTool,
} from '../../extension/peerd-runtime/controller-schedule-tools.js';
import {
  CONTROLLER_DWEB_TOOL_NAMES,
  controllerHostsDwebTool,
} from '../../extension/peerd-runtime/controller-dweb-tools.js';

const concreteOwners = [
  ['local', CONTROLLER_LOCAL_TOOL_NAMES, controllerHostsLocalTool],
  ['actor', CONTROLLER_ACTOR_TOOL_NAMES, controllerHostsActorTool],
  ['pod', CONTROLLER_POD_TOOL_NAMES, controllerHostsPodTool],
  ['repository', CONTROLLER_REPOSITORY_TOOL_NAMES, controllerHostsRepositoryTool],
  ['vm', CONTROLLER_VM_TOOL_NAMES, controllerHostsVmTool],
  ['notebook', CONTROLLER_NOTEBOOK_TOOL_NAMES, controllerHostsNotebookTool],
  ['app', CONTROLLER_APP_TOOL_NAMES, controllerHostsAppTool],
  ['persistence', CONTROLLER_PERSISTENCE_TOOL_NAMES, controllerHostsPersistenceTool],
  ['page', CONTROLLER_PAGE_TOOL_NAMES, controllerHostsPageTool],
  ['resource', CONTROLLER_RESOURCE_TOOL_NAMES, controllerHostsResourceTool],
  ['siteclient', CONTROLLER_SITE_CLIENT_TOOL_NAMES, controllerHostsSiteClientTool],
  ['execution', CONTROLLER_EXECUTION_TOOL_NAMES, controllerHostsExecutionTool],
  ['editing', CONTROLLER_EDITING_TOOL_NAMES, controllerHostsEditingTool],
  ['introspection', CONTROLLER_INTROSPECTION_TOOL_NAMES, controllerHostsIntrospectionTool],
  ['schedule', CONTROLLER_SCHEDULE_TOOL_NAMES, controllerHostsScheduleTool],
  ['dweb', CONTROLLER_DWEB_TOOL_NAMES, controllerHostsDwebTool],
] as const;

describe('controller tool ownership', () => {
  test('assigns every catalog tool to exactly one authority class', () => {
    expect(new Set(CONTROLLER_OWNED_TOOL_NAMES).size)
      .toBe(CONTROLLER_OWNED_TOOL_NAMES.length);
    expect([...CONTROLLER_OWNED_TOOL_NAMES].sort())
      .toEqual([...TOOL_METADATA_ORDER].sort());
    for (const name of TOOL_METADATA_ORDER) {
      expect(controllerAuthorityClassForTool(name), name).not.toBeNull();
    }
  });

  test('routes every catalog tool through exactly one matching concrete executor', () => {
    for (const name of TOOL_METADATA_ORDER) {
      const matches = concreteOwners.filter(([, , hosts]) => hosts(name));
      expect(matches.length, name).toBe(1);
      expect(controllerAuthorityClassForTool(name), name)
        .toBe(matches[0]?.[0] ?? null);
    }

    for (const [authorityClass, names, hosts] of concreteOwners) {
      expect([...TOOL_METADATA_ORDER].filter((name) => hosts(name)).sort(), authorityClass)
        .toEqual([...names].sort());
    }

    expect(concreteOwners.some(([, , hosts]) => hosts('unknown_tool'))).toBe(false);
  });

  test('gives every owned tool except the explicit pure clock a nonempty exact operation grant', () => {
    expect(Object.keys(CONTROLLER_OPERATION_GRANTS).sort())
      .toEqual([...CONTROLLER_OWNED_TOOL_NAMES].sort());
    expect(Object.isFrozen(CONTROLLER_OPERATION_GRANTS)).toBe(true);
    for (const [name, operations] of Object.entries(CONTROLLER_OPERATION_GRANTS)) {
      expect(Object.isFrozen(operations), name).toBe(true);
      expect(new Set(operations).size, name).toBe(operations.length);
      expect(operations.length > 0, name).toBe(name !== 'now');
      for (const operation of operations) {
        expect(controllerDomainOperationPolicy(operation), `${name} -> ${operation}`).not.toBeNull();
      }
    }
    expect(controllerOperationsForTools(['now'])).toEqual([]);
  });

  test('keeps every projected operation in the fixed policy and main exact handler', () => {
    const bridge = readFileSync(join(
      process.cwd(), 'extension', 'background', 'controller-turn-bridge.js',
    ), 'utf8');
    const handled = new Set([...bridge.matchAll(/case ['"](turn\.[^'"]+)['"]:/g)]
      .map((match) => match[1]));
    const projected = new Set(controllerOperationsForTools(CONTROLLER_OWNED_TOOL_NAMES));
    for (const operation of projected) {
      expect(Object.hasOwn(CONTROLLER_DOMAIN_OPERATIONS, operation), operation).toBe(true);
      expect(handled.has(operation), operation).toBe(true);
    }
  });

  test('narrows spawned child names in the controller before projecting operations', () => {
    const visible = ['script', 'read_page', 'actor_create', 'complete_goal'];
    expect(controllerToolNamesForSpawnedTools(visible, undefined, false)).toEqual(['script']);
    expect(controllerToolNamesForSpawnedTools(visible, undefined, true))
      .toEqual(['script', 'actor_create']);
    expect(controllerToolNamesForSpawnedTools(visible, ['read_page', 'script'], true))
      .toEqual(['script']);
  });
});
