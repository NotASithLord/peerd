import { describe, expect, test } from 'bun:test';
import browser from '../../extension/shared/browser-api.js';
import { openHome, pickHomeTab } from '../../extension/shared/open-home.js';

const HOME = browser.runtime.getURL('home/home.html');

type Tab = { id: number, windowId: number, pinned: boolean, url: string };

// Swap the browser's tabs and windows for one call, then put them back.
const withBrowser = async (tabs: Tab[], currentWindow: number, run: () => Promise<void>) => {
  const native = browser as unknown as Record<string, unknown>;
  const saved = { tabs: native.tabs, windows: native.windows };
  const calls: string[] = [];
  native.tabs = {
    query: async () => tabs,
    update: async (id: number, properties: { active?: boolean, url?: string }) => {
      calls.push(`activate tab ${id}${properties.url ? ` at ${properties.url.slice(HOME.length)}` : ''}`);
    },
    create: async ({ url }: { url: string }) => { calls.push(`create ${url.slice(HOME.length) || 'home'}`); },
  };
  native.windows = {
    getCurrent: async () => ({ id: currentWindow }),
    update: async (id: number) => { calls.push(`focus window ${id}`); },
  };
  try { await run(); } finally {
    native.tabs = saved.tabs;
    native.windows = saved.windows;
  }
  return calls;
};

describe('openHome', () => {
  test('picks the Home tab in the caller\'s window, the pinned one first', () => {
    const homes = [
      { id: 1, windowId: 10, pinned: true },
      { id: 2, windowId: 20, pinned: false },
      { id: 3, windowId: 20, pinned: true },
    ];
    expect(pickHomeTab(homes, 20)?.id).toBe(3);
    expect(pickHomeTab(homes, 10)?.id).toBe(1);
    // A window with no Home tab falls back to the first one anywhere.
    expect(pickHomeTab(homes, 30)?.id).toBe(1);
    expect(pickHomeTab([{ id: 2, windowId: 20 }, { id: 4, windowId: 20 }], 20)?.id).toBe(2);
    expect(pickHomeTab([], 20)).toBeUndefined();
  });

  test('with a pinned Home tab in two windows, it stays in the current window', async () => {
    const calls = await withBrowser([
      { id: 1, windowId: 10, pinned: true, url: HOME },
      { id: 5, windowId: 20, pinned: false, url: 'https://example.com/' },
      { id: 6, windowId: 20, pinned: true, url: `${HOME}#library` },
    ], 20, () => openHome('discover'));
    expect(calls).toEqual(['activate tab 6 at #discover', 'focus window 20']);
  });

  test('with no Home tab it opens one', async () => {
    const calls = await withBrowser([{ id: 5, windowId: 20, pinned: false, url: 'https://example.com/' }],
      20, () => openHome());
    expect(calls).toEqual(['create home']);
  });
});
