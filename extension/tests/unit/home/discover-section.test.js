// @ts-check
// The real Discover component against a fake host. Each case gets a fresh
// effects object, so no custody leaks between cases.
import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { encodeDidKey } from '/shared/address/did.js';
import { formatDwappUri } from '/shared/address/dwapp-uri.js';
import { immutableAppRoot } from '/shared/address/immutable-app-root.js';
import browser from '/shared/browser-api.js';
import { packagedStarter } from '/shared/starter-catalog.js';
import { discoveryAddress } from '/home/discovery-address.js';
import { createEffects, shortKey } from '/home/discover-model.js';
import { DiscoverSection } from '/home/discover-section.js';

/** @typedef {import('/home/discover-model.js').DwebApp} DwebApp */
/** @typedef {import('/home/discover-section.js').Attrs} Attrs */
/** @typedef {{type:string} & Record<string, unknown>} Message */
/** @typedef {{id:string, name?:string, dweb?:Record<string, unknown>}} LibraryRow */
/** @typedef {{did:string, name:string, saved:boolean}} ContactRow */
/**
 * @typedef {{heard:DwebApp[], library:LibraryRow[], contacts:ContactRow[], linked:number, running:boolean,
 *   lease:string, heardFails:boolean, libraryFails:boolean}} HostState
 */

const KEY = 'peerd.manual-app-install.pending';
const READS = Object.freeze(['bootstrap/ready', 'dweb/distributed/info', 'dweb/base/heard', 'apps/list', 'contacts/list']);
const UNKNOWN_INSTALL = 'peerd could not confirm whether the install finished. Refresh to check before trying again.';
const WASM_HINT = 'The WebAssembly hint comes from the maker. peerd does not check it.';
/** @param {number} n */
const didOf = (n) => encodeDidKey(new Uint8Array(32).fill(n));
const ANA = didOf(1);
const BOB = didOf(2);
const CARL = didOf(3);
const SELF = didOf(9);

/**
 * @param {string} id @param {string} name @param {string} publisher @param {Partial<DwebApp>} [extra]
 * @returns {DwebApp}
 */
const card = (id, name, publisher, extra = {}) => {
  const version = extra.version_id ?? `${id}-v1`;
  return { dwapp_id: id, name, publisher, slug: id, seq: 1, version_id: version, uri: `peerd://${publisher}/${version}`, ...extra };
};
/** @param {string} id @param {DwebApp} app @param {Record<string, unknown>} [dweb] @returns {LibraryRow} */
const local = (id, app, dweb = {}) => ({
  id, name: app.name,
  dweb: { uri: app.uri, dwapp_id: app.dwapp_id, version_id: app.version_id, seq: app.seq, publisher: app.publisher, ...dweb },
});

/**
 * A fake host. Read routes answer from `state`; `routes` answer the rest.
 * Any other message throws, which a case can see in `calls`.
 * @param {Partial<HostState>} [initial] @param {Record<string, (message: Message) => unknown>} [routes]
 */
const fakeHost = (initial = {}, routes = {}) => {
  /** @type {HostState} */
  const state = {
    heard: [], library: [], contacts: [], linked: 3, running: true, lease: 'active',
    heardFails: false, libraryFails: false, ...initial,
  };
  /** @type {Message[]} */ const calls = [];
  /** @param {Message} message */
  const send = async (message) => {
    calls.push(message);
    const route = routes[message.type];
    if (route) return route(message);
    if (message.type === 'bootstrap/ready') return { ok: true, featureLeases: { leases: { dweb: { status: state.lease } } } };
    if (message.type === 'dweb/distributed/info') return { ok: true, running: state.running, linkedCount: state.linked, did: SELF };
    if (message.type === 'dweb/base/heard') {
      return state.heardFails ? { ok: false, error: 'raw offscreen host epoch' } : { ok: true, apps: state.heard };
    }
    if (message.type === 'apps/list') return state.libraryFails ? { ok: false } : { ok: true, apps: state.library };
    if (message.type === 'contacts/list') return { ok: true, contacts: state.contacts };
    throw new Error(`unexpected ${message.type}`);
  };
  /** @param {string} type */
  const count = (type) => calls.filter(call => call.type === type).length;
  const writes = () => calls.filter(call => !READS.includes(call.type));
  return { state, calls, send, count, writes };
};

/** @template T @returns {{promise: Promise<T>, resolve: (value: T) => void, reject: (reason: unknown) => void}} */
const deferred = () => {
  /** @type {(value: T) => void} */ let resolve = () => {};
  /** @type {(reason: unknown) => void} */ let reject = () => {};
  /** @type {Promise<T>} */ const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

/**
 * @param {Partial<Attrs> & {send: Attrs['send']}} initial
 * @param {{keepReceipt?: boolean, parent?: HTMLElement}} [options]
 */
const mount = (initial, { keepReceipt = false, parent = document.body } = {}) => {
  if (!keepReceipt) sessionStorage.removeItem(KEY);
  const root = document.createElement('div');
  parent.append(root);
  /** @type {Attrs} */ const attrs = { enabled: true, effects: createEffects(), initialSeed: 42, ...initial };
  m.mount(root, { view: () => m(DiscoverSection, attrs) });
  return {
    root, attrs,
    /** @param {Partial<Attrs>} next */
    set: (next) => { Object.assign(attrs, next); m.redraw.sync(); },
    close: () => { m.mount(root, null); root.remove(); },
  };
};

const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); m.redraw.sync(); };
/** @param {() => boolean} ready */
const until = async (ready) => {
  const end = performance.now() + 5000;
  while (!ready()) {
    if (performance.now() > end) throw new Error('Discover did not settle');
    await settle();
  }
};
/** @param {ParentNode} root @param {string} selector @returns {HTMLElement} */
const el = (root, selector) => {
  const node = root.querySelector(selector);
  if (!(node instanceof HTMLElement)) throw new Error(`missing ${selector}`);
  return node;
};
/** @param {ParentNode} root @param {string} label @returns {HTMLButtonElement|undefined} */
const button = (root, label) => /** @type {HTMLButtonElement[]} */ ([...root.querySelectorAll('button')])
  .find(node => node.textContent?.trim() === label);
/** @param {ParentNode} root @param {string} label */
const click = async (root, label) => {
  const target = button(root, label);
  if (!target) throw new Error(`no button "${label}"`);
  target.click();
  await settle();
};
/** A real click focuses the control first. @param {ParentNode} root @param {string} label */
const press = async (root, label) => { button(root, label)?.focus(); await click(root, label); };
/** @param {Node} root */
const text = (root) => root.textContent ?? '';
/** @param {ParentNode} root @param {string} key */
const tileOf = (root, key) => root.querySelector(`[data-key="${CSS.escape(key)}"]`);
/** @param {ParentNode} root @param {string} key */
const openTile = async (root, key) => { el(root, `[data-key="${CSS.escape(key)}"] .disc-tile-open`).click(); await settle(); };
/** @param {ParentNode} root @param {string} key */
const tileAction = (root, key) => text(el(root, `[data-key="${CSS.escape(key)}"] .disc-actions`)).trim();
/** @param {ParentNode} root */
const tileKeys = (root) => [...root.querySelectorAll('.disc-tile')].map(node => node.getAttribute('data-key'));
/** @param {ParentNode} root @param {string} value */
const enterLink = (root, value) => {
  const input = /** @type {HTMLInputElement} */ (el(root, '.disc-start-form input'));
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  m.redraw.sync();
};
/** @param {ParentNode} root @param {string} value */
const search = (root, value) => {
  const input = /** @type {HTMLInputElement} */ (el(root, 'input.disc-search'));
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  m.redraw.sync();
};
/** @param {ParentNode} root */
const facts = (root) => [...root.querySelectorAll('dl.disc-facts dt')].map(dt => [text(dt), text(/** @type {Element} */ (dt.nextElementSibling))]);
/** @param {ParentNode} root */
const panel = (root) => el(root, '.disc-panel');
/** @param {ParentNode} root */
const libraryLine = (root) => root.querySelector('.disc-footnote[role="status"]');
/** @param {ParentNode} root */
const tileNames = (root) => [...root.querySelectorAll('.disc-tile')].map(node => text(el(node, '.disc-tile-name')));
const focusPoll = async () => { window.dispatchEvent(new Event('focus')); await settle(); };

/**
 * Record the Settings pages a click opens. The HTTP runner has no tabs
 * namespace, so own a minimal one and restore its absence after.
 * @param {(opened: string[]) => Promise<void>} run
 */
const withTabs = async (run) => {
  const api = /** @type {{tabs?: {create?: (options: {url: string}) => Promise<unknown>}}} */ (/** @type {unknown} */ (browser));
  const original = Object.getOwnPropertyDescriptor(api, 'tabs');
  /** @type {string[]} */ const opened = [];
  api.tabs = { ...api.tabs, create: async (options) => { opened.push(options.url); return { id: 1 }; } };
  try { await run(opened); } finally {
    if (original) Object.defineProperty(api, 'tabs', original);
    else delete api.tabs;
  }
};

describe('home.discover start list', () => {
  it('network off: renders the start list and sends no message', async () => {
    const host = fakeHost({ heard: [card('a', 'App', ANA)] });
    const view = mount({ send: host.send, enabled: false });
    try {
      await settle();
      window.dispatchEvent(new Event('focus'));
      await settle();
      expect(el(view.root, 'h1').textContent).toBe('Discover');
      expect(view.root.querySelectorAll('li.disc-start-row').length).toBe(3);
      for (const line of ['Try an included app', 'Join the peer network', 'Open a share link', 'Share links need the peer network.',
        `${packagedStarter('csv-lab')?.name} comes with peerd and works on this device.`,
        'See apps your peers share. Uses some bandwidth and storage, and peers can see your network address. Your private apps, files, chats and keys stay private.']) {
        expect(text(view.root)).toContain(line);
      }
      expect(button(view.root, 'Review starter')).toBeTruthy();
      expect(el(view.root, '[data-network-choice="enable"]').textContent).toBe('Enable peer network');
      expect(host.calls.length).toBe(0);
    } finally { view.close(); }
  });

  it('Enable peer network sends one settings write, stays disabled while saving, and shows a failure', async () => {
    const save = deferred();
    let reconciles = 0;
    const host = fakeHost({}, {
      'settings/update': () => save.promise,
      'state/get': () => ({ ok: true, state: { settings: { dwebChoiceMade: true, dwebEnabled: false } } }),
    });
    const view = mount({ send: host.send, enabled: false, reconcileState: async () => { reconciles++; } });
    try {
      const enable = /** @type {HTMLButtonElement} */ (el(view.root, '[data-network-choice="enable"]'));
      enable.click(); await settle();
      expect(enable.disabled).toBe(true);
      enable.click(); await settle();
      expect(host.calls).toEqual([{ type: 'settings/update', patch: { dwebEnabled: true } }]);
      save.resolve({ ok: false }); await settle();
      expect(text(el(view.root, '[role="alert"]'))).toBe('Your network choice could not be confirmed. Refresh status before choosing again.');
      expect(enable.disabled).toBe(true);
      expect(reconciles).toBe(1);
      await click(view.root, 'Refresh status');
      expect(host.count('state/get')).toBe(1);
      expect(view.root.querySelector('[role="alert"]')).toBe(null);
      expect(enable.disabled).toBe(false);
      expect(reconciles).toBe(2);
      expect(host.count('settings/update')).toBe(1);
    } finally { save.resolve({ ok: false }); view.close(); }
  });

  it('network off: the start row also names the other packaged starter, and each opens its own review', async () => {
    const host = fakeHost();
    const view = mount({ send: host.send, enabled: false });
    try {
      await withTabs(async (opened) => {
        const other = /** @type {HTMLButtonElement} */ (view.root.querySelector('.disc-start-text button'));
        expect(text(other)).toBe(packagedStarter('wasm-image')?.name ?? '');
        expect(other.getAttribute('aria-label')).toBe(`Review ${packagedStarter('wasm-image')?.name}`);
        other.click(); await settle();
        await click(view.root, 'Review starter');
        expect(opened.map(url => url.slice(url.indexOf('#')))).toEqual(['#!/transfer?starter=wasm-image', '#!/transfer?starter=csv-lab']);
      });
      expect(host.calls.length).toBe(0);
    } finally { view.close(); }
  });

  it('Paste link opens the share row in place; with the network off Check link stays disabled', async () => {
    const host = fakeHost();
    const view = mount({ send: host.send, enabled: false });
    try {
      await click(view.root, 'Paste link');
      expect(view.root.querySelectorAll('li.disc-start-row').length).toBe(3);
      expect(view.root.querySelector('li.disc-start-row.is-open')).toBeTruthy();
      expect(button(view.root, 'Paste link')).toBe(undefined);
      expect(document.activeElement).toBe(view.root.querySelector('.disc-start-form input'));
      expect(el(view.root, '.disc-start-form input').getAttribute('aria-label')).toBe('Share link');
      enterLink(view.root, formatDwappUri({ did: ANA, hash: 'a'.repeat(64) }));
      expect(button(view.root, 'Check link')?.disabled).toBe(true);
      expect(text(view.root)).toContain('Join the peer network first.');
      button(view.root, 'Check link')?.click(); await settle();
      expect(host.calls.length).toBe(0);
    } finally { view.close(); }
  });
});

describe('home.discover root states', () => {
  it('a heard failure shows a bounded alert, never the raw error or an empty-network claim', async () => {
    const host = fakeHost({ heardFails: true });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(text(el(view.root, '[role="alert"]'))).toContain('could not refresh peer apps');
      expect(text(view.root).includes('raw offscreen host epoch')).toBe(false);
      expect(text(view.root).includes('No apps shared yet')).toBe(false);
    } finally { view.close(); }
  });

  it('shows the connected, looking, empty and offline roots; Retry connection starts once', async () => {
    const two = [card('a', 'App A', ANA), card('b', 'App B', BOB)];
    const connected = fakeHost({ heard: two, linked: 1 });
    let view = mount({ send: connected.send });
    try {
      await settle();
      expect(text(el(view.root, '.disc-status-live'))).toBe('Connected to 1 peer');
      expect(text(el(view.root, '.disc-status-count'))).toBe('2 apps shared');
      expect(view.root.querySelectorAll('.disc-tile').length).toBe(2);
      expect(button(view.root, 'Surprise me')).toBeTruthy();
      expect(button(view.root, 'Shuffle')).toBeTruthy();
    } finally { view.close(); }

    view = mount({ send: fakeHost({ lease: 'starting' }).send });
    try {
      await settle();
      expect(text(el(view.root, '.disc-head-block [role="status"]'))).toBe('Looking for peers…');
      expect(text(view.root)).toContain('Apps show up as peers share them');
      expect(view.root.querySelector('input.disc-search')).toBe(null);
      expect(view.root.querySelector('.disc-pills')).toBe(null);
      expect(button(view.root, 'Show included apps')).toBeTruthy();
    } finally { view.close(); }

    let library = 0;
    view = mount({ send: fakeHost({ linked: 3 }).send, onLibrary: () => { library++; } });
    try {
      await settle();
      expect(text(view.root)).toContain('No apps shared yet');
      expect(view.root.querySelector('.disc-pills')).toBe(null);
      expect(text(view.root)).toContain('Apps appear here when your peers share them. You can share one of yours from the Library.');
      await click(view.root, 'Go to Library');
      expect(library).toBe(1);
    } finally { view.close(); }

    const start = deferred();
    const offline = fakeHost({ heard: two, running: false }, { 'dweb/base/start': () => start.promise });
    view = mount({ send: offline.send });
    try {
      await settle();
      expect(text(el(view.root, '.disc-status-live'))).toBe('Peer network is offline');
      expect(view.root.querySelector('.disc-status-count')).toBe(null);
      expect(button(view.root, 'Surprise me')).toBe(undefined);
      expect(view.root.querySelector('.disc-refresh')).toBe(null);
      await click(view.root, 'Retry connection');
      expect(button(view.root, 'Reconnecting…')?.disabled).toBe(true);
      button(view.root, 'Reconnecting…')?.click(); await settle();
      expect(offline.count('dweb/base/start')).toBe(1);
      offline.state.running = true;
      start.resolve({ ok: true }); await settle();
      expect(text(el(view.root, '.disc-status-live'))).toBe('Connected to 3 peers');
      expect(offline.count('dweb/base/start')).toBe(1);
    } finally { start.resolve({ ok: true }); view.close(); }
  });

  it('offline grid shows only Library apps from peers, each with Open', async () => {
    const kept = card('kept', 'Kept app', ANA, { description: 'Already here.' });
    const newer = card('kept', 'Kept app', ANA, { version_id: 'kept-v2', seq: 2, uri: `peerd://${ANA}/kept-v2` });
    const host = fakeHost({
      heard: [newer, card('new', 'New app', BOB)], running: false,
      library: [local('local-kept', kept), { id: 'local-only', name: 'Made here' }],
    }, { 'apps/open': () => ({ ok: true }) });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(tileKeys(view.root)).toEqual(['kept']);
      expect(tileAction(view.root, 'kept')).toBe('Open');
      expect(text(view.root).includes('Update ready')).toBe(false);
      el(view.root, '[data-key="kept"] .disc-tile-action').click(); await settle();
      expect(host.writes()).toEqual([{ type: 'apps/open', appId: 'local-kept' }]);
    } finally { view.close(); }
  });
});

describe('home.discover included apps', () => {
  // The looking and empty roots draw no pills, so a button opens Included there.
  for (const [label, initial, root, opener, back] of /** @type {const} */ ([
    ['looking', { lease: 'starting' }, 'Apps show up as peers share them', 'Show included apps', 'Show included apps'],
    ['connected and empty', { linked: 3 }, 'No apps shared yet', 'Show included apps', 'Show included apps'],
    ['offline with no Library apps', { running: false }, 'Peer network is offline', 'Included', 'All'],
  ])) {
    it(`the ${label} root reaches Included: both starters and Commons, and focus follows the change`, async () => {
      const host = fakeHost(initial);
      const view = mount({ send: host.send });
      try {
        await settle();
        expect(text(view.root)).toContain(root);
        expect(!!view.root.querySelector('.disc-pills')).toBe(opener === 'Included');
        await press(view.root, opener);
        expect(tileNames(view.root)).toEqual(['CSV Lab', 'WebAssembly Image Lab', 'Peerd-to-Peerd Commons']);
        expect(button(view.root, 'Add and open Commons')?.disabled).toBe(false);
        expect(document.activeElement).toBe(button(view.root, 'Included'));
        await press(view.root, 'All');
        expect(view.root.querySelector('.disc-tile')).toBe(null);
        expect(text(view.root)).toContain(root);
        expect(document.activeElement).toBe(button(view.root, back));
        expect(host.writes().length).toBe(0);
      } finally { view.close(); }
    });
  }

  it('Clear filters on an empty Included search returns focus to Show included apps when the root has no pills', async () => {
    const view = mount({ send: fakeHost({ lease: 'starting' }).send });
    try {
      await settle();
      await click(view.root, 'Show included apps');
      search(view.root, 'kanban');
      await click(view.root, 'Clear filters');
      expect(text(view.root)).toContain('Apps show up as peers share them');
      expect(document.activeElement).toBe(button(view.root, 'Show included apps'));
    } finally { view.close(); }
  });
});

describe('home.discover tiles and filters', () => {
  it('tile ladder: can not run, then Update, then Open, then Review; a tile with no button opens from the keyboard', async () => {
    const old = card('upd', 'Updater', BOB);
    const mineOld = card('mine', 'Mine', SELF);
    const host = fakeHost({
      heard: [
        card('cant', 'Cant run', CARL, { version_id: 'cant-v2', seq: 2, runtimeCompatibility: { status: 'unsupported', message: 'Unsupported App runtime target: wasi.' } }),
        card('upd', 'Updater', BOB, { version_id: 'upd-v2', seq: 2, uri: `peerd://${BOB}/upd-v2` }),
        card('open', 'Opener', ANA),
        card('rev', 'Reviewer', ANA),
        card('mine', 'Mine', SELF, { version_id: 'mine-v2', seq: 2 }),
      ],
      library: [local('local-cant', card('cant', 'Cant run', CARL)), local('local-upd', old), local('local-open', card('open', 'Opener', ANA)), local('local-mine', mineOld)],
    }, { 'apps/open': () => ({ ok: true }) });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(tileAction(view.root, 'cant')).toBe('Can’t run in this browser');
      expect(el(view.root, '[data-key="cant"] .disc-actions').querySelector('button')).toBe(null);
      expect(tileAction(view.root, 'upd')).toBe('Update');
      expect(text(el(view.root, '[data-key="upd"]'))).toContain('Update ready');
      expect(tileAction(view.root, 'open')).toBe('Open');
      expect(tileAction(view.root, 'rev')).toBe('Review');
      expect(tileAction(view.root, 'mine')).toBe('Open');
      expect(view.root.querySelectorAll('.disc-tile-flag').length).toBe(1);

      el(view.root, '[data-key="open"] .disc-tile-action').click(); await settle();
      expect(host.writes()).toEqual([{ type: 'apps/open', appId: 'local-open' }]);
      expect(view.root.querySelector('.disc-back')).toBe(null);

      const name = el(view.root, '[data-key="cant"] .disc-tile-open');
      expect(name.tagName).toBe('BUTTON');
      name.focus();
      expect(document.activeElement).toBe(name);
      name.click(); await settle();
      expect(text(view.root)).toContain('This app can’t run in this browser.');
      expect(host.writes().length).toBe(1);
    } finally { view.close(); }
  });

  it('pills: Updates, From contacts (saved only), Included, and Clear filters', async () => {
    const host = fakeHost({
      heard: [
        card('upd', 'Updater', CARL, { version_id: 'upd-v2', seq: 2 }),
        card('ana', 'Ana app', ANA),
        card('bob', 'Bob app', BOB),
        card('new', 'New app', CARL),
      ],
      library: [local('local-upd', card('upd', 'Updater', CARL))],
      contacts: [{ did: ANA, name: 'Ana', saved: true }, { did: BOB, name: 'Bob', saved: false }],
    });
    const view = mount({ send: host.send });
    /** @param {string} label */
    const pressed = (label) => button(view.root, label)?.getAttribute('aria-pressed');
    try {
      await settle();
      expect(el(view.root, '.disc-pills').getAttribute('role')).toBe('group');
      expect(pressed('All')).toBe('true');
      expect(tileKeys(view.root).length).toBe(4);
      await click(view.root, 'Updates');
      expect(pressed('Updates')).toBe('true');
      expect(pressed('All')).toBe('false');
      expect(tileKeys(view.root)).toEqual(['upd']);
      await click(view.root, 'From contacts');
      expect(tileKeys(view.root)).toEqual(['ana']);
      await click(view.root, 'Included');
      const included = [...view.root.querySelectorAll('.disc-tile')];
      expect(included.map(node => text(el(node, '.disc-tile-name')))).toEqual(['CSV Lab', 'WebAssembly Image Lab', 'Peerd-to-Peerd Commons']);
      expect(included.every(node => text(node).includes('Comes with peerd'))).toBe(true);
      expect(included.slice(0, 2).map(node => text(el(node, '.disc-actions')))).toEqual(['Review', 'Review']);
      search(view.root, 'kanban');
      expect(view.root.querySelectorAll('.disc-tile').length).toBe(0);
      expect(text(el(view.root, '.disc-empty[role="status"]'))).toContain('No matching apps');
      await click(view.root, 'Clear filters');
      expect(pressed('All')).toBe('true');
      expect(/** @type {HTMLInputElement} */ (el(view.root, 'input.disc-search')).value).toBe('');
      expect(document.activeElement).toBe(view.root.querySelector('input.disc-search'));
      expect(tileKeys(view.root).length).toBe(4);
      expect(host.writes().length).toBe(0);
    } finally { view.close(); }
  });

  it('polling keeps the same tile node and the pending state while peers come and go', async () => {
    const install = deferred();
    const host = fakeHost({
      heard: [card('pending', 'Pending app', ANA), card('other', 'Other app', BOB)],
    }, { 'dweb/base/install': () => install.promise });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, 'pending');
      await click(view.root, 'Install and share');
      await click(view.root, 'Discover');
      const pending = tileOf(view.root, 'pending');
      const other = tileOf(view.root, 'other');
      expect(tileAction(view.root, 'pending')).toBe('Installing…');
      host.state.heard = [card('other', 'Other app', BOB), card('late', 'Late app', CARL)];
      el(view.root, 'button.disc-refresh').click(); await settle();
      expect(tileOf(view.root, 'pending')).toBe(pending);
      expect(tileOf(view.root, 'other')).toBe(other);
      expect(tileKeys(view.root).length).toBe(3);
      expect(tileAction(view.root, 'pending')).toBe('Installing…');
      install.resolve({ ok: false, outcomeKnown: false }); await settle();
      el(view.root, 'button.disc-refresh').click(); await settle();
      expect(tileOf(view.root, 'pending')).toBe(pending);
      expect(tileAction(view.root, 'pending')).toBe('Review');
      expect(host.count('dweb/base/install')).toBe(1);
    } finally { install.resolve({ ok: false }); view.close(); }
  });

  it('renders 96 tiles, adds 96 per Show more, and browsing never writes', async () => {
    const heard = Array.from({ length: 130 }, (_, i) => card(`app-${i}`, `App ${i}`, didOf(10 + (i % 7))));
    const host = fakeHost({ heard });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(view.root.querySelectorAll('.disc-tile').length).toBe(96);
      const before = tileKeys(view.root).join(',');
      el(view.root, 'button.disc-refresh').click(); await settle();
      expect(tileKeys(view.root).join(',')).toBe(before);
      await click(view.root, 'Show more');
      expect(view.root.querySelectorAll('.disc-tile').length).toBe(130);
      expect(button(view.root, 'Show more')).toBe(undefined);
      await click(view.root, 'Shuffle');
      expect(tileKeys(view.root).join(',') === before).toBe(false);
      expect(host.writes().length).toBe(0);
    } finally { view.close(); }
  });

  it('Pending and unknown apps stay visible through refresh and filters', async () => {
    const app = card('pending', 'Pending app', BOB, { version_id: 'pending-v3', seq: 3 });
    const install = deferred();
    const host = fakeHost({
      heard: [app, card('ana', 'Ana app', ANA)], contacts: [{ did: ANA, name: 'Ana', saved: true }],
    }, { 'dweb/base/install': () => install.promise });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, 'pending');
      await click(view.root, 'Install and share');
      await click(view.root, 'Discover');
      await click(view.root, 'From contacts');
      expect(tileKeys(view.root).sort()).toEqual(['ana', 'pending']);
      host.state.heard = [card('ana', 'Ana app', ANA)];
      el(view.root, 'button.disc-refresh').click(); await settle();
      expect(tileAction(view.root, 'pending')).toBe('Installing…');
      await click(view.root, 'Updates');
      expect(tileKeys(view.root)).toEqual(['pending']);
      install.resolve({ ok: false, outcomeKnown: false }); await settle();
      el(view.root, 'button.disc-refresh').click(); await settle();
      expect(tileKeys(view.root)).toEqual(['pending']);
      expect(tileAction(view.root, 'pending')).toBe('Review');
      host.state.library = [local('local-pending', app)];
      el(view.root, 'button.disc-refresh').click(); await settle();
      expect(tileKeys(view.root)).toEqual([]);
      expect(text(view.root)).toContain('No matching apps');
      expect(host.count('dweb/base/install')).toBe(1);
    } finally { install.resolve({ ok: false }); view.close(); }
  });
});

describe('home.discover app page', () => {
  it('focuses the back link on open; Back restores the scroll and the tile focus', async () => {
    const heard = Array.from({ length: 12 }, (_, i) => card(`app-${i}`, `App ${i}`, didOf(10 + i), { description: `A small app number ${i}.` }));
    const scroller = document.createElement('div');
    scroller.className = 'home-content';
    scroller.style.cssText = 'height:160px;overflow:auto';
    document.body.append(scroller);
    const view = mount({ send: fakeHost({ heard }).send }, { parent: scroller });
    try {
      await settle();
      scroller.scrollTop = 240;
      expect(scroller.scrollTop).toBe(240);
      await openTile(view.root, 'app-5');
      expect(document.activeElement).toBe(view.root.querySelector('.disc-back'));
      expect(scroller.scrollTop).toBe(0);
      expect(text(el(view.root, '.disc-app-title'))).toBe('App 5');
      expect(el(view.root, '.disc-app-title').getAttribute('dir')).toBe('auto');
      await click(view.root, 'Discover');
      expect(scroller.scrollTop).toBe(240);
      expect(document.activeElement).toBe(view.root.querySelector('[data-key="app-5"] .disc-tile-open'));
    } finally { view.close(); scroller.remove(); }
  });

  it('install success: the installed panel, Open sends apps/open, peerd:app-installed fires once', async () => {
    const app = card('a', 'Expense splitter', ANA, { description: 'Split shared costs.' });
    const host = fakeHost({ heard: [app] }, {
      'dweb/base/install': () => ({ ok: true, app: { id: 'local-a' } }),
      'apps/open': () => ({ ok: true }),
    });
    /** @type {unknown[]} */ const events = [];
    /** @param {Event} event */
    const listen = (event) => { events.push(/** @type {CustomEvent} */ (event).detail); };
    window.addEventListener('peerd:app-installed', listen);
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, 'a');
      expect([...panel(view.root).querySelectorAll('.disc-step')].map(step => step.className.split(' ').at(-1))).toEqual(['is-current', 'is-pending', 'is-pending']);
      expect(text(view.root)).toContain('Before you install');
      expect(text(view.root)).toContain('Runs on its own, with no direct network access.');
      expect(host.writes().length).toBe(0);
      await press(view.root, 'Install and share');
      expect(host.writes()).toEqual([{
        type: 'dweb/base/install', uri: app.uri, name: app.name, dwappId: 'a', slug: 'a', seq: 1, publisher: ANA,
      }]);
      expect(text(panel(view.root))).toContain('In your Library. Peers can get this version from you while your peer network is on.');
      expect(events).toEqual([{ appId: 'local-a' }]);
      const open = button(panel(view.root), 'Open');
      expect(document.activeElement).toBe(open);
      await click(view.root, 'Open');
      expect(host.writes().at(-1)).toEqual({ type: 'apps/open', appId: 'local-a' });
      expect(events.length).toBe(1);
      expect(host.count('dweb/base/install')).toBe(1);
    } finally { window.removeEventListener('peerd:app-installed', listen); view.close(); }
  });

  it('a settled install takes focus only from the removed button, never from a control the user moved to', async () => {
    const first = deferred();
    const second = deferred();
    const host = fakeHost({ heard: [card('a', 'App A', ANA), card('b', 'App B', BOB)] }, {
      'dweb/base/install': (message) => message.dwappId === 'a' ? first.promise : second.promise,
      'apps/open': () => ({ ok: true }),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, 'a');
      await press(view.root, 'Install and share');
      const toggle = el(view.root, '.disc-tech-toggle');
      toggle.focus();
      first.resolve({ ok: true, app: { id: 'local-a' } }); await settle();
      expect(text(panel(view.root))).toContain('In your Library.');
      expect(document.activeElement).toBe(toggle);

      await click(view.root, 'Discover');
      await openTile(view.root, 'b');
      await press(view.root, 'Install and share');
      expect(document.activeElement).toBe(document.body);
      second.resolve({ ok: true, app: { id: 'local-b' } }); await settle();
      expect(document.activeElement).toBe(button(panel(view.root), 'Open'));
      expect(host.count('apps/open')).toBe(0);
    } finally { first.resolve({ ok: false }); second.resolve({ ok: false }); view.close(); }
  });

  it('a known failure says Try again and resends exactly once; runtime codes keep the host message', async () => {
    /** @type {unknown[]} */ const replies = [
      { ok: false, error: 'raw host install text' },
      { ok: false, code: 'app-runtime-unsupported', error: 'Unsupported App runtime target: wasi.' },
    ];
    const host = fakeHost({ heard: [card('a', 'App', ANA)] }, { 'dweb/base/install': () => replies.shift() });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, 'a');
      await click(view.root, 'Install and share');
      expect(text(el(view.root, '.disc-panel [role="alert"]'))).toBe('peerd could not install this app. Try again.');
      expect(panel(view.root).querySelector('.disc-step.is-failed')).toBeTruthy();
      expect(text(view.root).includes('raw host install text')).toBe(false);
      expect(button(view.root, 'Install and share')).toBe(undefined);
      await click(view.root, 'Try again');
      expect(host.count('dweb/base/install')).toBe(2);
      expect(text(el(view.root, '.disc-panel [role="alert"]'))).toBe('Unsupported App runtime target: wasi.');
    } finally { view.close(); }
  });

  for (const [label, reply] of /** @type {const} */ ([['an unknown reply', 'unknown'], ['a thrown send', 'throw']])) {
    it(`unknown install (${label}): neutral panel, no replay, Refresh clears only on the exact identity`, async () => {
      const app = card('a', 'App', ANA, { version_id: 'a-v3', seq: 3 });
      const host = fakeHost({ heard: [app] }, {
        'dweb/base/install': () => {
          if (reply === 'throw') throw new Error('raw renderer transport text');
          return { ok: false, error: 'raw renderer transport text', outcomeKnown: false, outcomeKind: 'unknown', retryable: false };
        },
        'apps/open': () => ({ ok: true }),
      });
      const view = mount({ send: host.send });
      try {
        await settle();
        await openTile(view.root, 'a');
        await click(view.root, 'Install and share');
        expect(text(el(view.root, '.disc-panel [role="status"]'))).toBe(UNKNOWN_INSTALL);
        expect(panel(view.root).querySelector('[role="alert"]')).toBe(null);
        expect(panel(view.root).querySelector('.disc-step.is-unknown')).toBeTruthy();
        expect(text(view.root).includes('raw renderer transport text')).toBe(false);
        expect(button(view.root, 'Install and share')).toBe(undefined);
        expect(button(view.root, 'Try again')).toBe(undefined);
        await click(view.root, 'Refresh');
        expect(text(panel(view.root))).toContain(UNKNOWN_INSTALL);
        for (const drift of [{ version_id: 'a-v2', seq: 2 }, { version_id: 'a-other', seq: 3 }]) {
          host.state.library = [local('local-other', app, drift)];
          await click(view.root, 'Refresh');
          expect(text(panel(view.root))).toContain(UNKNOWN_INSTALL);
        }
        expect(host.count('dweb/base/install')).toBe(1);
        host.state.library = [local('local-a', app)];
        await click(view.root, 'Refresh');
        expect(text(panel(view.root))).toContain('In your Library.');
        await click(view.root, 'Open');
        expect(host.writes().at(-1)).toEqual({ type: 'apps/open', appId: 'local-a' });
        expect(host.count('dweb/base/install')).toBe(1);
      } finally { view.close(); }
    });
  }

  it('an unknown update stays fenced until the exact version lands', async () => {
    const announced = card('upd', 'Trip planner', BOB, { version_id: 'upd-v2', seq: 2 });
    let version = 'upd-v1';
    let seq = 1;
    const host = fakeHost({ heard: [announced] }, {
      'dweb/base/update-app': () => ({ ok: false, outcomeKnown: false, outcomeKind: 'unknown', retryable: false }),
    });
    const refreshLibrary = () => { host.state.library = [local('local-upd', announced, { version_id: version, seq })]; };
    refreshLibrary();
    const view = mount({ send: host.send });
    try {
      await settle();
      el(view.root, '[data-key="upd"] .disc-tile-action').click(); await settle();
      expect(document.activeElement).toBe(view.root.querySelector('.disc-back'));
      expect(host.writes().map(call => [call.type, call.appId])).toEqual([['dweb/base/update-app', 'local-upd']]);
      expect(text(el(view.root, '.disc-panel [role="status"]'))).toBe('peerd could not confirm whether the update finished. Refresh to check before trying again.');
      for (const drift of [{ version: 'upd-v1', seq: 1 }, { version: 'upd-other', seq: 2 }]) {
        version = drift.version; seq = drift.seq; refreshLibrary();
        await click(view.root, 'Refresh');
        expect(text(panel(view.root))).toContain('could not confirm whether the update finished');
      }
      await click(view.root, 'Discover');
      expect(tileAction(view.root, 'upd')).toBe('Review');
      await openTile(view.root, 'upd');
      version = 'upd-v2'; seq = 2; refreshLibrary();
      await click(view.root, 'Refresh');
      expect(text(panel(view.root))).toContain('In your Library.');
      expect(button(view.root, 'Update')).toBe(undefined);
      expect(host.count('dweb/base/update-app')).toBe(1);
    } finally { view.close(); }
  });

  it('leaving and remounting with the same effects keeps the install fence', async () => {
    const install = deferred();
    const host = fakeHost({ heard: [card('a', 'App', ANA)] }, { 'dweb/base/install': () => install.promise });
    const effects = createEffects();
    let view = mount({ send: host.send, effects });
    try {
      await settle();
      await openTile(view.root, 'a');
      await click(view.root, 'Install and share');
      view.close();
      view = mount({ send: host.send, effects });
      await settle();
      expect(tileAction(view.root, 'a')).toBe('Installing…');
      await openTile(view.root, 'a');
      expect(text(el(view.root, '.disc-panel [role="status"]'))).toBe('You can leave this page. The install keeps going.');
      expect(panel(view.root).querySelector('button')).toBe(null);
      install.resolve({ ok: false, outcomeKnown: false }); await settle();
      expect(text(panel(view.root))).toContain(UNKNOWN_INSTALL);
      expect(button(view.root, 'Install and share')).toBe(undefined);
      expect(host.count('dweb/base/install')).toBe(1);
    } finally { install.resolve({ ok: false }); view.close(); }
  });

  it('an unknown install or update keeps its explanation after a remount', async () => {
    const announced = card('upd', 'Updater', BOB, { version_id: 'upd-v2', seq: 2 });
    const host = fakeHost({ heard: [card('a', 'App', ANA), announced], library: [local('local-upd', announced, { version_id: 'upd-v1', seq: 1 })] }, {
      'dweb/base/install': () => ({ ok: false, outcomeKnown: false }),
      'dweb/base/update-app': () => { throw new Error('renderer deadline'); },
    });
    const effects = createEffects();
    let view = mount({ send: host.send, effects });
    try {
      await settle();
      await openTile(view.root, 'a');
      await click(view.root, 'Install and share');
      await click(view.root, 'Discover');
      el(view.root, '[data-key="upd"] .disc-tile-action').click(); await settle();
      view.close();
      view = mount({ send: host.send, effects });
      await settle();
      await openTile(view.root, 'a');
      expect(text(el(view.root, '.disc-panel [role="status"]'))).toBe(UNKNOWN_INSTALL);
      expect(button(view.root, 'Install and share')).toBe(undefined);
      await click(view.root, 'Discover');
      await openTile(view.root, 'upd');
      expect(text(el(view.root, '.disc-panel [role="status"]')))
        .toBe('peerd could not confirm whether the update finished. Refresh to check before trying again.');
      expect(host.count('dweb/base/install')).toBe(1);
      expect(host.count('dweb/base/update-app')).toBe(1);
    } finally { view.close(); }
  });

  it('without an effects attr, as home.js mounts it, the install fence survives a remount', async () => {
    const install = deferred();
    // A unique id: this case shares the module-scope custody with the page.
    const id = 'shared-effects-probe';
    const host = fakeHost({ heard: [card(id, 'Shared effects probe', ANA)] }, { 'dweb/base/install': () => install.promise });
    let view = mount({ send: host.send, effects: undefined });
    try {
      await settle();
      await openTile(view.root, id);
      await click(view.root, 'Install and share');
      view.close();
      view = mount({ send: host.send, effects: undefined });
      await settle();
      expect(tileAction(view.root, id)).toBe('Installing…');
      await openTile(view.root, id);
      expect(button(view.root, 'Install and share')).toBe(undefined);
      expect(host.count('dweb/base/install')).toBe(1);
    } finally { install.resolve({ ok: false }); await settle(); view.close(); }
  });

  it('a remount lets the Library decide settled outcomes: a deleted app offers Install, one updated there is current', async () => {
    const app = card('a', 'App A', ANA);
    const announced = card('upd', 'Updater', BOB, { version_id: 'upd-v2', seq: 2 });
    const host = fakeHost({ heard: [app, announced], library: [local('local-upd', announced, { version_id: 'upd-v1', seq: 1 })] }, {
      'dweb/base/install': () => {
        host.state.library = [...host.state.library, local('local-a', app)];
        return { ok: true, app: { id: 'local-a' } };
      },
      'dweb/base/update-app': () => ({ ok: false, error: 'raw host update text' }),
    });
    const effects = createEffects();
    let view = mount({ send: host.send, effects });
    try {
      await settle();
      await openTile(view.root, 'a');
      await click(view.root, 'Install and share');
      expect(text(panel(view.root))).toContain('In your Library.');
      await click(view.root, 'Discover');
      el(view.root, '[data-key="upd"] .disc-tile-action').click(); await settle();
      expect(text(panel(view.root))).toContain('peerd could not update this app. Try again.');
      view.close();
      // Meanwhile, in the Library: App A was deleted and Updater was updated.
      host.state.library = [local('local-upd', announced)];
      view = mount({ send: host.send, effects });
      await settle();
      expect(tileAction(view.root, 'a')).toBe('Review');
      expect(tileAction(view.root, 'upd')).toBe('Open');
      await openTile(view.root, 'a');
      expect(button(view.root, 'Install and share')?.disabled).toBe(false);
      await click(view.root, 'Discover');
      await openTile(view.root, 'upd');
      expect(text(panel(view.root))).toContain('In your Library.');
      expect(button(view.root, 'Try again')).toBe(undefined);
      expect(host.count('dweb/base/install')).toBe(1);
      expect(host.count('dweb/base/update-app')).toBe(1);
    } finally { view.close(); }
  });

  it('update conflict: panel and chip; fork and replace resend strategy and token; Cancel returns to the root', async () => {
    const announced = card('trip', 'Trip planner', BOB, { version_id: 'trip-v2', seq: 2 });
    /** @type {unknown[]} */ const replies = [
      { ok: false, error: 'local-changes', conflictToken: 7 },
      { ok: false, error: 'local-changes', conflictToken: 8 },
      { ok: true },
    ];
    const host = fakeHost({ heard: [announced], library: [local('local-trip', announced, { version_id: 'trip-v1', seq: 1 })] }, {
      'dweb/base/update-app': () => replies.shift(),
    });
    const view = mount({ send: host.send });
    const updates = () => host.calls.filter(call => call.type === 'dweb/base/update-app');
    try {
      await settle();
      el(view.root, '[data-key="trip"] .disc-tile-action').click(); await settle();
      expect(text(panel(view.root))).toContain('Update ready');
      expect(text(panel(view.root))).toContain('You changed this app locally.');
      expect(text(el(view.root, '.disc-chip--strong'))).toBe('Locally modified');
      expect(view.root.querySelector('ol.disc-steps')).toBe(null);
      expect(text(view.root).includes('Before you install')).toBe(false);
      await click(view.root, 'Cancel');
      expect(view.root.querySelector('.disc-back')).toBe(null);
      expect(document.activeElement).toBe(view.root.querySelector('[data-key="trip"] .disc-tile-open'));
      expect(updates().length).toBe(1);
      expect(tileAction(view.root, 'trip')).toBe('Update');
      el(view.root, '[data-key="trip"] .disc-tile-action').click(); await settle();
      await click(view.root, 'Replace local copy');
      expect(updates()[2]).toEqual({
        type: 'dweb/base/update-app', appId: 'local-trip', uri: announced.uri, name: announced.name, dwappId: 'trip',
        slug: 'trip', seq: 2, publisher: BOB, strategy: 'replace', conflictToken: 8,
      });
      expect(text(panel(view.root))).toContain('In your Library.');
      expect(view.root.querySelector('.disc-chip--strong')).toBe(null);
      expect(updates().length).toBe(3);
    } finally { view.close(); }

    const fork = fakeHost({ heard: [announced], library: [local('local-trip', announced, { version_id: 'trip-v1', seq: 1 })] }, {
      'dweb/base/update-app': (message) => message.strategy
        ? { ok: true, fork: { name: 'Trip planner (my copy)' } } : { ok: false, error: 'local-changes', conflictToken: 7 },
    });
    const second = mount({ send: fork.send });
    try {
      await settle();
      el(second.root, '[data-key="trip"] .disc-tile-action').click(); await settle();
      await click(second.root, 'Keep a fork & update');
      expect(fork.writes().map(call => [call.strategy, call.conflictToken])).toEqual([[undefined, undefined], ['fork', 7]]);
      expect(text(el(second.root, '.disc-panel [role="status"]'))).toBe('Kept your local work as “Trip planner (my copy)” and updated this app.');
    } finally { second.close(); }
  });

  it('a conflict token holds only for its version, and only while the Library is older', async () => {
    const announced = card('trip', 'Trip planner', BOB, { version_id: 'trip-v2', seq: 2 });
    const newer = card('trip', 'Trip planner', BOB, { version_id: 'trip-v3', seq: 3 });
    const host = fakeHost({ heard: [announced], library: [local('local-trip', announced, { version_id: 'trip-v1', seq: 1 })] }, {
      'dweb/base/update-app': () => ({ ok: false, error: 'local-changes', conflictToken: 7 }),
    });
    const view = mount({ send: host.send });
    const updates = () => host.calls.filter(call => call.type === 'dweb/base/update-app');
    try {
      await settle();
      el(view.root, '[data-key="trip"] .disc-tile-action').click(); await settle();
      expect(text(el(view.root, '.disc-chip--strong'))).toBe('Locally modified');
      // Peers announce a newer version: the token answered the older offer.
      host.state.heard = [newer];
      await focusPoll();
      expect(view.root.querySelector('.disc-chip--strong')).toBe(null);
      expect(button(view.root, 'Replace local copy')).toBe(undefined);
      await click(view.root, 'Update');
      expect(updates().map(call => [call.seq, call.conflictToken])).toEqual([[2, undefined], [3, undefined]]);
      expect(text(el(view.root, '.disc-chip--strong'))).toBe('Locally modified');
      // The update is resolved in the Library: the offer and its token are gone.
      host.state.library = [local('local-trip', newer)];
      await focusPoll();
      expect(view.root.querySelector('.disc-chip--strong')).toBe(null);
      expect(button(view.root, 'Replace local copy')).toBe(undefined);
      expect(text(panel(view.root))).toContain('In your Library.');
      expect(button(view.root, 'Update')).toBe(undefined);
      expect(updates().length).toBe(2);
    } finally { view.close(); }
  });

  it('shows committed install and update warnings in the panel status line', async () => {
    const fresh = card('fresh', 'Fresh app', BOB);
    const announced = card('upd', 'Updater', BOB, { version_id: 'upd-v2', seq: 2 });
    const host = fakeHost({ heard: [fresh, announced], library: [local('local-upd', announced, { version_id: 'upd-v1', seq: 1 })] }, {
      'dweb/base/install': () => ({ ok: true, appId: 'local-fresh', warning: 'audit-write-failed' }),
      'dweb/base/update-app': () => ({ ok: true, warning: 'audit-write-failed', warnings: ['audit-write-failed', 'previous-version-cleanup-pending'] }),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, 'fresh');
      await click(view.root, 'Install and share');
      expect(text(el(view.root, '.disc-panel [role="status"]'))).toBe('Installed, but the security audit entry could not be written.');
      await click(view.root, 'Discover');
      await click(view.root, 'From contacts');
      expect(tileKeys(view.root)).toEqual(['fresh']);
      await click(view.root, 'All');
      el(view.root, '[data-key="upd"] .disc-tile-action').click(); await settle();
      const status = text(el(view.root, '.disc-panel [role="status"]'));
      expect(status).toContain('Updated, but the security audit entry could not be written.');
      expect(status).toContain('Older shared bytes will be cleaned up on the next update or delete.');
    } finally { view.close(); }
  });

  it('until the Library is read, the root says so and Install stays off', async () => {
    const app = card('a', 'App', ANA);
    const host = fakeHost({ heard: [app], library: [local('local-a', app)], libraryFails: true }, {
      'dweb/base/install': () => ({ ok: true, app: { id: 'local-a2' } }),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(text(/** @type {Element} */ (libraryLine(view.root)))).toBe('Could not read your Library. Install stays off until peerd can read it.');
      await openTile(view.root, 'a');
      const install = /** @type {HTMLButtonElement} */ (button(view.root, 'Install and share'));
      expect(install.disabled).toBe(true);
      expect(text(panel(view.root))).toContain('Could not read your Library.');
      install.disabled = false;
      install.click(); await settle();
      expect(host.count('dweb/base/install')).toBe(0);
      host.state.libraryFails = false;
      await focusPoll();
      expect(button(view.root, 'Install and share')).toBe(undefined);
      expect(text(panel(view.root))).toContain('In your Library.');
      await click(view.root, 'Discover');
      expect(tileAction(view.root, 'a')).toBe('Open');
      expect(libraryLine(view.root)).toBe(null);
    } finally { view.close(); }
  });

  it('can not run: no install button, and the Runtime fact carries the message', async () => {
    const host = fakeHost({ heard: [card('wasi', 'WASI app', CARL, {
      runtimeCompatibility: { status: 'unsupported', message: 'Unsupported App runtime target: wasi.' },
    })] });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, 'wasi');
      expect(text(panel(view.root))).toContain('This app can’t run in this browser.');
      expect(button(view.root, 'Install and share')).toBe(undefined);
      expect(view.root.querySelector('ol.disc-steps')).toBe(null);
      expect(text(view.root).includes('Before you install')).toBe(false);
      expect(text(view.root)).toContain('No description from the maker.');
      await click(view.root, 'Technical details');
      expect(facts(view.root).find(([label]) => label === 'Runtime')?.[1]).toBe('Unsupported App runtime target: wasi.');
      expect(host.writes().length).toBe(0);
    } finally { view.close(); }
  });
});

describe('home.discover technical details', () => {
  const hash = 'a'.repeat(64);
  const app = card('copy', 'Copy app', ANA, { version_id: hash, uri: `peerd://${ANA}/${hash}`, size: 48213, includes_wasm: false });
  /**
   * @param {unknown} clipboard
   * @param {(view: ReturnType<typeof mount>, host: ReturnType<typeof fakeHost>) => Promise<void>} run
   * @param {DwebApp} [shown]
   */
  const withClipboard = async (clipboard, run, shown = app) => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    const host = fakeHost({ heard: [shown] });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, shown.dwapp_id ?? '');
      await run(view, host);
    } finally {
      view.close();
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  };
  /** @param {ParentNode} root @param {string} label */
  const copyFor = (root, label) => {
    const dt = [...root.querySelectorAll('dl.disc-facts dt')].find(node => text(node) === label);
    return /** @type {HTMLButtonElement} */ (dt?.nextElementSibling?.querySelector('button'));
  };

  it('toggles with aria-expanded, lists the facts, and Copy writes the full did and the share link', async () => {
    /** @type {string[]} */ const writes = [];
    await withClipboard({ writeText: async (/** @type {string} */ value) => { writes.push(value); } }, async (view, host) => {
      const toggle = el(view.root, 'button.disc-tech-toggle');
      const list = el(view.root, 'dl.disc-facts');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-controls')).toBe(list.id);
      expect(list.hidden).toBe(true);
      toggle.click(); await settle();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(list.hidden).toBe(false);
      expect(facts(view.root)).toEqual([
        ['Made by', `${ANA}Copy`],
        ['Version', hash],
        ['Share link', `${discoveryAddress(app)}Copy`],
        ['Size', `${new Intl.NumberFormat().format(48213)} bytes`],
        ['WebAssembly', 'No detected WebAssembly files'],
        ['Runtime', 'Runtime requirements not specified.'],
      ]);
      expect(text(view.root)).toContain(WASM_HINT);
      copyFor(view.root, 'Made by').click(); await settle();
      expect(text(copyFor(view.root, 'Made by'))).toBe('Copied');
      copyFor(view.root, 'Share link').click(); await settle();
      expect(text(copyFor(view.root, 'Share link'))).toBe('Copied');
      expect(text(copyFor(view.root, 'Made by'))).toBe('Copy');
      expect(writes).toEqual([ANA, discoveryAddress(app)]);
      expect(host.writes().length).toBe(0);
    });
  });

  it('hides the Share link row when the coordinates disagree', async () => {
    await withClipboard({ writeText: async () => {} }, async (view) => {
      await click(view.root, 'Technical details');
      expect(facts(view.root).map(([label]) => label)).toEqual(['Made by', 'Version', 'WebAssembly', 'Runtime']);
    }, card('drift', 'Drift app', ANA, { version_id: hash, uri: 'peerd://other/hash' }));
  });

  for (const clipboard of [undefined, { writeText: async () => { throw new Error('permission denied raw error'); } }]) {
    it('reports unavailable or rejected clipboard access without claiming success', async () => {
      await withClipboard(clipboard, async (view) => {
        await click(view.root, 'Technical details');
        copyFor(view.root, 'Share link').click(); await settle();
        expect(text(el(view.root, '.disc-section [role="status"]'))).toBe('Could not copy.');
        expect(text(view.root).includes('Copied')).toBe(false);
        expect(text(view.root).includes('permission denied raw error')).toBe(false);
        expect(copyFor(view.root, 'Share link').disabled).toBe(false);
      });
    });
  }

  it('never labels a refreshed version as copied when an older write completes', async () => {
    const release = deferred();
    /** @type {string[]} */ const writes = [];
    const clipboard = { writeText: async (/** @type {string} */ value) => { writes.push(value); await release.promise; } };
    await withClipboard(clipboard, async (view, host) => {
      try {
        await click(view.root, 'Technical details');
        copyFor(view.root, 'Share link').click(); await settle();
        expect(copyFor(view.root, 'Made by').disabled).toBe(true);
        const next = 'b'.repeat(64);
        const newer = { ...app, seq: 2, version_id: next, uri: `peerd://${ANA}/${next}` };
        host.state.heard = [newer];
        window.dispatchEvent(new Event('focus'));
        await settle();
        expect(facts(view.root).find(([label]) => label === 'Version')?.[1]).toBe(next);
        release.resolve(undefined); await settle();
        expect(text(copyFor(view.root, 'Share link'))).toBe('Copy');
        copyFor(view.root, 'Share link').click(); await settle();
        expect(writes).toEqual([discoveryAddress(app), discoveryAddress(newer)]);
      } finally { release.resolve(undefined); }
    });
  });
});

describe('home.discover suggestions', () => {
  it('Surprise me waits for the Library, opens an app page, and sends only reads', async () => {
    const library = deferred();
    let gate = true;
    const host = fakeHost({
      heard: [
        card('installed', 'Installed', CARL),
        card('bad', 'Unsupported', CARL, { runtimeCompatibility: { status: 'unsupported', message: 'Not supported' } }),
        card('first', 'First', ANA),
        card('second', 'Second', BOB),
      ],
      library: [local('local-installed', card('installed', 'Installed', CARL))],
    }, { 'apps/list': () => gate ? library.promise : (host.state.libraryFails ? { ok: false } : { ok: true, apps: host.state.library }) });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(button(view.root, 'Surprise me')?.disabled).toBe(true);
      expect(text(/** @type {Element} */ (libraryLine(view.root)))).toBe('Checking your Library…');
      gate = false;
      library.resolve({ ok: true, apps: host.state.library }); await settle();
      expect(button(view.root, 'Surprise me')?.disabled).toBe(false);
      expect(libraryLine(view.root)).toBe(null);
      /** @type {string[]} */ const seen = [];
      for (let round = 0; round < 3; round++) {
        await click(view.root, 'Surprise me');
        expect(document.activeElement).toBe(view.root.querySelector('.disc-back'));
        seen.push(text(el(view.root, '.disc-app-title')));
        await click(view.root, 'Discover');
      }
      expect(seen.slice(0, 2).sort()).toEqual(['First', 'Second']);
      expect(['First', 'Second']).toContain(seen[2]);
      // Nothing to pick on the Included pill: the button stays on, as drawn, and opens nothing.
      await click(view.root, 'Included');
      expect(button(view.root, 'Surprise me')?.disabled).toBe(false);
      await click(view.root, 'Surprise me');
      expect(view.root.querySelector('.disc-back')).toBe(null);
      await click(view.root, 'All');
      host.state.libraryFails = true;
      el(view.root, 'button.disc-refresh').click(); await settle();
      expect(button(view.root, 'Surprise me')?.disabled).toBe(true);
      expect(text(/** @type {Element} */ (libraryLine(view.root))))
        .toBe('Could not refresh your Library. Surprise me stays off until peerd can read it.');
      expect(host.writes().length).toBe(0);
    } finally { library.resolve({ ok: false }); view.close(); }
  });
});

describe('home.discover share link', () => {
  const address = formatDwappUri({ did: ANA, hash: 'a'.repeat(64) });
  const target = immutableAppRoot(address);
  const summary = { ...target, name: 'Signed app', decodedBytes: 3, fileCount: 1, entryFile: 'index.html', containsWasm: false };
  const peerApp = card('peer', 'Peer app', BOB);

  it('rejects file paths, drops a late inspection, rejects a mismatched summary, and keeps inspect, install and open separate', async () => {
    const late = deferred();
    /** @type {unknown[]} */ const inspections = [late.promise, { ok: true, summary: { ...summary, publisher: BOB } }];
    const host = fakeHost({ heard: [peerApp] }, {
      'dweb/base/inspect-address': () => inspections.length ? inspections.shift() : { ok: true, summary },
      'dweb/base/install-address': () => {
        host.state.library = [{ id: 'app-test', dweb: { uri: target.uri, hash: target.hash, publisher: target.publisher } }];
        return { ok: true, app: { id: 'app-test' } };
      },
      'apps/open': () => ({ ok: true }),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await click(view.root, 'Paste link');
      expect(document.activeElement).toBe(view.root.querySelector('.disc-start-form input'));
      enterLink(view.root, `${address}/index.html`);
      await click(view.root, 'Check link');
      expect(text(el(view.root, '.disc-start-row [role="alert"]'))).toContain('File paths are not supported');
      expect(host.count('dweb/base/inspect-address')).toBe(0);

      enterLink(view.root, address);
      await click(view.root, 'Check link');
      enterLink(view.root, formatDwappUri({ did: ANA, hash: 'b'.repeat(64) }));
      late.resolve({ ok: true, summary }); await settle();
      expect(view.root.querySelector('.disc-back')).toBe(null);
      expect(host.count('dweb/base/inspect-address')).toBe(1);

      enterLink(view.root, address);
      await click(view.root, 'Check link');
      expect(text(el(view.root, '.disc-start-row [role="alert"]'))).toBe('Could not verify this app. Check the link and your peer network connection, then try again.');
      expect(view.root.querySelector('.disc-back')).toBe(null);

      await click(view.root, 'Check link');
      expect(document.activeElement).toBe(view.root.querySelector('.disc-back'));
      expect(text(el(view.root, '.disc-app-title'))).toBe('Signed app');
      expect(host.count('dweb/base/install-address')).toBe(0);
      await click(view.root, 'Technical details');
      const details = text(el(view.root, 'dl.disc-facts'));
      for (const part of [target.publisher, target.hash, '3 bytes']) expect(details).toContain(part);

      await click(view.root, 'Install and share');
      expect(host.count('dweb/base/install-address')).toBe(1);
      expect(sessionStorage.getItem(KEY)).toBe(null);
      expect(host.count('apps/open')).toBe(0);
      await click(view.root, 'Open');
      expect(host.writes().at(-1)).toEqual({ type: 'apps/open', appId: 'app-test' });

      await click(view.root, 'Discover');
      expect(view.root.querySelector('.disc-start-form')).toBe(null);
      await click(view.root, 'Paste link');
      enterLink(view.root, address);
      await click(view.root, 'Check link');
      expect(button(view.root, 'Install and share')).toBe(undefined);
      expect(button(panel(view.root), 'Open')?.disabled).toBe(false);
      expect(host.count('dweb/base/install-address')).toBe(1);
    } finally { late.resolve({ ok: false }); view.close(); sessionStorage.removeItem(KEY); }
  });

  for (const receipt of [null, { outcomeKnown: false }, { performed: true },
    { outcomeKind: 'effect-completed' }, { outcomeKind: 'host-lost' }, { outcomeKind: 'transport-lost' }]) {
    it(`an uncertain install (${JSON.stringify(receipt)}) survives a remount; only the exact receipt unlocks it`, async () => {
      /** @type {(string|null)[]} */ const keptBeforeSend = [];
      let exact = false;
      const host = fakeHost({ heard: [peerApp] }, {
        'dweb/base/inspect-address': () => ({ ok: true, summary }),
        'dweb/base/install-address': () => {
          keptBeforeSend.push(sessionStorage.getItem(KEY));
          if (receipt === null) throw new Error('renderer deadline');
          return { ok: false, ...receipt };
        },
        'apps/list': () => ({ ok: true, apps: [{ id: 'app-receipt', dweb: {
          uri: exact ? target.uri : 'other', hash: target.hash, publisher: target.publisher,
        } }] }),
        'apps/open': () => ({ ok: true }),
      });
      const effects = createEffects();
      let view = mount({ send: host.send, effects });
      try {
        await settle();
        await click(view.root, 'Paste link');
        enterLink(view.root, address);
        await click(view.root, 'Check link');
        await click(view.root, 'Install and share');
        expect(keptBeforeSend).toEqual([address]);
        expect(text(panel(view.root))).toContain(UNKNOWN_INSTALL);
        expect(button(view.root, 'Install and share')).toBe(undefined);
        view.close();
        view = mount({ send: host.send, effects }, { keepReceipt: true });
        await settle();
        expect(view.root.querySelector('.disc-back')).toBeTruthy();
        expect(text(el(view.root, '.disc-app-title'))).toBe('Unnamed app');
        expect(text(panel(view.root))).toContain(UNKNOWN_INSTALL);
        expect(button(view.root, 'Install and share')).toBe(undefined);
        await click(view.root, 'Refresh');
        expect(text(panel(view.root))).toContain('No completed install receipt yet.');
        expect(sessionStorage.getItem(KEY)).toBe(address);
        await click(view.root, 'Discover');
        expect(/** @type {HTMLInputElement} */ (el(view.root, '.disc-start-form input')).disabled).toBe(true);
        await click(view.root, 'Check link');
        exact = true;
        await click(view.root, 'Refresh');
        expect(sessionStorage.getItem(KEY)).toBe(null);
        expect(button(panel(view.root), 'Open')?.disabled).toBe(false);
        expect(host.count('dweb/base/install-address')).toBe(1);
      } finally { view.close(); sessionStorage.removeItem(KEY); }
    });
  }

  it('borrows a name and description only from the card its own publisher signed', async () => {
    const forged = card('forged', 'peerd Wallet (official)', BOB, {
      version_id: target.hash, uri: target.uri, description: 'Reviewed and approved by the peerd team.',
    });
    const signed = card('signed', 'Signed card name', ANA, { version_id: target.hash, description: 'From the maker.' });
    const host = fakeHost({ heard: [forged], contacts: [{ did: ANA, name: 'Ana', saved: true }] }, {
      'dweb/base/inspect-address': () => ({ ok: true, summary: { ...summary, name: null } }),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await click(view.root, 'Paste link');
      enterLink(view.root, address);
      await click(view.root, 'Check link');
      expect(text(el(view.root, '.disc-app-maker'))).toBe('Made by Ana');
      expect(text(el(view.root, '.disc-app-title'))).toBe('Unnamed app');
      expect(text(el(view.root, '.disc-app-desc'))).toBe('No description from the maker.');
      await click(view.root, 'Technical details');
      expect(text(view.root).includes(WASM_HINT)).toBe(false);
      host.state.heard = [forged, signed];
      await focusPoll();
      expect(text(el(view.root, '.disc-app-title'))).toBe('Signed card name');
      expect(text(el(view.root, '.disc-app-desc'))).toBe('From the maker.');
    } finally { view.close(); sessionStorage.removeItem(KEY); }
  });

  it('with the network off, a held receipt is explained in the share row and nothing is sent', async () => {
    sessionStorage.setItem(KEY, address);
    const host = fakeHost();
    const view = mount({ send: host.send, enabled: false }, { keepReceipt: true });
    try {
      await settle();
      expect(text(el(view.root, '.disc-start-row.is-open [role="status"]')))
        .toBe('peerd could not confirm whether the install finished. It may still finish, so another install stays blocked.');
      expect(/** @type {HTMLInputElement} */ (el(view.root, '.disc-start-form input')).disabled).toBe(true);
      expect(button(view.root, 'Check link')?.disabled).toBe(true);
      expect(text(view.root)).toContain('Join the peer network first.');
      expect(host.calls.length).toBe(0);
    } finally { view.close(); sessionStorage.removeItem(KEY); }
  });

  it('turning the network off while mounted stops every send and drops a late link check', async () => {
    const host = fakeHost({ heard: [peerApp] });
    const view = mount({ send: host.send });
    try {
      await settle();
      view.set({ enabled: false }); await settle();
      const before = host.calls.length;
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await settle();
      expect(host.calls.length).toBe(before);
      expect(view.root.querySelectorAll('li.disc-start-row').length).toBe(3);
    } finally { view.close(); }

    const inspect = deferred();
    const linkHost = fakeHost({}, { 'dweb/base/inspect-address': () => inspect.promise });
    const linkView = mount({ send: linkHost.send });
    try {
      await settle();
      await click(linkView.root, 'Paste link');
      enterLink(linkView.root, address);
      await click(linkView.root, 'Check link');
      linkView.set({ enabled: false });
      const reads = linkHost.calls.length;
      inspect.resolve({ ok: true, summary }); await settle();
      expect(linkView.root.querySelector('.disc-back')).toBe(null);
      expect(linkHost.calls.length).toBe(reads);
    } finally { inspect.resolve({ ok: false }); linkView.close(); }
  });
});

describe('home.discover makers', () => {
  const twin = `did:key:zTwin${CARL.slice(-8)}`;

  it('"Made by" shows only a saved contact name keyed by the full did', async () => {
    const host = fakeHost({
      heard: [card('a', 'Ana app', ANA), card('b', 'Bob app', BOB), card('c', 'Carl app', CARL)],
      contacts: [{ did: ANA, name: 'Ana', saved: true }, { did: BOB, name: 'Bob the Builder', saved: false }, { did: twin, name: 'Twin', saved: true }],
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(text(el(view.root, '[data-key="a"] .disc-tile-meta'))).toBe('Made by Ana');
      expect(text(el(view.root, '[data-key="b"] .disc-tile-meta'))).toBe(`Made by ${shortKey(BOB)}`);
      expect(text(el(view.root, '[data-key="c"] .disc-tile-meta'))).toBe(`Made by ${shortKey(CARL)}`);
      expect(text(view.root).includes('Bob the Builder')).toBe(false);
      expect(text(view.root).includes('Twin')).toBe(false);
      await openTile(view.root, 'b');
      expect(text(el(view.root, '.disc-app-maker'))).toBe(`Made by ${shortKey(BOB)}`);
      expect(el(view.root, '.disc-app-maker .type-code')).toBeTruthy();
    } finally { view.close(); }
  });

  it('the maker page lists apps by the full did and opens their pages', async () => {
    const anaTwin = `did:key:zAnaTwin${ANA.slice(-8)}`;
    const host = fakeHost({
      heard: [card('a1', 'Expense splitter', ANA), card('a2', 'Budget board', ANA), card('t', 'Twin app', anaTwin), card('c', 'Carl app', CARL)],
      contacts: [{ did: ANA, name: 'Ana', saved: true }],
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      const contactsBefore = host.count('contacts/list');
      await openTile(view.root, 'a1');
      await click(view.root, 'Made by Ana');
      expect(host.count('contacts/list')).toBe(contactsBefore + 1);
      expect(document.activeElement).toBe(view.root.querySelector('.disc-back'));
      expect(text(el(view.root, '.disc-person-head h2'))).toBe('Ana');
      expect(text(view.root)).toContain('Saved as a contact on this device');
      expect(text(view.root)).toContain('Apps from Ana');
      expect([...view.root.querySelectorAll('li.disc-app-row')].map(row => row.getAttribute('data-key')).sort()).toEqual(['a1', 'a2']);
      await click(view.root, 'Technical details');
      expect(facts(view.root)).toEqual([['Made by', `${ANA}Copy`]]);
      el(view.root, '[data-key="a2"] .disc-tile-action').click(); await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('Budget board');

      await click(view.root, 'Discover');
      await openTile(view.root, 'c');
      el(view.root, '.disc-app-maker').click(); await settle();
      expect(text(el(view.root, '.disc-person-head h2'))).toBe(shortKey(CARL));
      expect(text(view.root).includes('Saved as a contact')).toBe(false);
      expect(host.writes().length).toBe(0);
    } finally { view.close(); }
  });
});

describe('home.discover entry points', () => {
  it('openKey is answered once, by the first heard read that starts after it, unless the user moved on', async () => {
    const both = () => [card('a', 'App A', ANA), card('b', 'App B', BOB)];
    let cleared = 0;
    /**
     * @param {ReturnType<typeof fakeHost>} host @param {Partial<Attrs>} [extra]
     * @returns {ReturnType<typeof mount>}
     */
    const mountKeyed = (host, extra = {}) => {
      /** @type {ReturnType<typeof mount>|null} */ let view = null;
      view = mount({ send: host.send, onOpenKey: () => { cleared++; if (view) view.attrs.openKey = null; }, ...extra });
      return view;
    };

    const heard = fakeHost({ heard: both() });
    let view = mountKeyed(heard, { openKey: 'b' });
    try {
      await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('App B');
      expect(document.activeElement).toBe(view.root.querySelector('.disc-back'));
      expect(cleared).toBe(1);
      await click(view.root, 'Discover');
      expect(view.root.querySelector('.disc-back')).toBe(null);
      expect(cleared).toBe(1);
    } finally { view.close(); }

    // Not heard on the first read: the request is dropped, so a card heard
    // later never swaps out the page the user opened meanwhile.
    const late = fakeHost({ heard: [card('a', 'App A', ANA)] });
    view = mountKeyed(late, { openKey: 'b' });
    try {
      await settle();
      expect(view.root.querySelector('.disc-back')).toBe(null);
      expect(cleared).toBe(2);
      await openTile(view.root, 'a');
      late.state.heard = both();
      await focusPoll(); await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('App A');
      expect(cleared).toBe(2);
    } finally { view.close(); }

    // Already mounted: the bell can name a card heard after the last poll, so
    // the request starts its own read. A click is a new request, so it opens
    // from any page.
    const mounted = fakeHost({ heard: [card('a', 'App A', ANA)] });
    view = mountKeyed(mounted);
    try {
      await settle();
      await openTile(view.root, 'a');
      const reads = mounted.count('dweb/base/heard');
      mounted.state.heard = both();
      view.set({ openKey: 'b' }); await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('App B');
      expect(mounted.count('dweb/base/heard')).toBe(reads + 1);
      expect(cleared).toBe(3);
    } finally { view.close(); }

    // A read already in flight started before the request, so the next read answers it.
    const early = deferred();
    /** @type {unknown[]} */ const replies = [];
    let heardNow = [card('a', 'App A', ANA)];
    const racing = fakeHost({}, { 'dweb/base/heard': () => replies.length ? replies.shift() : { ok: true, apps: heardNow } });
    view = mountKeyed(racing);
    try {
      await settle();
      replies.push(early.promise);
      window.dispatchEvent(new Event('focus'));
      view.set({ openKey: 'b' });
      heardNow = both();
      early.resolve({ ok: true, apps: [card('a', 'App A', ANA)] }); await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('App B');
      expect(cleared).toBe(4);
    } finally { early.resolve({ ok: false }); view.close(); }

    // The user moves on before that read lands: their page stays.
    const held = deferred();
    let hold = false;
    const slow = fakeHost({}, { 'dweb/base/heard': () => hold ? held.promise : { ok: true, apps: both() } });
    view = mountKeyed(slow);
    try {
      await settle();
      hold = true;
      view.set({ openKey: 'b' }); await settle();
      await openTile(view.root, 'a');
      held.resolve({ ok: true, apps: both() }); await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('App A');
      expect(cleared).toBe(5);
    } finally { held.resolve({ ok: false }); view.close(); }

    const off = fakeHost({ heard: [card('a', 'App A', ANA)] });
    view = mountKeyed(off, { enabled: false, openKey: 'a' });
    try {
      await settle();
      expect(view.root.querySelector('.disc-back')).toBe(null);
      expect(off.calls.length).toBe(0);
      expect(cleared).toBe(5);
    } finally { view.close(); }
  });

  it('Commons: Add and open waits for the Library and stays fenced while unknown; Open sends apps/open', async () => {
    const library = deferred();
    let gate = true;
    const host = fakeHost({ heard: [card('a', 'App', ANA)] }, {
      'apps/list': () => gate ? library.promise : { ok: true, apps: [] },
      'dweb/open-commons': () => ({ ok: false }),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await click(view.root, 'Included');
      expect(button(view.root, 'Add and open Commons')?.disabled).toBe(true);
      gate = false;
      library.resolve({ ok: true, apps: [] }); await settle();
      expect(button(view.root, 'Add and open Commons')?.disabled).toBe(false);
      await click(view.root, 'Add and open Commons');
      await until(() => host.count('dweb/open-commons') === 1 && !!view.root.querySelector('[role="alert"]'));
      expect(text(el(view.root, '[role="alert"]'))).toBe('Could not confirm whether Commons was added or opened. Check your Library and tabs before trying again.');
      const add = button(view.root, 'Add and open Commons');
      expect(add?.disabled).toBe(true);
      add?.click(); await settle();
      expect(host.count('dweb/open-commons')).toBe(1);
    } finally { library.resolve({ ok: false }); view.close(); }

    const installed = fakeHost({ heard: [card('a', 'App', ANA)], library: [{ id: 'app-commons', dweb: { seed: 'commons' } }] }, {
      'apps/open': () => ({ ok: true }),
    });
    const second = mount({ send: installed.send });
    try {
      await settle();
      await click(second.root, 'Included');
      expect(button(second.root, 'Add and open Commons')).toBe(undefined);
      await click(second.root, 'Open');
      expect(installed.writes()).toEqual([{ type: 'apps/open', appId: 'app-commons' }]);
    } finally { second.close(); }
  });
});
