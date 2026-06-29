// The denylist must guard the RESOLVED target tab, not just ctx.activeTab.
// A DOM tool driven with args.tabId pointing at a denylisted tab must be
// refused. (The matching enumeration-leak fence — that the tab catalog never
// surfaces a denylisted tab's id — is covered in tools/actor-list.test.ts,
// since actor_list replaced list_tabs as the enumeration primitive.)

import { describe, test, expect } from 'bun:test';
import { resolveTargetTab, isDenylistedTab } from '../../extension/peerd-runtime/tools/defs/dom-helpers.js';

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

describe('resolveTargetTab — DESIGN-17 web-actor fail-closed', () => {
  // A web actor OWNS one tab via ctx.activeTab. If that tab vanished mid-turn
  // (so ctx.activeTab is absent), it must NEVER fall back to the user's foreground
  // tab — it refuses instead. The foreground query is the leak this closes.
  test('an actor ctx with no activeTab refuses — never queries the foreground', async () => {
    let foregroundQueried = false;
    const ctx: any = {
      actorType: 'web',
      tabs: {
        get: async () => { throw new Error('no tab'); },
        query: async () => { foregroundQueried = true; return [{ id: 7, url: 'https://user-bank.com/' }]; },
      },
    };
    expect(await resolveTargetTab({}, ctx)).toBeNull();
    expect(foregroundQueried).toBe(false);   // the foreground was NOT touched
  });

  test('a NON-actor ctx with no activeTab still uses the foreground (unchanged)', async () => {
    const ctx: any = {
      denylist: [],
      tabs: { get: async () => { throw new Error('x'); }, query: async () => [{ id: 7, url: 'https://example.com/' }] },
    };
    expect((await resolveTargetTab({}, ctx))?.id).toBe(7);
  });

  test('a web actor still drives its OWN tab via ctx.activeTab', async () => {
    const ctx: any = {
      actorType: 'web',
      denylist: [],
      activeTab: { id: 42, url: 'https://app.example/', origin: 'https://app.example' },
      tabs: tabsApi({ 42: { id: 42, url: 'https://app.example/' } }),
    };
    expect((await resolveTargetTab({}, ctx))?.id).toBe(42);
  });
});

