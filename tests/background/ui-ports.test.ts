import { describe, test, expect } from 'bun:test';
import { makeUiPorts, makeWindowSurfaces } from '../../extension/background/ui-ports.js';

// DESIGN-12: the SW fans session state + confirm prompts out to EVERY open UI
// surface (side panel + home), not one singleton. These pin the registry's
// contract — the part the multi-port refactor depends on.

const mockPort = (name?: string) => {
  const sent: unknown[] = [];
  return { name, sent, postMessage: (m: unknown) => { sent.push(m); } };
};

describe('makeUiPorts', () => {
  test('broadcasts to every connected port', () => {
    const ui = makeUiPorts();
    const a = mockPort('sidepanel');
    const b = mockPort('home');
    ui.add(a); ui.add(b);
    expect(ui.size).toBe(2);

    ui.broadcast({ type: 'state', n: 1 });
    expect(a.sent).toEqual([{ type: 'state', n: 1 }]);
    expect(b.sent).toEqual([{ type: 'state', n: 1 }]);
  });

  test('removed ports stop receiving; size tracks', () => {
    const ui = makeUiPorts();
    const a = mockPort(); const b = mockPort();
    ui.add(a); ui.add(b);
    ui.remove(a);
    expect(ui.size).toBe(1);

    ui.broadcast({ x: 1 });
    expect(a.sent).toHaveLength(0);   // gone — no delivery
    expect(b.sent).toEqual([{ x: 1 }]);
  });

  test('a throwing port does not stop delivery to the others (fault isolation)', () => {
    const ui = makeUiPorts();
    const dead = { name: 'sidepanel', postMessage: () => { throw new Error('port closed'); } };
    const live = mockPort('home');
    ui.add(dead); ui.add(live);

    expect(() => ui.broadcast({ type: 'turn/delta' })).not.toThrow();
    expect(live.sent).toEqual([{ type: 'turn/delta' }]);  // still got it
  });

  test('empty registry: broadcast is a no-op, size 0 (confirm hang-protection reads this)', () => {
    const ui = makeUiPorts();
    expect(ui.size).toBe(0);
    expect(() => ui.broadcast({ any: true })).not.toThrow();
  });

  test('hasNamed reflects whether a surface of that name is connected', () => {
    const ui = makeUiPorts();
    const home = mockPort('home');
    const panel = mockPort('sidepanel');
    ui.add(home);
    expect(ui.hasNamed('sidepanel')).toBe(false);   // home alone → no panel
    ui.add(panel);
    expect(ui.hasNamed('sidepanel')).toBe(true);     // panel open
    expect(ui.hasNamed('home')).toBe(true);
    ui.remove(panel);
    expect(ui.hasNamed('sidepanel')).toBe(false);    // panel closed → home learns
  });

  test('adding the same port twice is idempotent (Set semantics)', () => {
    const ui = makeUiPorts();
    const a = mockPort();
    ui.add(a); ui.add(a);
    expect(ui.size).toBe(1);
    ui.broadcast({ y: 2 });
    expect(a.sent).toEqual([{ y: 2 }]);  // delivered once, not twice
  });
});

describe('window chat ownership', () => {
  const homeUrl = 'chrome-extension://peerd/home/home.html';
  const panelUrl = 'chrome-extension://peerd/sidepanel/sidepanel.html';
  const harness = (apis: Record<string, any> = {}) => {
    const tabs = new Map<number, any>([
      [11, { id: 11, windowId: 1, url: homeUrl }],
      [12, { id: 12, windowId: 1, url: `${homeUrl}#discover` }],
      [21, { id: 21, windowId: 2, url: homeUrl }],
    ]);
    const stored = new Map<string, any>();
    const published: any[] = [];
    let readFails = false;
    let writeFails = false;
    const create = () => makeWindowSurfaces({
      browser: { tabs: {
        query: async () => [...tabs.values()],
        get: async (id: number) => { if (!tabs.has(id)) throw new Error('closed'); return tabs.get(id); },
      }, ...apis },
      session: {
        sessionGet: async (key: string) => {
          if (readFails) { readFails = false; throw new Error('storage read failed'); }
          return structuredClone(stored.get(key));
        },
        sessionSet: async (key: string, rows: any) => {
          if (writeFails) { writeFails = false; throw new Error('storage write failed'); }
          stored.set(key, structuredClone(rows));
        },
      },
      homeUrl, isPanelSender: (sender: any) => sender.url === panelUrl,
      publish: (row: any) => published.push(row),
    });
    const home = (id: number) => ({ tab: tabs.get(id) });
    const panel = { url: panelUrl };
    return { tabs, stored, published, create, home, panel,
      failRead: () => { readFails = true; }, failWrite: () => { writeFails = true; } };
  };

  test('Home keeps its composer when a native panel opens, without changing another window', async () => {
    const h = harness(), owner = h.create();
    expect(await owner.get({}, h.home(11))).toMatchObject({ windowId: 1, chatOwner: 'home', homeTabId: 11 });
    await owner.panel(1, true);
    expect(await owner.get({ windowId: 1 }, h.panel))
      .toMatchObject({ chatOwner: 'home', homeTabId: 11, sidePanelOpen: true });
    expect(await owner.get({}, h.home(21)))
      .toMatchObject({ windowId: 2, chatOwner: 'home', homeTabId: 21, sidePanelOpen: false });
  });

  test('panel-first custody stays with that panel until it closes', async () => {
    const h = harness(), owner = h.create();
    await owner.panel(1, true);
    expect(await owner.get({ windowId: 1 }, h.panel)).toMatchObject({ chatOwner: 'panel' });
    expect(await owner.get({}, h.home(11))).toMatchObject({ chatOwner: 'panel', homeTabId: 11 });
    await owner.refresh();
    expect(await owner.get({}, h.home(11))).toMatchObject({ chatOwner: 'panel' });
    await owner.panel(1, false);
    expect(await owner.get({}, h.home(11))).toMatchObject({ chatOwner: 'home', sidePanelOpen: false });
  });

  test('a second Home cannot become a second composer in that window', async () => {
    const h = harness(), owner = h.create();
    await owner.get({}, h.home(11));
    expect(await owner.get({}, h.home(12))).toMatchObject({ chatOwner: 'home', homeTabId: 11 });
    expect(await owner.inWindow(1)).toMatchObject({ homeTabId: 11 });
  });

  test('legacy Chrome keeps a live panel document through port loss and a worker restart', async () => {
    const contexts = new Set(['panel-one', 'panel-two']);
    const filters: any[] = [];
    const h = harness({ runtime: { getContexts: async (filter: any) => {
      filters.push(filter);
      return contexts.has(filter.documentIds?.[0]) ? [{ windowId: -1 }] : [];
    } } });
    const owner = h.create();
    await owner.get({ windowId: 1 }, { ...h.panel, documentId: 'panel-one' });
    await owner.get({}, h.home(11));
    await owner.get({ windowId: 2 }, { ...h.panel, documentId: 'panel-two' });
    await owner.get({}, h.home(21));
    await owner.refresh();
    expect(await owner.inWindow(1)).toMatchObject({ chatOwner: 'panel', sidePanelOpen: true });
    const replacement = h.create();
    await replacement.refresh();
    expect(await replacement.inWindow(1)).toMatchObject({ chatOwner: 'panel', sidePanelOpen: true });
    contexts.delete('panel-one');
    await replacement.refresh();
    expect(await replacement.inWindow(1)).toMatchObject({ chatOwner: 'home', sidePanelOpen: false });
    expect(await replacement.inWindow(2)).toMatchObject({ chatOwner: 'panel', sidePanelOpen: true });
    expect(filters.every((filter) => filter.contextTypes[0] === 'SIDE_PANEL'
      && filter.documentIds.length === 1)).toBe(true);
    expect([...new Set(filters.map((filter) => filter.documentIds[0]))].sort()).toEqual(['panel-one', 'panel-two']);
    expect(contexts.has('panel-two')).toBe(true);
  });

  test('an unidentified routed legacy panel stays sticky until no panel documents remain', async () => {
    let live = true, failed = false;
    const context = { contextType: 'SIDE_PANEL', windowId: -1, documentUrl: `${panelUrl}#!/chat` };
    const h = harness({ runtime: { getContexts: async (filter: any) => {
      if (failed) throw new Error('context read failed');
      return (live ? [context] : []).filter((row) => filter.contextTypes.includes(row.contextType)
        && (!filter.documentUrls || filter.documentUrls.includes(row.documentUrl)));
    } } });
    const owner = h.create();
    await owner.get({ windowId: 1 }, h.panel);
    await owner.get({}, h.home(11));
    await owner.refresh();
    expect(await owner.inWindow(1)).toMatchObject({ chatOwner: 'panel', sidePanelOpen: true });
    failed = true;
    await owner.refresh();
    expect(await owner.inWindow(1)).toMatchObject({ chatOwner: 'panel', sidePanelOpen: true });
    failed = false; live = false;
    await owner.refresh();
    expect(await owner.inWindow(1)).toMatchObject({ chatOwner: 'home', sidePanelOpen: false });
  });

  test('worker replacement restores both window owners before accepting new UI reads', async () => {
    const h = harness(), first = h.create();
    await first.get({}, h.home(11));
    await first.panel(1, true);
    await first.panel(2, true);
    await first.get({}, h.home(21));
    const replacement = h.create();
    expect(await replacement.get({ windowId: 1 }, h.panel)).toMatchObject({ chatOwner: 'home', homeTabId: 11 });
    expect(await replacement.get({}, h.home(21))).toMatchObject({ chatOwner: 'panel', homeTabId: 21 });
  });

  test('a closed or moved Home cannot be returned from the old window', async () => {
    const h = harness(), owner = h.create();
    await owner.get({}, h.home(11));
    h.tabs.set(11, { ...h.tabs.get(11), windowId: 2 });
    await owner.refresh();
    expect(await owner.inWindow(1)).toMatchObject({ chatOwner: null, homeTabId: null });
    await owner.get({}, h.home(11));
    h.tabs.delete(11);
    expect(await owner.inWindow(2)).toMatchObject({ chatOwner: null, homeTabId: null });
  });

  test('Home cannot use request metadata to select another window', async () => {
    const h = harness(), owner = h.create();
    expect(await owner.get({ windowId: 2 }, h.home(11))).toMatchObject({ windowId: 1, homeTabId: 11 });
    expect(await owner.get({ windowId: 2 }, {})).toEqual({ ok: false, error: 'surface-window-required' });
    expect(h.published.every((row) => row.windowId === 1)).toBe(true);
  });

  test('Home uses the immutable sender URL when tab metadata omits it', async () => {
    const h = harness(), owner = h.create();
    expect(await owner.get({}, { url: `${homeUrl}#chat`, tab: { id: 11, windowId: 1 } }))
      .toMatchObject({ chatOwner: 'home', homeTabId: 11 });
  });

  test('Retry can recover an initial storage failure without inventing an owner', async () => {
    const h = harness(), owner = h.create();
    h.failRead();
    await expect(owner.get({}, h.home(11))).rejects.toThrow('storage read failed');
    expect(h.published).toEqual([]);
    expect(await owner.get({}, h.home(11))).toMatchObject({ chatOwner: 'home', homeTabId: 11 });
  });

  test('a failed custody write cannot expose a composer before another owner is confirmed', async () => {
    const h = harness(), owner = h.create();
    h.failWrite();
    await expect(owner.get({}, h.home(11))).rejects.toThrow('storage write failed');
    expect(h.published).toEqual([]);
    expect(await owner.get({ windowId: 1 }, h.panel)).toMatchObject({ chatOwner: 'panel', homeTabId: null });
  });
});
