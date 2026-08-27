import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import {
  CONTROLLER_ACTOR_TOOL_NAMES,
  CONTROLLER_APP_TOOL_NAMES,
  CONTROLLER_DWEB_TOOL_NAMES,
  CONTROLLER_EXECUTION_TOOL_NAMES,
  CONTROLLER_EDITING_TOOL_NAMES,
  CONTROLLER_INTROSPECTION_TOOL_NAMES,
  CONTROLLER_LOCAL_TOOL_NAMES,
  CONTROLLER_NOTEBOOK_TOOL_NAMES,
  CONTROLLER_PAGE_TOOL_NAMES,
  CONTROLLER_PERSISTENCE_TOOL_NAMES,
  CONTROLLER_POD_TOOL_NAMES,
  CONTROLLER_REPOSITORY_TOOL_NAMES,
  CONTROLLER_RESOURCE_TOOL_NAMES,
  CONTROLLER_SITE_CLIENT_TOOL_NAMES,
  CONTROLLER_SCHEDULE_TOOL_NAMES,
  CONTROLLER_VM_TOOL_NAMES,
} from '../../extension/peerd-runtime/controller-turn.js';
import {
  controllerAuthorityClassForTool,
  controllerHostsTool,
} from '../../extension/peerd-runtime/controller-tool-ownership.js';
import { TOOL_METADATA_ORDER } from '../../extension/peerd-runtime/tools/metadata/catalog.js';
import {
  CONTROLLER_AUTHORITY_MANIFEST,
  controllerAuthorityClassAllowed,
} from '../../extension/shared/controller-authority-manifest.js';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';

const semanticOwnership = [
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
] as const;

describe('controller authority manifest', () => {
  test('keeps fixed authority classes separate from semantic tool ownership', () => {
    const ownedNames = semanticOwnership.flatMap(([, names]) => names);
    expect(new Set(ownedNames).size).toBe(ownedNames.length);
    expect([...ownedNames].sort()).toEqual([...TOOL_METADATA_ORDER].sort());
    expect(Object.keys(CONTROLLER_AUTHORITY_MANIFEST.tools)).toEqual(
      semanticOwnership.map(([authorityClass]) => authorityClass),
    );
    for (const [authorityClass, names] of semanticOwnership) {
      expect(controllerAuthorityClassAllowed(authorityClass)).toBe(true);
      expect(CONTROLLER_AUTHORITY_MANIFEST.tools[authorityClass]?.effects).toEqual([]);
      for (const name of names) {
        expect(controllerAuthorityClassForTool(name)).toBe(authorityClass);
        expect(controllerHostsTool(name)).toBe(true);
      }
    }
    expect(controllerAuthorityClassAllowed('future_controller_feature')).toBe(false);
    expect(controllerAuthorityClassForTool('future_controller_feature')).toBeNull();
    expect(controllerHostsTool('__proto__')).toBe(false);
  });

  test('digest covers the fixed authority policy', () => {
    const payload = JSON.stringify({
      protocol: CONTROLLER_AUTHORITY_MANIFEST.protocol,
      tools: CONTROLLER_AUTHORITY_MANIFEST.tools,
    });
    expect(createHash('sha256').update(payload).digest('hex'))
      .toBe(CONTROLLER_AUTHORITY_MANIFEST.digest);
  });

  test('the authority root sees fixed classes but not semantic ownership', async () => {
    const graph = await collectStaticModuleGraph(
      EXTENSION_DIR, `${EXTENSION_DIR}/background/kernel-turn-owner.js`,
    );
    const files = new Set([...graph].map((path) => relative(EXTENSION_DIR, path)));
    expect(files.has('shared/controller-authority-manifest.js')).toBe(true);
    expect(files.has('shared/controller-tool-manifest.js')).toBe(false);
    expect(files.has('peerd-runtime/controller-tool-ownership.js')).toBe(false);
    expect(existsSync(`${EXTENSION_DIR}/shared/controller-tool-manifest.js`)).toBe(false);
  });

  test('the controller tool graph owns semantics without the deleted wait feature', async () => {
    const graph = await collectStaticModuleGraph(
      EXTENSION_DIR, `${EXTENSION_DIR}/offscreen/controller-turn-runtime.js`,
    );
    const files = new Set([...graph].map((path) => relative(EXTENSION_DIR, path)));
    expect(files.has('peerd-runtime/controller-tool-ownership.js')).toBe(true);
    expect(files.has('peerd-runtime/clock/wait-execute.js')).toBe(false);
    expect(files.has('peerd-runtime/clock/tools.js')).toBe(false);
  });
});
