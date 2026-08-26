import { describe, expect, test } from 'bun:test';
import {
  LEGACY_TOOL_ALLOWLIST,
  legacyToolAllowed,
} from '../../extension/shared/legacy-tool-allowlist.js';
import {
  controllerHostsTool,
} from '../../extension/peerd-runtime/controller-tool-ownership.js';
import { TOOL_METADATA_ORDER } from '../../extension/peerd-runtime/tools/metadata/catalog.js';
import { LEGACY_TOOL_IMPLEMENTATIONS } from '../../extension/peerd-runtime/tools/legacy-implementations.js';

describe('temporary legacy tool strangler', () => {
  test('is explicit, frozen, unique, and disjoint from controller ownership', () => {
    expect(Object.isFrozen(LEGACY_TOOL_ALLOWLIST)).toBe(true);
    expect(new Set(LEGACY_TOOL_ALLOWLIST).size).toBe(LEGACY_TOOL_ALLOWLIST.length);
    expect(LEGACY_TOOL_ALLOWLIST).toHaveLength(17);
    expect(LEGACY_TOOL_ALLOWLIST.filter(controllerHostsTool)).toEqual([]);
  });

  test('does not grant newly registered semantic tools automatically', () => {
    expect(TOOL_METADATA_ORDER.filter((name) =>
      !legacyToolAllowed(name) && !controllerHostsTool(name)))
      .toEqual([]);
    expect(legacyToolAllowed('future_controller_feature')).toBe(false);
  });

  test('loads exactly the frozen legacy implementations without a catalog barrel', () => {
    expect(LEGACY_TOOL_IMPLEMENTATIONS.map(({ name }) => name)).toEqual([...LEGACY_TOOL_ALLOWLIST]);
  });
});
