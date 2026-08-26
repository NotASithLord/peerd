import { describe, expect, test } from 'bun:test';
import {
  CONTROLLER_PAGE_TOOL_NAMES,
  controllerHostsPageTool,
  executeControllerPageTool,
} from '../../extension/peerd-runtime/controller-page-tools.js';

describe('controller-owned page semantics', () => {
  test('the page catalog is finite and excludes caller-selected operations', () => {
    expect(Object.isFrozen(CONTROLLER_PAGE_TOOL_NAMES)).toBe(true);
    expect(controllerHostsPageTool('navigate')).toBe(true);
    expect(controllerHostsPageTool('page_code')).toBe(true);
    expect(controllerHostsPageTool('browser.call')).toBe(false);
    expect(controllerHostsPageTool('__proto__')).toBe(false);
  });

  test('selects one named capability while retaining model-facing formatting', async () => {
    let calls = 0;
    const result: any = await executeControllerPageTool(
      'navigate', { url: 'https://example.test' }, {
        navigateOwnedTab: async () => {
          calls += 1;
          return { ok: true, content: JSON.stringify({ url: 'https://example.test/' }) };
        },
      },
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: true });
    expect(JSON.parse(result.content)).toEqual({ url: 'https://example.test/' });
  });

  test('cannot redirect an admitted tool to another authority method', async () => {
    let clicked = 0;
    await expect(executeControllerPageTool('navigate', {}, {
      clickOwnedTarget: async () => { clicked += 1; },
    })).rejects.toThrow();
    expect(clicked).toBe(0);
  });
});
