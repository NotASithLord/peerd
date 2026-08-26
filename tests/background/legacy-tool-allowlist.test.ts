import { describe, expect, test } from 'bun:test';
import {
  LEGACY_TOOL_ALLOWLIST,
  legacyToolAllowed,
} from '../../extension/shared/legacy-tool-allowlist.js';
import { CONTROLLER_TOOL_MANIFEST } from '../../extension/shared/controller-tool-manifest.js';
import { TOOL_METADATA_ORDER } from '../../extension/peerd-runtime/tools/metadata/catalog.js';

describe('temporary legacy tool strangler', () => {
  test('is explicit, frozen, unique, and disjoint from controller ownership', () => {
    expect(Object.isFrozen(LEGACY_TOOL_ALLOWLIST)).toBe(true);
    expect(new Set(LEGACY_TOOL_ALLOWLIST).size).toBe(LEGACY_TOOL_ALLOWLIST.length);
    expect(LEGACY_TOOL_ALLOWLIST).toHaveLength(63);
    expect(LEGACY_TOOL_ALLOWLIST.filter((name) =>
      Object.hasOwn(CONTROLLER_TOOL_MANIFEST.tools, name))).toEqual([]);
  });

  test('does not grant newly registered semantic tools automatically', () => {
    expect(TOOL_METADATA_ORDER.filter((name) =>
      !legacyToolAllowed(name) && !Object.hasOwn(CONTROLLER_TOOL_MANIFEST.tools, name)))
      .toEqual([]);
    expect(legacyToolAllowed('future_controller_feature')).toBe(false);
  });
});
