import { describe, expect, test } from 'bun:test';
import { TOOL_METADATA_ORDER } from '../../extension/peerd-runtime/tools/metadata/catalog.js';
import {
  CONTROLLER_OWNED_TOOL_NAMES,
  controllerAuthorityClassForTool,
} from '../../extension/peerd-runtime/controller-tool-ownership.js';

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
});
