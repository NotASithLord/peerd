// The denylist must guard the RESOLVED target tab, not just ctx.activeTab.
// A DOM tool driven with args.tabId pointing at a denylisted tab must be
// refused, and list_tabs must not leak denylisted tab ids (the enumeration
// primitive that feeds the args.tabId bypass).

import { describe, test, expect } from 'bun:test';
import { resolveTargetTab, isDenylistedTab } from '../../extension/peerd-runtime/tools/defs/dom-helpers.js';
import { listTabsTool } from '../../extension/peerd-runtime/tools/defs/list-tabs.js';

const DENYLIST = ['chase.com', '*.chase.com', '*.proton.me'];

const tabsApi = (byId: Record<number, any>, all: any[] = Object.values(byId)) => ({
  get: async (id: number) => { if (!byId[id]) throw new Error('no tab'); return byId[id]; },
  query: async () => all,
});

describe('isDenylistedTab', () => {
  test('matches apex + subdomain, ignores public + junk urls', () => {
    expect(isDenylistedTab('https://chase.com/login', DENYLIST)).toBe(true);
    expect(isDenylistedTab('https://mail.proton.me/u/0', DENYLIST)).toBe(true);
    expect(isDenylistedTab('https://example.com/', DENYLIST)).toBe(false);
    expect(isDenylistedTab('chrome://settings', DENYLIST)).toBe(false);
    expect(isDenylistedTab('not a url', DENYLIST)).toBe(false);
    expect(isDenylistedTab('https://chase.com/', [])).toBe(false);
  });
});

describe('resolveTargetTab — denylist on the actual target', () => {
  test('refuses a denylisted tab addressed by args.tabId (the bypass)', async () => {
    const ctx: any = {
      denylist: DENYLIST,
      activeTab: { id: 1, url: 'https://example.com/', origin: 'https://example.com' },
      tabs: tabsApi({
        1: { id: 1, url: 'https://example.com/' },
        9: { id: 9, url: 'https://chase.com/transfer' }, // denylisted bank
      }),
    };
    expect(await resolveTargetTab({ tabId: 9 }, ctx)).toBeNull();           // refused
    expect((await resolveTargetTab({ tabId: 1 }, ctx))?.id).toBe(1);        // ordinary tab ok
    expect((await resolveTargetTab({}, ctx))?.id).toBe(1);                  // active tab ok
  });

  test('refuses when the ACTIVE tab itself is denylisted', async () => {
    const ctx: any = {
      denylist: DENYLIST,
      activeTab: { id: 9, url: 'https://chase.com/', origin: 'https://chase.com' },
      tabs: tabsApi({ 9: { id: 9, url: 'https://chase.com/' } }),
    };
    expect(await resolveTargetTab({}, ctx)).toBeNull();
  });
});

describe('resolveTargetTab — DESIGN-17 web-resident fail-closed', () => {
  // A web resident OWNS one tab via ctx.activeTab. If that tab vanished mid-turn
  // (so ctx.activeTab is absent), it must NEVER fall back to the user's foreground
  // tab — it refuses instead. The foreground query is the leak this closes.
  test('a resident ctx with no activeTab refuses — never queries the foreground', async () => {
    let foregroundQueried = false;
    const ctx: any = {
      residentKind: 'web',
      tabs: {
        get: async () => { throw new Error('no tab'); },
        query: async () => { foregroundQueried = true; return [{ id: 7, url: 'https://user-bank.com/' }]; },
      },
    };
    expect(await resolveTargetTab({}, ctx)).toBeNull();
    expect(foregroundQueried).toBe(false);   // the foreground was NOT touched
  });

  test('a NON-resident ctx with no activeTab still uses the foreground (unchanged)', async () => {
    const ctx: any = {
      denylist: [],
      tabs: { get: async () => { throw new Error('x'); }, query: async () => [{ id: 7, url: 'https://example.com/' }] },
    };
    expect((await resolveTargetTab({}, ctx))?.id).toBe(7);
  });

  test('a web resident still drives its OWN tab via ctx.activeTab', async () => {
    const ctx: any = {
      residentKind: 'web',
      denylist: [],
      activeTab: { id: 42, url: 'https://app.example/', origin: 'https://app.example' },
      tabs: tabsApi({ 42: { id: 42, url: 'https://app.example/' } }),
    };
    expect((await resolveTargetTab({}, ctx))?.id).toBe(42);
  });
});

describe('list_tabs — does not leak denylisted tab ids', () => {
  test('filters denylisted tabs and reports how many were hidden', async () => {
    const all = [
      { id: 1, url: 'https://example.com/', title: 'Example', active: true, windowId: 1 },
      { id: 9, url: 'https://chase.com/accounts', title: 'Chase', active: false, windowId: 1 },
      { id: 12, url: 'https://mail.proton.me/inbox', title: 'Proton', active: false, windowId: 1 },
    ];
    const ctx: any = { denylist: DENYLIST, tabs: { query: async () => all } };
    const r = await listTabsTool.execute({}, ctx);
    if (!r.ok) throw new Error('expected ok result'); // narrow ToolResultOk | ToolResultErr
    const payload = JSON.parse(r.content);
    expect(payload.tabs.map((t: any) => t.id)).toEqual([1]);   // only the public tab
    expect(payload.count).toBe(1);
    expect(payload.denylisted_tabs_hidden).toBe(2);
    // the denylisted ids/origins must appear NOWHERE in the output
    expect(r.content).not.toContain('chase.com');
    expect(r.content).not.toContain('"id": 9');
  });

  test('omits the hidden-count field when nothing is denylisted', async () => {
    const ctx: any = {
      denylist: DENYLIST,
      tabs: { query: async () => [{ id: 1, url: 'https://example.com/', title: 'x', active: true, windowId: 1 }] },
    };
    const r = await listTabsTool.execute({}, ctx);
    if (!r.ok) throw new Error('expected ok result'); // narrow ToolResultOk | ToolResultErr
    const payload = JSON.parse(r.content);
    expect(payload.denylisted_tabs_hidden).toBeUndefined();
  });
});
