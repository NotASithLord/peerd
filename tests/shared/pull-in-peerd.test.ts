import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('extension/shared/pull-in-peerd.js', 'utf8');
// why: use the exact module functions without changing the live browser API.
const load = (browser: any) => new Function('browser', `'use strict';
  ${source.replace("import browser from '/shared/browser-api.js';", '').replace(/^export const /gm, 'const ')}
  return { resolveTarget: typeof resolveTabId === 'function' ? resolveTabId : resolveWindowId, openPanel, panelKind, onPanelOpenChange, listenForSurfaceChanges };
`)(browser);

test('pull-in opens by stable tab ID after a window move, inside the gesture', async () => {
  const current = { id: 71, windowId: 10 };
  const opened: unknown[] = [];
  let inGesture = false;
  const api = load({
    tabs: { getCurrent: async () => ({ ...current }) },
    sidePanel: { open: (target: unknown) => { expect(inGesture).toBe(true); opened.push(target); } },
  });
  api.resolveTarget();
  await Promise.resolve();
  current.windowId = 20;
  inGesture = true;
  api.openPanel();
  inGesture = false;
  expect(opened).toEqual([{ tabId: 71 }]);
});

test('pull-in waits for the tab ID and resyncs a rejected open', async () => {
  let reads = 0;
  const opened: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const api = load({
      tabs: { getCurrent: async () => ({ id: 72, windowId: 11 }) },
      sidePanel: { open: (target: unknown) => { opened.push(target); return Promise.reject(new Error('closed')); } },
      runtime: { sendMessage: async (message: unknown) => { expect(message).toEqual({ type: 'surfaces/get' }); reads++; return { sidePanelOpen: false }; } },
    });
    api.openPanel();
    expect(opened).toEqual([]);
    api.resolveTarget();
    await Promise.resolve();
    api.openPanel();
    await Promise.resolve();
    expect(opened).toEqual([{ tabId: 72 }]);
    expect(reads).toBe(1);
  } finally { console.warn = originalWarn; }
});

test('Firefox keeps its synchronous untargeted sidebar open', () => {
  let opened = 0;
  load({ sidebarAction: { open: () => { opened++; } } }).openPanel();
  expect(opened).toBe(1);
});

test('the panel probe names the surface each browser can open', () => {
  expect(load({ sidePanel: { open: () => {} }, sidebarAction: { open: () => {} } }).panelKind()).toBe('side-panel');
  expect(load({ sidebarAction: { open: () => {} } }).panelKind()).toBe('sidebar');
  expect(load({}).panelKind()).toBe(null);
});

test('a panel listener hears the state at once, then each change the kernel pushes', () => {
  const scope = globalThis as { document?: unknown };
  const saved = scope.document;
  // why: an open panel removes the chip's hint, which the module looks up in the page.
  scope.document = { getElementById: () => null };
  try {
    let push: (message: unknown) => void = () => {};
    const api = load({ runtime: { onMessage: { addListener: (listener: (message: unknown) => void) => { push = listener; } } } });
    const seen: boolean[] = [];
    api.listenForSurfaceChanges();
    api.onPanelOpenChange((open: boolean) => { seen.push(open); });
    push({ type: 'surfaces/changed', sidePanelOpen: true });
    push({ type: 'surfaces/changed', sidePanelOpen: true });
    push({ type: 'surfaces/changed', sidePanelOpen: false });
    expect(seen).toEqual([false, true, false]);
  } finally { scope.document = saved; }
});
