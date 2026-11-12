import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// Exercise the actual closure without launching Chrome: these failures happen
// between a successful state and the next state, when its old tab is retiring.
const source = readFileSync('scripts/cdp/e2e-harness.mjs', 'utf8');
const start = source.indexOf('    let lastActionTargetId = null;');
const end = source.indexOf('\n    let target;\n', start);
if (start < 0 || end <= start) throw new Error('The native panel opener boundary changed.');
const makeOpen = (
  send: (method: string, params: any) => Promise<any>,
  windowId: number|null = null,
  opened: any = {},
) => {
  const calls: { method: string, params: any }[] = [];
  let closed = false;
  const opener = {
    send: async (method: string, params: any) => {
      calls.push({ method, params });
      return method === 'Runtime.evaluate' ? opened : {};
    },
    close: () => { closed = true; },
  };
  const open = new Function(
    'browserConn', 'sw', 'waitFor', 'findNativePanelTarget', 'attach', 'created', 'evalIn',
    `${source.slice(start, end)}; return openNativePanelTarget;`,
  )({ send }, { id: 'peerd' }, async (read: () => unknown) => read(), async () => ({ targetId: 'panel' }),
    async () => opener, { webSocketDebuggerUrl: 'ws://owned-opener' },
    async (_page: unknown, expression: string) => expression.includes('getLastFocused') ? windowId : true);
  return { open, calls, isClosed: () => closed };
};

test('modern native panel opens from the Options document with a browser gesture', async () => {
  const browserCalls: string[] = [];
  const fixture = makeOpen(async method => { browserCalls.push(method); return {}; }, 42);
  expect(await fixture.open(100)).toEqual({ targetId: 'panel' });
  expect(fixture.calls).toEqual([
    { method: 'Page.enable', params: undefined },
    { method: 'Page.navigate', params: { url: 'chrome-extension://peerd/options/options.html' } },
    { method: 'Runtime.evaluate', params: {
      expression: 'chrome.sidePanel.open({windowId:42})', awaitPromise: true, returnByValue: true, userGesture: true,
    } },
    { method: 'Page.navigate', params: { url: 'about:blank' } },
  ]);
  expect(fixture.isClosed()).toBe(true);
  expect(browserCalls).toEqual([]);
});

test('modern native panel retains protocol errors and retires the Options document', async () => {
  const browserCalls: string[] = [];
  const fixture = makeOpen(async method => { browserCalls.push(method); return {}; }, 42,
    { exceptionDetails: { text: 'permission denied' } });
  await expect(fixture.open(100)).rejects.toThrow('permission denied');
  expect(fixture.calls.at(-1)).toEqual({ method: 'Page.navigate', params: { url: 'about:blank' } });
  expect(fixture.isClosed()).toBe(true);
  expect(browserCalls).toEqual([]);
});

test('native panel skips a retired toolbar host and reuses the proven live target', async () => {
  const clicks: string[] = [];
  const { open } = makeOpen(async (method, params) => {
    if (method === 'Target.getTargets') return { targetInfos: [
      { type: 'tab', url: 'about:blank', targetId: 'stale' },
      { type: 'tab', url: 'about:blank', targetId: 'live' },
    ] };
    if (method === 'Extensions.triggerAction') {
      clicks.push(params.targetId);
      if (params.targetId === 'stale') throw new Error('Extensions.triggerAction: cannot retrieve host for the provided id');
    }
    return {};
  });
  expect(await open(100)).toEqual({ targetId: 'panel' });
  expect(await open(100)).toEqual({ targetId: 'panel' });
  expect(clicks).toEqual(['stale', 'live', 'live']);
});

test('native panel retains unrelated protocol errors and cannot invent a live host', async () => {
  let error = 'Extensions.triggerAction: permission denied';
  const { open } = makeOpen(async (method) => {
    if (method === 'Target.getTargets') return { targetInfos: [
      { type: 'tab', url: 'about:blank', targetId: 'stale' },
    ] };
    if (method === 'Extensions.triggerAction') throw new Error(error);
    return {};
  });
  await expect(open(100)).rejects.toThrow('permission denied');
  error = 'Extensions.triggerAction: cannot retrieve host for the provided id';
  expect(await open(100)).toBeNull();
});
