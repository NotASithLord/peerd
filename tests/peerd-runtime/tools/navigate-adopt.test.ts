// DESIGN-17 lazy tab adoption: the web ACTOR may own 0 tabs (a pure-fetch task never
// rendered). navigate is the render decision made concrete — when the actor owns no
// tab, it opens/adopts one via ctx.adoptWebTab and re-pins ctx.activeTab IN PLACE so
// the rest of the turn drives it. Without adoptWebTab, the no-tab path fails closed
// (a web ctx must NEVER fall back to the user's foreground tab).

import { describe, test, expect } from 'bun:test';
import { navigateTool } from '../../../extension/peerd-runtime/tools/defs/navigate.js';

// A tabs mock whose update() resolves and fires the onUpdated 'complete' the
// navigation watcher awaits. get() returns the landed URL.
const makeTabs = (landedUrl = 'https://shop.com/p') => {
  let listener: any = null;
  return {
    onUpdated: { addListener: (l: any) => { listener = l; }, removeListener: () => { listener = null; } },
    update: async (tabId: number) => { queueMicrotask(() => listener?.(tabId, { status: 'complete' })); },
    get: async (tabId: number) => ({ id: tabId, url: landedUrl }),
  };
};

describe('navigate — web-actor lazy tab adoption', () => {
  test('a web ctx with NO tab opens one via adoptWebTab and re-pins activeTab', async () => {
    let adopted = false;
    const ctx: any = {
      residentKind: 'web',
      tabs: makeTabs('https://shop.com/p'),
      adoptWebTab: async () => { adopted = true; return { tabId: 100, windowId: 1 }; },
      // no activeTab → the 0-tab state
    };
    const r = await navigateTool.execute({ url: 'https://shop.com/p' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(adopted).toBe(true);
    const out = JSON.parse(r.content!);
    expect(out.tabId).toBe(100);
    // activeTab re-pinned IN PLACE to the adopted tab + the landed origin, so the rest
    // of the turn's DOM tools drive it (and the origin gate sees the live origin).
    expect(ctx.activeTab.id).toBe(100);
    expect(ctx.activeTab.origin).toBe('https://shop.com');
  });

  test('adoption re-pins the SHARED turn ctx via repinActiveTab, not the dispatcher per-call copy', async () => {
    // The dispatcher hands each tool a fresh `{ ...ctx }` copy (dispatcher.js), so a bare
    // `ctx.activeTab = …` would die with the copy. buildToolContext gives the web ctx a
    // repinActiveTab setter that writes the SHARED object; navigate must use it so the
    // rest of the turn's DOM tools + the session-scoped webFetch see the adopted tab.
    const shared: any = {
      residentKind: 'web',
      activeTab: undefined,
      tabs: makeTabs('https://shop.com/p'),
      adoptWebTab: async () => ({ tabId: 100, windowId: 1 }),
      repinActiveTab: (t: any) => { shared.activeTab = t; },
      noteTab: () => {},
      hintPullIn: () => {},
    };
    const execCtx = { ...shared };   // the dispatcher's per-call shallow copy
    const r = await navigateTool.execute({ url: 'https://shop.com/p' }, execCtx);
    expect(r.ok).toBe(true);
    // Without the setter, shared.activeTab would still be undefined (the bug). With it,
    // the adopted tab + landed origin land on the SHARED ctx the next call reads.
    expect(shared.activeTab?.id).toBe(100);
    expect(shared.activeTab?.origin).toBe('https://shop.com');
  });

  test('a web ctx with NO tab and NO adoptWebTab fails closed (never the foreground tab)', async () => {
    const ctx: any = { residentKind: 'web', tabs: makeTabs() };
    const r = await navigateTool.execute({ url: 'https://shop.com/p' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.error).toBe('no_target_tab');
  });

  test('an unsupported scheme is rejected before any adoption', async () => {
    let adopted = false;
    const ctx: any = { residentKind: 'web', tabs: makeTabs(), adoptWebTab: async () => { adopted = true; return { tabId: 1 }; } };
    const r = await navigateTool.execute({ url: 'file:///etc/passwd' }, ctx);
    expect(r.ok).toBe(false);
    expect(adopted).toBe(false);
  });
});
