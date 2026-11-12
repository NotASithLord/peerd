import { describe, expect, test } from 'bun:test';
import { makeNativeWorkspace, splitRefusal } from '../../extension/home/native-workspace.js';
import type { NativeWorkspaceTabs, WorkspacePage } from '../../extension/home/native-workspace.js';

const tab = (id: number, index: number, changes: Partial<WorkspacePage> = {}): WorkspacePage => ({
  id, index, windowId: 1, pinned: false, active: id === 1, highlighted: id === 1,
  incognito: false, groupId: -1, splitViewId: -1, autoDiscardable: true,
  url: id === 1 ? 'chrome-extension://peerd/home/home.html' : 'about:blank', ...changes,
});

const browserTabs = (initial = [tab(1, 0), tab(2, 1)]) => {
  const rows = initial.map((row) => ({ ...row }));
  const calls: Array<{ method: string, value: unknown }> = [];
  const hooks = { afterMove: () => {}, afterCreate: () => {}, failMove: false, failSplit: false };
  const find = (id: number) => {
    const row = rows.find((row) => row.id === id);
    if (!row) throw new Error('Tab closed');
    return row;
  };
  const tabs: NativeWorkspaceTabs = {
    get: async (id) => ({ ...find(id) }),
    query: async ({ windowId }) => rows.filter((row) => row.windowId === windowId).map((row) => ({ ...row })),
    move: async (id, properties) => {
      calls.push({ method: 'move', value: { id, ...properties } });
      if (hooks.failMove) throw new Error('Move refused');
      const row = find(id);
      const order = rows.filter((item) => item.windowId === row.windowId && item.id !== id)
        .sort((a, b) => a.index - b.index);
      order.splice(properties.index, 0, row);
      order.forEach((item, index) => { item.index = index; });
      hooks.afterMove();
    },
    createSplit: async (ids) => {
      calls.push({ method: 'createSplit', value: ids });
      if (hooks.failSplit) throw new Error('Split refused');
      ids.forEach((id) => { find(id).splitViewId = 10; });
      return 10;
    },
    unsplit: async (id) => {
      calls.push({ method: 'unsplit', value: id });
      rows.filter((row) => row.splitViewId === id).forEach((row) => { row.splitViewId = -1; });
    },
    update: async (id, properties) => {
      calls.push({ method: 'update', value: { id, ...properties } });
      if (properties.active) rows.filter((row) => row.windowId === find(id).windowId)
        .forEach((row) => { row.active = row.id === id; });
      Object.assign(find(id), properties);
    },
    create: async (properties) => {
      calls.push({ method: 'create', value: properties });
      const home = find(properties.splitWithTabId ?? 1);
      rows.filter((row) => row.windowId === home.windowId && row.index >= properties.index)
        .forEach((row) => { row.index += 1; });
      const page = tab(Math.max(...rows.map((row) => row.id)) + 1, properties.index,
        { windowId: properties.windowId, url: properties.url, groupId: properties.splitWithTabId ? home.groupId : -1,
          active: properties.active, splitViewId: properties.splitWithTabId ? 10 : -1 });
      if (properties.splitWithTabId) home.splitViewId = 10;
      home.active = false;
      rows.push(page);
      hooks.afterCreate();
      return { ...page };
    },
  };
  return { tabs, rows, calls, hooks, workspace: makeNativeWorkspace({ tabs, homeTabId: 1 }) };
};

describe('native Home workspace', () => {
  test('reads native pairs and excludes other windows and other Home documents', async () => {
    const state = browserTabs([tab(1, 0, { splitViewId: 9 }), tab(2, 1, { splitViewId: 9 }),
      tab(3, 2, { url: 'chrome-extension://peerd/home/home.html#chat' }), tab(4, 0, { windowId: 2 })]);
    const snapshot = await state.workspace.refresh();
    expect(snapshot.pages.map((page) => page.id)).toEqual([2]);
    expect(snapshot.peer?.id).toBe(2);
    state.rows.forEach((row) => { row.splitViewId = -1; });
    expect((await state.workspace.refresh()).peer).toBeNull();
  });

  test('does not mutate an unsupported browser and offers the selected tab', async () => {
    const state = browserTabs();
    state.tabs.createSplit = undefined;
    const result = await state.workspace.besideTab(2);
    expect(result).toMatchObject({ available: false, ok: false, fallback: { tabId: 2 } });
    expect(state.calls).toEqual([]);
  });

  test('rejects pinned, grouped, other-window, and already split pairs', () => {
    for (const changes of [{ pinned: true }, { groupId: 2 }, { windowId: 2 }, { splitViewId: 5 }]) {
      expect(splitRefusal(tab(1, 0), tab(2, 1, changes))).not.toBe('');
    }
    expect(splitRefusal(tab(1, 0, { pinned: true }), tab(2, 1, { pinned: true }))).not.toBe('');
    expect(splitRefusal(tab(1, 0), tab(2, 1))).toBe('');
  });

  test('moves only Home after the menu discloses the move', async () => {
    const state = browserTabs([tab(1, 0), tab(2, 1), tab(3, 2)]);
    expect((await state.workspace.besideTab(3)).ok).toBe(false);
    expect(state.calls).toEqual([]);
    const result = await state.workspace.besideTab(3, { moveHome: true });
    expect(result.peer?.id).toBe(3);
    expect(state.calls).toEqual([
      { method: 'move', value: { id: 1, index: 1 } },
      { method: 'createSplit', value: [1, 3] },
      { method: 'update', value: { id: 1, autoDiscardable: false } },
      { method: 'update', value: { id: 1, active: true } },
    ]);
    expect(state.rows.find((row) => row.id === 3)?.url).toBe('about:blank');
  });

  test('places Home to the left when the selected tab precedes Home', async () => {
    const state = browserTabs([tab(2, 0), tab(1, 1)]);
    expect((await state.workspace.besideTab(2, { moveHome: true })).peer?.id).toBe(2);
    expect(state.calls[0]).toEqual({ method: 'move', value: { id: 1, index: 0 } });
  });

  test('rechecks live membership and group after moving Home', async () => {
    for (const changes of [{ groupId: 2 }, { windowId: 2 }]) {
      const state = browserTabs([tab(1, 0), tab(2, 1), tab(3, 2)]);
      state.hooks.afterMove = () => { Object.assign(state.rows.find((row) => row.id === 3)!, changes); };
      expect((await state.workspace.besideTab(3, { moveHome: true })).ok).toBe(false);
      expect(state.calls.map((call) => call.method)).toEqual(['move']);
    }
  });

  test('native refusals retain an explicit fallback without activating it', async () => {
    for (const failure of ['failMove', 'failSplit'] as const) {
      const state = browserTabs([tab(1, 0), tab(2, 1), tab(3, 2)]);
      state.hooks[failure] = true;
      const result = await state.workspace.besideTab(3, { moveHome: true });
      expect(result).toMatchObject({ ok: false, fallback: { tabId: 3, url: 'about:blank' } });
      expect(state.calls.some((call) => call.method === 'update')).toBe(false);
    }
  });

  test('serializes repeated pairing clicks without creating another split', async () => {
    const state = browserTabs();
    const results = await Promise.all([state.workspace.besideTab(2), state.workspace.besideTab(2)]);
    expect(results.every((result) => result.ok && result.peer?.id === 2)).toBe(true);
    expect(state.calls.filter((call) => call.method === 'createSplit')).toHaveLength(1);
  });

  test('creates an explicit blank native peer without creating another Home', async () => {
    const state = browserTabs([tab(1, 0, { groupId: 3 })]);
    const result = await state.workspace.newTabBeside();
    expect(state.calls).toEqual([{ method: 'create', value: {
      windowId: 1, index: 1, splitWithTabId: 1, url: 'about:blank', active: true,
    } }, { method: 'update', value: { id: 1, autoDiscardable: false } }]);
    expect(result.peer).toMatchObject({ id: 2, url: 'about:blank', groupId: 3 });
    expect(result.home?.id).toBe(1);
  });

  test('a pinned Home offers a blank fallback only after an explicit click', async () => {
    const state = browserTabs([tab(1, 0, { pinned: true })]);
    expect(await state.workspace.newTabBeside()).toMatchObject({ ok: false, fallback: { tabId: null, url: 'about:blank' } });
    expect(state.calls).toEqual([]);
  });

  test('a new tab that leaves split view remains the fallback instead of another new tab', async () => {
    const state = browserTabs([tab(1, 0)]);
    state.hooks.afterCreate = () => { state.rows.forEach((row) => { row.splitViewId = -1; }); };
    const result = await state.workspace.newTabBeside();
    expect(result).toMatchObject({ ok: false, fallback: { tabId: 2, url: 'about:blank' } });
    expect(state.calls.filter((call) => call.method === 'create')).toHaveLength(1);
  });

  test('the explicit new-tab fallback protects Home and opens one plain blank tab', async () => {
    const state = browserTabs([tab(1, 0, { pinned: true })]);
    const result = await state.workspace.showPageOnly(null);
    expect(result.ok).toBe(true);
    expect(result.peer).toBeNull();
    expect(state.calls).toEqual([{ method: 'update', value: { id: 1, autoDiscardable: false } },
      { method: 'create', value: { windowId: 1, index: 1, url: 'about:blank', active: true } }]);
    expect(result.home?.pinned).toBe(true);
  });

  test('page-only and chat-only transitions unsplit the existing pair', async () => {
    for (const method of ['showPageOnly', 'closeSplit'] as const) {
      const state = browserTabs([tab(1, 0, { splitViewId: 7 }), tab(2, 1, { splitViewId: 7 })]);
      const result = await state.workspace[method]();
      expect(result.peer).toBeNull();
      expect(state.calls).toEqual([{ method: 'unsplit', value: 7 },
        ...(method === 'showPageOnly' ? [{ method: 'update', value: { id: 1, autoDiscardable: false } }] : []),
        { method: 'update', value: { id: method === 'closeSplit' ? 1 : 2, active: true } }]);
      expect(result.pages.map((page) => page.id)).toEqual([2]);
    }
  });

  test('does not end an unrelated native split for a page-only request', async () => {
    const state = browserTabs([tab(1, 0), tab(2, 1, { splitViewId: 7 }), tab(3, 2, { splitViewId: 7 })]);
    expect((await state.workspace.showPageOnly(2)).ok).toBe(false);
    expect(state.calls).toEqual([]);
  });

  test('keeps Home protected across page-only and chat-only layouts until release', async () => {
    const state = browserTabs();
    await state.workspace.besideTab(2);
    await state.workspace.showPageOnly();
    await state.workspace.closeSplit();
    expect(state.rows.find((row) => row.id === 1)?.autoDiscardable).toBe(false);
    await state.workspace.release();
    expect(state.rows.find((row) => row.id === 1)?.autoDiscardable).toBe(true);
    const count = state.calls.length;
    await state.workspace.release();
    expect(state.calls).toHaveLength(count);
  });

  test('protects a pinned Home before an explicit browser fallback and restores an original false value', async () => {
    const state = browserTabs([tab(1, 0, { pinned: true, autoDiscardable: false }), tab(2, 1)]);
    expect((await state.workspace.showPageOnly(2)).ok).toBe(true);
    await state.workspace.release();
    expect(state.rows.find((row) => row.id === 1)?.autoDiscardable).toBe(false);
    expect(state.calls).toEqual([{ method: 'update', value: { id: 2, active: true } },
      { method: 'update', value: { id: 1, autoDiscardable: false } }]);
  });

  test('protecting a hidden Home changes no tab layout, location or activation', async () => {
    const state = browserTabs([tab(1, 0, { active: false }), tab(2, 1, { active: true })]);
    const result = await state.workspace.protect();
    expect(result.home).toMatchObject({ active: false, autoDiscardable: false, index: 0, splitViewId: -1 });
    expect(result.pages[0]).toMatchObject({ active: true, url: 'about:blank', index: 1, splitViewId: -1 });
    expect(state.calls).toEqual([{ method: 'update', value: { id: 1, autoDiscardable: false } }]);
    await state.workspace.release();
    expect(state.rows.find((row) => row.id === 1)?.autoDiscardable).toBe(true);
  });
});
