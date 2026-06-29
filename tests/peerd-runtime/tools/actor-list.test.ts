// actor_list — the ONE discovery surface that collapsed vm_list / js_list /
// app_list / list_tabs / list_integrations. It aggregates the three engine
// registries (session-scoped) + open tabs (global, denylisted dropped) + API
// integrations into one uniform columnar list keyed by `type`. These tests pin:
// the uniform row shape per type, the denylist enumeration-leak fence inherited
// from list_tabs, and the per-source SOFT failure (one broken source never
// blanks the whole catalog).

import { describe, test, expect } from 'bun:test';
import { actorListTool } from '../../../extension/peerd-runtime/tools/defs/actor-list.js';

// A ctx with every source wired. Each registry mirrors the real snapshot shape:
// vm → { vms, currentVmId }, js → { notebooks, currentId }, app → { apps, currentId }.
const fullCtx = (over: Record<string, any> = {}) => ({
  session: { sessionId: 's1' },
  vmRegistry: { snapshot: async () => ({ vms: [
    { id: 'vm-1', name: 'project-alpha', pinned: true },
    { id: 'vm-2', name: 'scratch' },
  ], currentVmId: 'vm-2' }) },
  vmTabTracker: { getTabId: (id: string) => (id === 'vm-2' ? 42 : null) },
  jsRegistry: { snapshot: async () => ({ notebooks: [
    { id: 'nb-1', name: 'analysis' },
  ], currentId: 'nb-1' }) },
  jsTabTracker: { getTabId: () => null },
  appRegistry: { snapshot: async () => ({ apps: [
    { id: 'app-1', name: 'calculator', tags: ['math', 'demo'] },
  ], currentId: null }) },
  appTabTracker: { getTabId: () => null },
  tabs: { query: async () => [
    { id: 7, url: 'https://example.com/x', title: 'Example', active: true, windowId: 1 },
  ] },
  listApiIntegrations: async () => [
    { origin: 'https://api.github.com', keyed: true, formed: true },
    { origin: 'https://api.public.org', keyed: false, formed: true },
  ],
  denylist: [],
  ...over,
});

const parse = (r: any) => {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error('expected ok');
  return JSON.parse(r.content);
};

describe('actor_list — unified actor catalog', () => {
  test('aggregates every source into one uniform-shaped list keyed by type', async () => {
    const r = await actorListTool.execute({}, fullCtx() as any);
    const out = parse(r);
    // 2 vms + 1 notebook + 1 app + 1 tab + 2 integrations
    expect(out.count).toBe(7);

    // densified (>= 5 uniform records) — columnar pair, not the raw array.
    expect(out.actors).toBeUndefined();
    expect(out.actors_columns).toEqual(['type', 'handle', 'name', 'live', 'current', 'detail']);
    const rows: any[][] = out.actors_rows;
    const col = (name: string) => out.actors_columns.indexOf(name);
    const byHandle = (h: string | number) => rows.find((row) => row[col('handle')] === h)!;

    // webvm: handle=id, live from the tab tracker, current from currentVmId, pinned in detail.
    expect(byHandle('vm-1')[col('type')]).toBe('webvm');
    expect(byHandle('vm-1')[col('name')]).toBe('project-alpha');
    expect(byHandle('vm-1')[col('live')]).toBe(false);
    expect(byHandle('vm-1')[col('current')]).toBe(false);
    expect(byHandle('vm-1')[col('detail')]).toBe('pinned');
    expect(byHandle('vm-2')[col('live')]).toBe(true);     // has tab 42
    expect(byHandle('vm-2')[col('current')]).toBe(true);  // currentVmId

    // notebook + app
    expect(byHandle('nb-1')[col('type')]).toBe('notebook');
    expect(byHandle('nb-1')[col('current')]).toBe(true);
    expect(byHandle('app-1')[col('type')]).toBe('app');
    expect(byHandle('app-1')[col('detail')]).toBe('math, demo');   // tags joined

    // tab: handle=tabId, origin in detail, active→current, always live.
    expect(byHandle(7)[col('type')]).toBe('tab');
    expect(byHandle(7)[col('name')]).toBe('Example');
    expect(byHandle(7)[col('detail')]).toBe('https://example.com');
    expect(byHandle(7)[col('current')]).toBe(true);
    expect(byHandle(7)[col('live')]).toBe(true);

    // integration: handle=origin, keyed-ness in detail, formed→live.
    expect(byHandle('https://api.github.com')[col('type')]).toBe('integration');
    expect(byHandle('https://api.github.com')[col('detail')]).toBe('keyed');
    expect(byHandle('https://api.public.org')[col('detail')]).toBe('unkeyed');
    expect(byHandle('https://api.github.com')[col('live')]).toBe(true);  // formed
  });

  test('groups by type order (webvm→notebook→app→tab→integration)', async () => {
    const r = await actorListTool.execute({}, fullCtx() as any);
    const out = parse(r);
    const types = out.actors_rows.map((row: any[]) => row[out.actors_columns.indexOf('type')]);
    // every webvm precedes every notebook precedes app precedes tab precedes integration
    const order = ['webvm', 'notebook', 'app', 'tab', 'integration'];
    const ranks = types.map((t: string) => order.indexOf(t));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  test('drops denylisted tabs and reports the hidden count (enumeration-leak fence)', async () => {
    const ctx = fullCtx({
      // only the engine sources off so the result is tab-only and easy to read
      vmRegistry: undefined, jsRegistry: undefined, appRegistry: undefined,
      listApiIntegrations: undefined,
      denylist: ['chase.com', 'mail.proton.me'],
      tabs: { query: async () => [
        { id: 1, url: 'https://example.com/', title: 'Example', active: true, windowId: 1 },
        { id: 9, url: 'https://chase.com/accounts', title: 'Chase', active: false, windowId: 1 },
        { id: 12, url: 'https://mail.proton.me/inbox', title: 'Proton', active: false, windowId: 1 },
      ] },
    });
    const out = parse(await actorListTool.execute({}, ctx as any));
    expect(out.count).toBe(1);                       // only the public tab
    expect(out.denylisted_tabs_hidden).toBe(2);
    // the denylisted ids/origins must appear NOWHERE in the output
    const blob = JSON.stringify(out);
    expect(blob).not.toContain('chase.com');
    expect(blob).not.toContain('proton');
    expect(blob).not.toContain('"id":9');
  });

  test('omits the hidden-count field when nothing is denylisted', async () => {
    const ctx = fullCtx({
      vmRegistry: undefined, jsRegistry: undefined, appRegistry: undefined,
      listApiIntegrations: undefined,
      denylist: ['chase.com'],
      tabs: { query: async () => [{ id: 1, url: 'https://example.com/', title: 'x', active: true, windowId: 1 }] },
    });
    const out = parse(await actorListTool.execute({}, ctx as any));
    expect(out.denylisted_tabs_hidden).toBeUndefined();
  });

  test('one broken source fails SOFT — others still listed, the gap surfaced', async () => {
    const ctx = fullCtx({
      vmRegistry: { snapshot: async () => { throw new Error('vm registry down'); } },
    });
    const out = parse(await actorListTool.execute({}, ctx as any));
    // vms dropped (2 fewer than the 7 above), notebook/app/tab/integrations remain
    expect(out.count).toBe(5);
    expect(out.unavailable).toContain('webvm: vm registry down');
    // no webvm rows leaked into the catalog
    expect(JSON.stringify(out)).not.toContain('vm-1');
    expect(JSON.stringify(out)).not.toContain('project-alpha');
  });

  test('fully unwired ctx (tests / non-SW dispatch) returns an empty list, not an error', async () => {
    const out = parse(await actorListTool.execute({}, { session: { sessionId: 's' } } as any));
    expect(out.count).toBe(0);
  });

  test('is a read tool with no declared origins (pure enumeration)', () => {
    expect(actorListTool.sideEffect).toBe('read');
    expect(actorListTool.origins?.({}, {} as any)).toEqual([]);
    expect(actorListTool.name).toBe('actor_list');
  });
});
