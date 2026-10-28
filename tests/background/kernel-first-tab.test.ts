import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIRST_TAB_DECLINED_KEY,
  FIRST_TAB_KEPT_KEY,
  FIRST_TAB_WINDOWS_KEY,
  attachKernelFirstTab,
  firstTabWindow,
  pinnedHomes,
  windowTabsKey,
} from '../../extension/background/kernel-first-tab.js';

const HOME = 'chrome-extension://peerd-test/home/home.html';

type Win = { id: number, type: string, incognito?: boolean };
type Tab = { id: number, windowId: number, pinned: boolean, url: string, pendingUrl?: string, index?: number, active?: boolean };
type Created = { windowId: number, url: string, pinned: boolean, index: number, active: boolean };

const makeBrowser = ({ windows = [] as Win[], tabs = [] as Tab[], blankWhileLoading = false,
  failCreateIn = new Set<number>(), local = new Map<string, unknown>() } = {}) => {
  const created: Created[] = [];
  const attempts: number[] = [];
  const removedTabs: number[] = [];
  const removedWindows: number[] = [];
  let nextId = 1000;
  let onCreated: ((window: Win) => void) | null = null;
  const registered: Array<{ key: string, owner: string }> = [];
  const browser = {
    windows: {
      onCreated: { addListener: () => {} },
      getAll: async ({ windowTypes }: { windowTypes: Array<'normal'> }) =>
        windows.filter((window) => windowTypes.includes(window.type as 'normal')),
      remove: async (windowId: number) => {
        removedWindows.push(windowId);
        windows.splice(windows.findIndex((window) => window.id === windowId), 1);
        for (let i = tabs.length - 1; i >= 0; i -= 1) if (tabs[i].windowId === windowId) tabs.splice(i, 1);
      },
    },
    tabs: {
      query: async ({ windowId }: { windowId: number }) => tabs.filter((tab) => tab.windowId === windowId),
      create: async (properties: Created) => {
        attempts.push(properties.windowId);
        if (failCreateIn.has(properties.windowId)) throw new Error('create failed');
        created.push(properties);
        // why: Firefox can report about:blank until the page loads; Chrome
        // reports the address as pendingUrl.
        const tab = { id: nextId++, windowId: properties.windowId, pinned: properties.pinned, index: 0,
          url: blankWhileLoading ? 'about:blank' : '', pendingUrl: blankWhileLoading ? undefined : properties.url };
        tabs.push(tab);
        return tab;
      },
      remove: async (ids: number[]) => {
        removedTabs.push(...ids);
        for (const id of ids) tabs.splice(tabs.findIndex((tab) => tab.id === id), 1);
      },
    },
  };
  const events = {
    event: (key: string, _raw: unknown, owner: string) => {
      registered.push({ key, owner });
      return { addListener: (listener: (window: Win) => void) => { onCreated = listener; } };
    },
  };
  const sessionStore = new Map<string, unknown>();
  const session = {
    sessionGet: async (key: string) => sessionStore.get(key),
    sessionSet: async (key: string, value: unknown) => { sessionStore.set(key, value); },
  };
  const store = {
    get: async (key: string) => local.get(key),
    set: async (key: string, value: unknown) => { local.set(key, value); },
  };
  return {
    browser, events, session, store, sessionStore, local, created, attempts, removedTabs, removedWindows,
    tabs, windows, registered,
    open: (window: Win) => { windows.push(window); onCreated?.(window); },
    emit: (window: Win) => { onCreated?.(window); },
  };
};

const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

const attach = (fake: ReturnType<typeof makeBrowser>,
  { enabled = true, errors = [] as unknown[], closeLoneWindows = false } = {}) => {
  const state = { enabled };
  const api = attachKernelFirstTab({
    browser: fake.browser, events: fake.events, session: fake.session, store: fake.store,
    ready: Promise.resolve(), homeUrl: HOME, settleMs: 0, closeLoneWindows,
    isEnabled: () => state.enabled,
    onError: (cause) => { errors.push(cause); },
  });
  return { api, state, errors };
};

// The custody owner the kernel wraps: it records what reaches it.
const custody = () => {
  const seen: string[] = [];
  return {
    seen,
    owner: {
      onUpdated: (tabId: number) => { seen.push(`updated ${tabId}`); return 'custody'; },
      onRemoved: (tabId: number) => { seen.push(`removed ${tabId}`); return 'custody'; },
    },
  };
};

describe('kernel first tab: rules', () => {
  test('only normal, non-private windows get a tab', () => {
    expect(firstTabWindow({ id: 1, type: 'normal' })).toBe(true);
    expect(firstTabWindow({ id: 1, type: 'normal', incognito: true })).toBe(false);
    for (const type of ['popup', 'devtools', 'app', 'panel']) expect(firstTabWindow({ id: 1, type })).toBe(false);
    expect(firstTabWindow({ type: 'normal' })).toBe(false);
  });

  test('a pinned Home tab counts, by address or while it loads; an unpinned one does not', () => {
    expect(pinnedHomes([{ pinned: true, url: `${HOME}#discover` }], HOME)).toHaveLength(1);
    expect(pinnedHomes([{ pinned: true, url: '', pendingUrl: HOME }], HOME)).toHaveLength(1);
    expect(pinnedHomes([{ pinned: false, url: HOME }], HOME)).toHaveLength(0);
    expect(pinnedHomes([{ pinned: true, url: 'https://mail.example/' }], HOME)).toHaveLength(0);
    expect(pinnedHomes([{ id: 7, pinned: true, url: 'about:blank' }], HOME, new Set([7]))).toHaveLength(1);
  });

  test('the leftmost pinned Home tab comes first', () => {
    const homes = pinnedHomes([
      { id: 2, index: 1, pinned: true, url: HOME },
      { id: 3, index: 2, pinned: false, url: 'https://example.com/' },
      { id: 1, index: 0, pinned: true, url: HOME },
    ], HOME);
    expect(homes.map((tab) => tab.id)).toEqual([1, 2]);
  });

  test('a window is known by its tab addresses, in any order, with new ids', () => {
    const before = windowTabsKey([{ id: 1, url: 'https://b.example/' }, { id: 2, url: 'https://a.example/' }]);
    expect(windowTabsKey([{ id: 8, url: 'https://a.example/' }, { id: 9, url: '', pendingUrl: 'https://b.example/' }]))
      .toBe(before);
    expect(windowTabsKey([{ id: 8, url: 'https://a.example/' }])).not.toBe(before);
  });
});

describe('kernel first tab: new windows', () => {
  test('registers the one cold event, owned by kernel-first-tab', () => {
    const fake = makeBrowser();
    attach(fake);
    expect(fake.registered).toEqual([{ key: 'windows.onCreated', owner: 'kernel-first-tab' }]);
  });

  test('a new window gets one pinned Home tab at the start, in the background', async () => {
    const fake = makeBrowser({ windows: [{ id: 1, type: 'normal' }] });
    attach(fake);
    await flush();
    fake.open({ id: 2, type: 'normal' });
    await flush();
    expect(fake.created).toEqual([{ windowId: 2, url: HOME, pinned: true, index: 0, active: false }]);
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([2]);
  });

  test('nothing while the setting is off', async () => {
    const fake = makeBrowser();
    attach(fake, { enabled: false });
    await flush();
    fake.open({ id: 2, type: 'normal' });
    await flush();
    expect(fake.created).toEqual([]);
  });

  test('popups, devtools and private windows get no tab', async () => {
    const fake = makeBrowser();
    attach(fake);
    await flush();
    fake.open({ id: 2, type: 'popup' });
    fake.open({ id: 3, type: 'devtools' });
    fake.open({ id: 4, type: 'normal', incognito: true });
    await flush();
    expect(fake.created).toEqual([]);
  });

  test('a window that already has a pinned Home tab keeps it', async () => {
    const fake = makeBrowser({ tabs: [{ id: 5, windowId: 2, pinned: true, url: HOME }] });
    attach(fake);
    await flush();
    fake.open({ id: 2, type: 'normal' });
    await flush();
    expect(fake.created).toEqual([]);
  });

  test('windows open when the worker first boots are restored ones: they keep what the browser restored', async () => {
    const fake = makeBrowser({ windows: [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }] });
    attach(fake);
    await flush();
    expect(fake.sessionStore.get(FIRST_TAB_WINDOWS_KEY)).toEqual([1, 2]);
    // A restored window the user had closed its tab in, delivered late.
    fake.emit({ id: 2, type: 'normal' });
    await flush();
    expect(fake.created).toEqual([]);
  });

  test('a worker restart in the same session keeps the record, so a new window still gets its tab', async () => {
    const fake = makeBrowser({ windows: [{ id: 1, type: 'normal' }] });
    fake.sessionStore.set(FIRST_TAB_WINDOWS_KEY, [1]);
    // The new window is what woke the worker: it is open before the boot runs.
    fake.windows.push({ id: 2, type: 'normal' });
    attach(fake);
    fake.emit({ id: 2, type: 'normal' });
    await flush();
    expect(fake.created.map((tab) => tab.windowId)).toEqual([2]);
  });

  test('never puts back a tab the user closed', async () => {
    const fake = makeBrowser();
    attach(fake);
    await flush();
    fake.open({ id: 2, type: 'normal' });
    await flush();
    expect(fake.created).toHaveLength(1);
    // The user closes it, and a repeated window event for the same window is ignored.
    fake.tabs.splice(0);
    fake.emit({ id: 2, type: 'normal' });
    await flush();
    expect(fake.created).toHaveLength(1);
  });

  test('a failed create is not tried again on a repeated window event', async () => {
    const fake = makeBrowser({ failCreateIn: new Set([2]) });
    const { errors } = attach(fake);
    await flush();
    fake.open({ id: 2, type: 'normal' });
    await flush();
    fake.emit({ id: 2, type: 'normal' });
    await flush();
    expect(fake.attempts).toEqual([2]);
    expect(errors).toHaveLength(1);
  });
});

describe('kernel first tab: every window', () => {
  test('turning it on covers every normal window and keeps the pinned Home tabs there', async () => {
    const fake = makeBrowser({
      windows: [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }, { id: 3, type: 'popup' }],
      tabs: [{ id: 5, windowId: 2, pinned: true, url: HOME }],
    });
    const { api } = attach(fake);
    await flush();
    // Window 1 is already handled: the user closed its tab earlier. Turning
    // the setting on again is an explicit request, so it comes back.
    expect(fake.sessionStore.get(FIRST_TAB_WINDOWS_KEY)).toEqual([1, 2]);
    await api.coverEveryWindow();
    expect(fake.created.map((tab) => tab.windowId)).toEqual([1]);
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([1, 2]);
  });

  test('a window covered after it opened with the setting off is not covered again', async () => {
    const fake = makeBrowser();
    const { api, state } = attach(fake, { enabled: false });
    await flush();
    fake.open({ id: 3, type: 'normal' });
    await flush();
    state.enabled = true;
    await api.coverEveryWindow();
    expect(fake.created.map((tab) => tab.windowId)).toEqual([3]);
    // The user closes it, and the window event comes again.
    fake.tabs.splice(0);
    fake.emit({ id: 3, type: 'normal' });
    await flush();
    expect(fake.created).toHaveLength(1);
  });

  test('does nothing while the setting is off', async () => {
    const fake = makeBrowser({ windows: [{ id: 1, type: 'normal' }] });
    const { api } = attach(fake, { enabled: false });
    await api.coverEveryWindow();
    expect(fake.created).toEqual([]);
  });

  test('no second tab when a window event and a cover race, even while the tab loads blank', async () => {
    const fake = makeBrowser({ blankWhileLoading: true });
    const { api } = attach(fake);
    await flush();
    fake.open({ id: 2, type: 'normal' });
    await api.coverEveryWindow();
    await flush();
    expect(fake.created.map((tab) => tab.windowId)).toEqual([2]);
  });

  test('one failed window does not stop the others, and the error is reported', async () => {
    const fake = makeBrowser({
      windows: [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }], failCreateIn: new Set([1]),
    });
    const { api, errors } = attach(fake);
    await api.coverEveryWindow();
    expect(fake.created.map((tab) => tab.windowId)).toEqual([2]);
    expect(errors).toHaveLength(1);
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([2]);
  });
});

describe('kernel first tab: closed tabs and updates', () => {
  // Turn it on in two windows, then let the user close the tab in window 2.
  const twoWindowsThenClose = async () => {
    const fake = makeBrowser({ windows: [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }] });
    const { api } = attach(fake);
    await flush();
    await api.coverEveryWindow();
    const tabs = custody();
    const watched = api.watchTabs(tabs.owner);
    const closed = fake.tabs.find((tab) => tab.windowId === 2);
    fake.tabs.splice(fake.tabs.indexOf(closed!), 1);
    expect(watched.onRemoved(closed!.id, { windowId: 2, isWindowClosing: false })).toBe('custody');
    await flush();
    return { fake, api, tabs, closedId: closed!.id };
  };

  test('closing peerd\'s tab takes the window off the kept list, and custody still gets the event', async () => {
    const { fake, tabs, closedId } = await twoWindowsThenClose();
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([1]);
    expect(tabs.seen).toEqual([`removed ${closedId}`]);
  });

  test('an update puts the tab back only in the windows that still had it', async () => {
    const { fake } = await twoWindowsThenClose();
    // The update: unloading peerd closes its tabs and empties storage.session.
    // storage.local and the window ids stay.
    fake.tabs.splice(0);
    fake.sessionStore.clear();
    const created = fake.created.length;
    const { api } = attach(fake);
    await flush();
    await api.restoreAfterUpdate();
    expect(fake.created.slice(created).map((tab) => tab.windowId)).toEqual([1]);
  });

  test('an update adds nothing while the setting is off', async () => {
    const { fake } = await twoWindowsThenClose();
    fake.tabs.splice(0);
    const created = fake.created.length;
    const { api } = attach(fake, { enabled: false });
    await api.restoreAfterUpdate();
    expect(fake.created).toHaveLength(created);
  });

  test('unpinning peerd\'s tab counts as closing it, and pinning a Home tab again counts as keeping it', async () => {
    const fake = makeBrowser({ windows: [{ id: 1, type: 'normal' }] });
    const { api } = attach(fake);
    await api.coverEveryWindow();
    const tabs = custody();
    const watched = api.watchTabs(tabs.owner);
    const tab = fake.tabs[0];
    tab.pinned = false;
    expect(watched.onUpdated(tab.id, { pinned: false }, { windowId: 1 })).toBe('custody');
    await flush();
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([]);
    tab.pinned = true;
    watched.onUpdated(tab.id, { pinned: true }, { windowId: 1 });
    await flush();
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([1]);
    expect(tabs.seen).toEqual([`updated ${tab.id}`, `updated ${tab.id}`]);
  });

  test('navigating the created Home tab away declines restoration after update', async () => {
    const fake = makeBrowser({ windows: [{ id: 1, type: 'normal' }] });
    const { api } = attach(fake);
    await api.coverEveryWindow();
    const watched = api.watchTabs(custody().owner);
    const tab = fake.tabs[0];
    tab.url = 'https://mail.example/';
    delete tab.pendingUrl;
    watched.onUpdated(tab.id, { url: tab.url }, { windowId: 1 });
    await flush();
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([]);
    expect(pinnedHomes([tab], HOME, new Set([tab.id]))).toHaveLength(0);
    const count = fake.created.length;
    fake.sessionStore.clear();
    const restarted = attach(fake);
    await restarted.api.restoreAfterUpdate();
    expect(fake.created).toHaveLength(count);
  });

  test('pinning some other tab adds nothing', async () => {
    const fake = makeBrowser({
      windows: [{ id: 1, type: 'normal' }],
      tabs: [{ id: 6, windowId: 1, pinned: true, url: 'https://mail.example/' }],
    });
    const { api } = attach(fake);
    await flush();
    api.watchTabs(custody().owner).onUpdated(6, { pinned: true }, { windowId: 1 });
    await flush();
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toBeUndefined();
  });

  test('closing some other tab, or a second pinned Home tab, keeps the window on the list', async () => {
    const fake = makeBrowser({
      windows: [{ id: 1, type: 'normal' }],
      tabs: [{ id: 5, windowId: 1, pinned: true, url: HOME }, { id: 6, windowId: 1, pinned: false, url: 'https://example.com/' }],
    });
    const { api } = attach(fake);
    await api.coverEveryWindow();
    const watched = api.watchTabs(custody().owner);
    fake.tabs.splice(fake.tabs.findIndex((tab) => tab.id === 6), 1);
    watched.onRemoved(6, { windowId: 1, isWindowClosing: false });
    watched.onUpdated(5, { pinned: true }, { windowId: 1 });
    await flush();
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([1]);
  });

  test('a window that closes leaves the list', async () => {
    const fake = makeBrowser({ windows: [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }] });
    const { api } = attach(fake);
    await api.coverEveryWindow();
    api.watchTabs(custody().owner).onRemoved(1001, { windowId: 2, isWindowClosing: true });
    await flush();
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([1]);
  });
});

describe('kernel first tab: Reopen Closed Window', () => {
  // Window 2 opens with one page and gets its tab. The user closes that tab.
  const declineInWindowTwo = async () => {
    const fake = makeBrowser({
      windows: [{ id: 1, type: 'normal' }], tabs: [{ id: 10, windowId: 1, pinned: false, url: 'https://a.example/' }],
    });
    const { api } = attach(fake);
    await flush();
    fake.tabs.push({ id: 20, windowId: 2, pinned: false, url: 'https://b.example/' });
    fake.open({ id: 2, type: 'normal' });
    await flush();
    expect(fake.created.map((tab) => tab.windowId)).toEqual([2]);
    const watched = api.watchTabs(custody().owner);
    const home = fake.tabs.find((tab) => tab.windowId === 2 && tab.pinned)!;
    fake.tabs.splice(fake.tabs.indexOf(home), 1);
    watched.onRemoved(home.id, { windowId: 2, isWindowClosing: false });
    await flush();
    return { fake, api, watched };
  };
  type Watched = { onRemoved: (tabId: number, removeInfo: { windowId?: number, isWindowClosing?: boolean }) => unknown };
  // The user closes the window: each of its tabs goes with it.
  const closeWindow = async (fake: ReturnType<typeof makeBrowser>, watched: Watched, windowId: number) => {
    for (const tab of fake.tabs.filter((item) => item.windowId === windowId)) {
      fake.tabs.splice(fake.tabs.indexOf(tab), 1);
      watched.onRemoved(tab.id, { windowId, isWindowClosing: true });
    }
    fake.windows.splice(fake.windows.findIndex((window) => window.id === windowId), 1);
    await flush();
  };
  // The browser brings a closed window back with these tabs and a new id.
  const reopen = async (fake: ReturnType<typeof makeBrowser>, windowId: number, urls: string[]) => {
    urls.forEach((url, index) => fake.tabs.push({ id: windowId * 10 + index, windowId, pinned: false, url, index }));
    fake.open({ id: windowId, type: 'normal' });
    await flush();
  };

  test('the window can close right after its tab, before peerd gets to either event', async () => {
    const fake = makeBrowser({ windows: [{ id: 1, type: 'normal' }] });
    const { api } = attach(fake);
    await flush();
    fake.tabs.push({ id: 20, windowId: 2, pinned: false, url: 'https://b.example/' });
    fake.open({ id: 2, type: 'normal' });
    await flush();
    const watched = api.watchTabs(custody().owner);
    const home = fake.tabs.find((tab) => tab.windowId === 2 && tab.pinned)!;
    fake.tabs.splice(fake.tabs.indexOf(home), 1);
    watched.onRemoved(home.id, { windowId: 2, isWindowClosing: false });
    // No wait here: the window and its last page go at once.
    fake.tabs.splice(fake.tabs.findIndex((tab) => tab.id === 20), 1);
    fake.windows.splice(fake.windows.findIndex((window) => window.id === 2), 1);
    watched.onRemoved(20, { windowId: 2, isWindowClosing: true });
    await flush();
    await reopen(fake, 3, ['https://b.example/']);
    expect(fake.created.map((tab) => tab.windowId)).toEqual([2]);
  });

  test('a window the user closed after closing its tab comes back without the tab', async () => {
    const { fake, watched } = await declineInWindowTwo();
    await closeWindow(fake, watched, 2);
    await reopen(fake, 3, ['https://b.example/']);
    expect(fake.created.map((tab) => tab.windowId)).toEqual([2]);
    // It stays known under its new id, so closing and reopening it again works too.
    await closeWindow(fake, watched, 3);
    await reopen(fake, 4, ['https://b.example/']);
    expect(fake.created.map((tab) => tab.windowId)).toEqual([2]);
  });

  test('the window is known by the tabs it had when it closed', async () => {
    const { fake, watched } = await declineInWindowTwo();
    // The user goes to another page there, and opens a second tab.
    fake.tabs.find((tab) => tab.id === 20)!.url = 'https://c.example/';
    watched.onUpdated(20, { url: 'https://c.example/' }, { windowId: 2 });
    fake.tabs.push({ id: 21, windowId: 2, pinned: false, url: 'https://d.example/' });
    watched.onUpdated(21, { url: 'https://d.example/' }, { windowId: 2 });
    await flush();
    await closeWindow(fake, watched, 2);
    // A new window with the old page is a new window: it gets its tab.
    await reopen(fake, 3, ['https://b.example/']);
    expect(fake.created.map((tab) => tab.windowId)).toEqual([2, 3]);
    await reopen(fake, 4, ['https://d.example/', 'https://c.example/']);
    expect(fake.created.map((tab) => tab.windowId)).toEqual([2, 3]);
  });

  test('a window that closed with its tab is not on the list, and its tab comes back with it', async () => {
    const fake = makeBrowser({ windows: [{ id: 1, type: 'normal' }] });
    const { api } = attach(fake);
    await flush();
    fake.tabs.push({ id: 20, windowId: 2, pinned: false, url: 'https://b.example/' });
    fake.open({ id: 2, type: 'normal' });
    await flush();
    const watched = api.watchTabs(custody().owner);
    await closeWindow(fake, watched, 2);
    expect(fake.sessionStore.get(FIRST_TAB_DECLINED_KEY)).toBeUndefined();
    // The browser restores the pinned Home tab with the window.
    fake.tabs.push({ id: 39, windowId: 3, pinned: true, url: HOME, index: 0 });
    await reopen(fake, 3, ['https://b.example/']);
    expect(fake.created.map((tab) => tab.windowId)).toEqual([2]);
  });

  test('Chrome unpins the tab as its window closes: the window comes back with its tab, still on the kept list', async () => {
    const fake = makeBrowser({ windows: [{ id: 1, type: 'normal' }] });
    const { api } = attach(fake);
    await flush();
    fake.tabs.push({ id: 20, windowId: 2, pinned: false, url: 'https://b.example/' });
    fake.open({ id: 2, type: 'normal' });
    await flush();
    const watched = api.watchTabs(custody().owner);
    const home = fake.tabs.find((tab) => tab.windowId === 2 && tab.pinned)!;
    home.url = HOME;
    // What Chrome 151 sends when a window with a pinned tab closes.
    home.pinned = false;
    watched.onUpdated(home.id, { pinned: false }, { windowId: 2 });
    await closeWindow(fake, watched, 2);
    fake.tabs.push({ id: 39, windowId: 3, pinned: true, url: HOME, index: 0 });
    await reopen(fake, 3, ['https://b.example/']);
    expect(fake.created.map((tab) => tab.windowId)).toEqual([2]);
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([3]);
  });

  test('a window that is gone by the time peerd looks leaves no row', async () => {
    const fake = makeBrowser({ windows: [{ id: 1, type: 'normal' }] });
    const { api } = attach(fake);
    await flush();
    fake.open({ id: 2, type: 'normal' });
    await flush();
    const watched = api.watchTabs(custody().owner);
    const home = fake.tabs.find((tab) => tab.windowId === 2 && tab.pinned)!;
    fake.tabs.splice(fake.tabs.indexOf(home), 1);
    watched.onUpdated(home.id, { pinned: false }, { windowId: 2 });
    watched.onRemoved(home.id, { windowId: 2, isWindowClosing: true });
    await flush();
    expect(fake.sessionStore.get(FIRST_TAB_DECLINED_KEY)).toBeUndefined();
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([]);
  });

  test('pinning a Home tab there again takes the window off the list', async () => {
    const { fake, watched } = await declineInWindowTwo();
    fake.tabs.push({ id: 22, windowId: 2, pinned: true, url: HOME });
    watched.onUpdated(22, { pinned: true }, { windowId: 2 });
    await flush();
    expect(fake.sessionStore.get(FIRST_TAB_DECLINED_KEY)).toEqual([]);
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([2]);
  });

  test('turning the setting on again is a new request: a reopened window gets its tab', async () => {
    const { fake, api, watched } = await declineInWindowTwo();
    await closeWindow(fake, watched, 2);
    await api.coverEveryWindow();
    await reopen(fake, 3, ['https://b.example/']);
    // Window 1 gets its tab when the setting turns on, and window 3 when it opens.
    expect(fake.created.map((tab) => tab.windowId)).toEqual([2, 1, 3]);
  });

  test('the tab addresses stay in memory: storage.local holds no list of them', async () => {
    const { fake, watched } = await declineInWindowTwo();
    await closeWindow(fake, watched, 2);
    expect(fake.sessionStore.get(FIRST_TAB_DECLINED_KEY)).toEqual([{ window: null, tabs: 'https://b.example/' }]);
    expect([...fake.local.keys()]).toEqual([FIRST_TAB_KEPT_KEY]);
  });
});

describe('kernel first tab: a browser start', () => {
  test('keeps the leftmost pinned Home tab in a window and closes the others', async () => {
    // Chrome with "Open the New Tab page" puts every window's pinned tabs in the startup window.
    const fake = makeBrowser({
      windows: [{ id: 7, type: 'normal' }, { id: 8, type: 'normal' }],
      tabs: [
        { id: 2, windowId: 7, index: 1, pinned: true, url: HOME },
        { id: 1, windowId: 7, index: 0, pinned: true, url: HOME },
        { id: 3, windowId: 7, index: 2, pinned: false, url: 'chrome://newtab/' },
        { id: 4, windowId: 8, index: 0, pinned: true, url: HOME },
        { id: 5, windowId: 8, index: 1, pinned: false, url: 'https://example.com/' },
      ],
    });
    const { api } = attach(fake);
    await api.browserStarted();
    expect(fake.removedTabs).toEqual([2]);
    expect(fake.tabs.map((tab) => tab.id)).toEqual([1, 3, 4, 5]);
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([7, 8]);
    expect(fake.created).toEqual([]);
  });

  test('a new list replaces the one from the last session, whose window ids are gone', async () => {
    const fake = makeBrowser({
      windows: [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }],
      tabs: [{ id: 1, windowId: 1, index: 0, pinned: true, url: HOME }],
      local: new Map([[FIRST_TAB_KEPT_KEY, [2, 9]]]),
    });
    const { api } = attach(fake);
    await api.browserStarted();
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([1]);
  });

  test('Firefox: closes a window that holds only pinned Home tabs, but never the last window', async () => {
    // Firefox without session restore reopens each window that had a pinned tab, with only that tab.
    const fake = makeBrowser({
      windows: [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }],
      tabs: [
        { id: 1, windowId: 1, index: 0, pinned: true, url: HOME },
        { id: 2, windowId: 1, index: 1, pinned: false, url: 'about:home' },
        { id: 3, windowId: 2, index: 0, pinned: true, url: HOME },
      ],
    });
    const { api } = attach(fake, { closeLoneWindows: true });
    await api.browserStarted();
    expect(fake.removedWindows).toEqual([2]);
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([1]);

    const alone = makeBrowser({
      windows: [{ id: 4, type: 'normal' }],
      tabs: [{ id: 5, windowId: 4, index: 0, pinned: true, url: HOME }],
    });
    await attach(alone, { closeLoneWindows: true }).api.browserStarted();
    expect(alone.removedWindows).toEqual([]);
    expect(alone.local.get(FIRST_TAB_KEPT_KEY)).toEqual([4]);
  });

  test('Chrome keeps a window that holds only its pinned Home tab', async () => {
    const fake = makeBrowser({
      windows: [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }],
      tabs: [
        { id: 1, windowId: 1, index: 0, pinned: false, url: 'https://example.com/' },
        { id: 2, windowId: 2, index: 0, pinned: true, url: HOME },
      ],
    });
    await attach(fake).api.browserStarted();
    expect(fake.removedWindows).toEqual([]);
    expect(fake.local.get(FIRST_TAB_KEPT_KEY)).toEqual([2]);
  });

  test('does nothing while the setting is off', async () => {
    const fake = makeBrowser({
      windows: [{ id: 7, type: 'normal' }],
      tabs: [
        { id: 1, windowId: 7, index: 0, pinned: true, url: HOME },
        { id: 2, windowId: 7, index: 1, pinned: true, url: HOME },
      ],
    });
    await attach(fake, { enabled: false, closeLoneWindows: true }).api.browserStarted();
    expect(fake.removedTabs).toEqual([]);
    expect(fake.removedWindows).toEqual([]);
  });
});

describe('kernel first tab: wiring', () => {
  test('the kernel attaches it and calls it on an update, a browser start, tab events and the setting turning on', () => {
    const source = readFileSync(join(import.meta.dir, '..', '..', 'extension', 'background', 'vault-kernel.js'), 'utf8');
    expect(source).toContain('const firstTab = attachKernelFirstTab({');
    expect(source).toContain('session: sessionCache, store: kv,');
    expect(source).toContain('isEnabled: () => settingsStore.get().firstTabEnabled === true,');
    expect(source).toContain('closeLoneWindows: kernelFirefox,');
    expect(source).toContain("if (details?.reason === 'update') void firstTab.restoreAfterUpdate();");
    expect(source).toContain('firstTabWasOn = settingsStore.get().firstTabEnabled === true;');
    expect(source).toContain('if (patch.firstTabEnabled === true && !firstTabWasOn) void firstTab.coverEveryWindow();');
    expect(source).toContain('void firstTab.browserStarted();');
    expect(source).toContain('...firstTab.watchTabs(browserEventOwners.tabs),');
  });
});
