import { describe, expect, test } from 'bun:test';
import {
  CONTROLLER_TOOL_MANIFEST,
  controllerHostsTool,
} from '../../extension/shared/controller-tool-manifest.js';

describe('controller tool manifest', () => {
  test('admits only implemented controller tools', () => {
    expect(Object.keys(CONTROLLER_TOOL_MANIFEST.tools)).toEqual(['now']);
    expect(CONTROLLER_TOOL_MANIFEST.tools.now.effects).toEqual([]);
    expect(controllerHostsTool('now')).toBe(true);
    expect(controllerHostsTool('wait_until')).toBe(false);
    expect(controllerHostsTool('__proto__')).toBe(false);
  });
});
