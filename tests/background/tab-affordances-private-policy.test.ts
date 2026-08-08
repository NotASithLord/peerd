import { beforeAll, describe, expect, test } from 'bun:test';

let makeTabAffordances: typeof import('../../extension/background/tab-affordances.js').makeTabAffordances;

beforeAll(async () => {
  (globalThis as any).chrome = { runtime: { id: 'test-extension' } };
  ({ makeTabAffordances } = await import('../../extension/background/tab-affordances.js'));
});

const event = () => ({ addListener: () => {} });

const makeHarness = (liveUrl: string) => {
  const scriptingCalls: any[] = [];
  let panelOpen = true;
  const browser = {
    runtime: {
      getURL: (path: string) => path === 'icons/icon32.png'
        ? 'data:application/octet-stream;base64,AA=='
        : `chrome-extension://test-extension/${path}`,
    },
    tabs: {
      get: async () => ({
        id: 9,
        url: 'https://example.com/work',
        status: 'complete',
        active: true,
        windowId: 1,
      }),
      query: async () => [],
      onActivated: event(),
      onUpdated: event(),
      onRemoved: event(),
    },
    scripting: {
      executeScript: async (request: any) => {
        scriptingCalls.push(request);
        if (scriptingCalls.length === 1) {
          const parsed = new URL(liveUrl);
          return [{
            documentId: 'hint-document',
            result: { origin: parsed.origin, href: parsed.href },
          }];
        }
        return [{ documentId: 'hint-document', result: true }];
      },
    },
    commands: { getAll: async () => [], onCommand: event() },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused: async () => ({ id: 1, focused: true }),
      onFocusChanged: event(),
    },
  };
  const affordances = makeTabAffordances({
    browser,
    uiPorts: {
      broadcast: () => {},
      hasNamed: (name: string) => name === 'sidepanel' && panelOpen,
    },
    denylistStore: { patterns: () => [] },
    closeSidePanel: async () => {},
  });
  return {
    affordances,
    scriptingCalls,
    closePanel: () => { panelOpen = false; },
  };
};

describe('pull-in hint browser target policy', () => {
  test('a direct private URL is never tracked or scripted', async () => {
    const harness = makeHarness('http://127.0.0.1/admin');
    harness.affordances.scheduleWebTabHint(9, 'http://127.0.0.1/admin');
    harness.closePanel();
    await harness.affordances.showWebTabHint(9);
    expect(harness.scriptingCalls).toHaveLength(0);
  });

  test('a public record replaced by a private document receives no hint', async () => {
    const harness = makeHarness('http://192.168.1.20/admin?token=private-secret');
    harness.affordances.scheduleWebTabHint(9, 'https://example.com/work');
    harness.closePanel();
    await harness.affordances.showWebTabHint(9);
    expect(harness.scriptingCalls).toHaveLength(1);
    expect(harness.scriptingCalls[0].target).toEqual({ tabId: 9 });
  });

  test('an allowed hint mutation is pinned to the checked document', async () => {
    const harness = makeHarness('https://example.com/work');
    harness.affordances.scheduleWebTabHint(9, 'https://example.com/work');
    harness.closePanel();
    await harness.affordances.showWebTabHint(9);
    expect(harness.scriptingCalls).toHaveLength(2);
    expect(harness.scriptingCalls[1].target).toEqual({
      tabId: 9,
      documentIds: ['hint-document'],
    });
  });
});
