import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_METADATA_ORDER } from '../../extension/peerd-runtime/tools/metadata/catalog.js';
import {
  CONTROLLER_OPERATION_GRANTS,
  CONTROLLER_OWNED_TOOL_NAMES,
  controllerAuthorityClassForTool,
  controllerOperationsForTools,
} from '../../extension/peerd-runtime/controller-tool-ownership.js';
import {
  CONTROLLER_DOMAIN_OPERATIONS,
  controllerDomainOperationPolicy,
} from '../../extension/shared/controller-kernel-quota.js';

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
});
