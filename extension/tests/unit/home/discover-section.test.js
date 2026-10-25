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
const UNKNOWN_INSTALL = 'peerd is not sure the install finished. It may still finish by itself.';
const RECEIPT_HELD = 'peerd is not sure the install finished. It may still finish by itself. Install stays off until peerd knows.';
const NO_SUGGESTION = 'No new suggestions match these filters. Change your search or filters.';
const ALL_IN_LIBRARY = 'No new suggestions. Every app here is already in your Library.';
const MAKER_EMPTY = 'This maker’s apps show up here when the people you are connected to share them.';
const OFFLINE_EMPTY = 'You can still open the apps in your Library. New apps need the peer network.';
const COMMONS_UNKNOWN = 'peerd is not sure Commons was added or opened. Check your Library and your tabs before you try again.';
const COMMONS_FAILED = 'peerd could not add or open Commons. Try again.';
const KEEPS_GOING = 'You can leave this page. The install keeps going.';
const OPEN_FAILED = 'peerd could not open this app. Try again.';
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
/**
 * A press on a control that then goes off. Chrome drops its focus (the focus
 * fixup rule); Gecko keeps it on the disabled control. Discover ships on
 * Chrome, so the test settles on its state.
 * @param {ParentNode} root @param {string} label
 */
const pressOff = async (root, label) => {
  await press(root, label);
  const active = document.activeElement;
  if (active instanceof HTMLButtonElement && active.disabled) active.blur();
};
/** @param {Node} root */
const text = (root) => root.textContent ?? '';
/** @param {ParentNode} root @param {string} key */
const tileOf = (root, key) => root.querySelector(`[data-key="${CSS.escape(key)}"]`);
/** @param {ParentNode} root @param {string} key */
const openTile = async (root, key) => { el(root, `[data-key="${CSS.escape(key)}"] .disc-tile-open`).click(); await settle(); };
/** Every action of a tile or row, in order. @param {ParentNode} root @param {string} key */
const tileAction = (root, key) => [...el(root, `[data-key="${CSS.escape(key)}"] .disc-actions, [data-key="${CSS.escape(key)}"] .disc-app-row-action`).children]
  .map(node => text(node).trim()).join(' | ');
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
/** A committed warning, not the installed line. @param {ParentNode} root */
const panelNotice = (root) => text(el(root, '.disc-panel .disc-footnote[role="status"]'));
/** @param {ParentNode} root */
const tileNames = (root) => [...root.querySelectorAll('.disc-tile')].map(node => text(el(node, '.disc-tile-name')));
const focusPoll = async () => { window.dispatchEvent(new Event('focus')); await settle(); };
/** @param {ParentNode} root @returns {HTMLElement|null} */
const commonsNote = (root) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll('p')]).find(node => text(node) === COMMONS_UNKNOWN) ?? null;
/** A stray Enter on whatever has focus. */
const strayEnter = async () => { /** @type {HTMLElement} */ (document.activeElement).click(); await settle(); };

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
    const host = fakeHost({ heard: [card('a', 'App', ANA)], library: [{ id: 'local-a', name: 'App' }] });
    const view = mount({ send: host.send, enabled: false });
    try {
      await settle();
      window.dispatchEvent(new Event('focus'));
      await settle();
      expect(el(view.root, 'h1').textContent).toBe('Discover');
      expect(view.root.querySelectorAll('li.disc-start-row').length).toBe(3);
      for (const line of ['Try an app that comes with peerd', 'See apps other people share', 'Open an app a friend sent you',
        `Add ${packagedStarter('csv-lab')?.name} to your Library, then open it from there. It needs no network and no setup.`,
        'Turn on the peer network to connect straight to other people who use peerd. There is no central store.',
        'It uses some internet and storage, and other people can see your network address. Your files, chats and keys stay private.',
        'Paste the link they shared. You can look at the app before you install it. This needs the peer network.']) {
        expect(text(view.root)).toContain(line);
      }
      expect(text(el(view.root, '.disc-note-box'))).toBe('Apps run in their own tab and cannot reach the internet by themselves. You can remove an app from your Library at any time.');
      expect(button(view.root, `Try ${packagedStarter('csv-lab')?.name}`)).toBeTruthy();
      const enable = el(view.root, '[data-network-choice="enable"]');
      expect([enable.textContent, enable.getAttribute('aria-label')]).toEqual(['Turn on', 'Turn on the peer network']);
      // With the network off Discover reads nothing, so it has no Library to list.
      expect(view.root.querySelector('.disc-yours')).toBe(null);
      expect(host.calls.length).toBe(0);
    } finally { view.close(); }
  });

  it('Turn on sends one settings write, stays disabled while saving, and shows a failure', async () => {
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
      expect(text(el(view.root, '[role="alert"]'))).toBe('peerd could not confirm that the peer network is on. Check again before you try again.');
      expect(enable.disabled).toBe(true);
      expect(reconciles).toBe(1);
      await click(view.root, 'Check again');
      expect(host.count('state/get')).toBe(1);
      expect(view.root.querySelector('[role="alert"]')).toBe(null);
      expect(enable.disabled).toBe(false);
      expect(reconciles).toBe(2);
      expect(host.count('settings/update')).toBe(1);
    } finally { save.resolve({ ok: false }); view.close(); }
  });

  it('network off: the start row names one app that comes with peerd, in plain words, and Try opens its page', async () => {
    const host = fakeHost();
    const view = mount({ send: host.send, enabled: false });
    try {
      await withTabs(async (opened) => {
        const row = el(view.root, '.disc-start-text');
        // Try opens a page that adds it, so the row never says it works right away.
        expect(text(row)).toBe(`Try an app that comes with peerdAdd ${packagedStarter('csv-lab')?.name} to your Library, then open it from there. It needs no network and no setup.`);
        expect(row.querySelector('button')).toBe(null);
        expect(text(view.root).includes(packagedStarter('wasm-image')?.name ?? '')).toBe(false);
        await click(view.root, `Try ${packagedStarter('csv-lab')?.name}`);
        expect(opened.map(url => url.slice(url.indexOf('#')))).toEqual(['#!/transfer?starter=csv-lab']);
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
      expect(text(view.root)).toContain('Turn on the peer network first.');
      button(view.root, 'Check link')?.click(); await settle();
      expect(host.calls.length).toBe(0);
    } finally { view.close(); }
  });
});

describe('home.discover root states', () => {
  it('a heard failure shows a bounded alert, never the raw error, an empty-network claim or a false looking line', async () => {
    const host = fakeHost({ heardFails: true });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(text(el(view.root, '[role="alert"]'))).toContain('could not check for new apps');
      expect(text(view.root).includes('raw offscreen host epoch')).toBe(false);
      expect(text(view.root).includes('No shared apps yet')).toBe(false);
      // Peers are linked: the status row says so and offers Refresh, with one Paste link.
      expect(text(el(view.root, '.disc-status-live'))).toBe('Connected to 3 people');
      expect(text(view.root).includes('Looking for people')).toBe(false);
      expect(view.root.querySelectorAll('[data-paste-link]').length).toBe(1);
      host.state.heardFails = false;
      host.state.heard = [card('a', 'App A', ANA)];
      el(view.root, 'button.disc-refresh').click(); await settle();
      expect(tileKeys(view.root)).toEqual(['a']);
      expect(view.root.querySelector('[role="alert"]')).toBe(null);
    } finally { view.close(); }
  });

  it('shows the connected, looking, empty and offline roots; Try again starts once', async () => {
    const two = [card('a', 'App A', ANA), card('b', 'App B', BOB)];
    const connected = fakeHost({ heard: two, linked: 1 });
    let view = mount({ send: connected.send });
    try {
      await settle();
      expect(text(el(view.root, '.disc-status-live'))).toBe('Connected to 1 person');
      expect(text(el(view.root, '.disc-status-count'))).toBe('2 apps shared');
      expect(view.root.querySelectorAll('.disc-tile').length).toBe(2);
      expect(button(view.root, 'Surprise me')).toBeTruthy();
      // The order is fixed for the visit: there is no Shuffle.
      expect(button(view.root, 'Shuffle')).toBe(undefined);
    } finally { view.close(); }

    const csv = `Try ${packagedStarter('csv-lab')?.name}`;
    /** @param {ParentNode} root */
    const boxActions = (root) => [...el(root, '.disc-empty').querySelectorAll('button')].map(node => text(node).trim());
    view = mount({ send: fakeHost({ lease: 'starting' }).send });
    try {
      await settle();
      // The waiting block says what is happening, with a spinner, and its text goes on from it.
      const waiting = el(view.root, '.disc-empty');
      const title = el(waiting, 'h2');
      expect([text(title), title.getAttribute('role')]).toEqual(['Looking for people who share apps…', 'status']);
      expect(waiting.querySelector('.peerd-spinner')?.getAttribute('aria-hidden')).toBe('true');
      expect(text(el(waiting, 'p'))).toBe('This can take a minute. While you wait, try an app that comes with peerd.');
      expect(text(el(view.root, 'h1'))).toBe('Discover');
      // One way to start, Paste link while no status row shows, and a way to the apps that come with peerd.
      expect(boxActions(view.root)).toEqual([csv, 'Paste link', 'See what comes with peerd']);
      expect(view.root.querySelector('input.disc-search')).toBe(null);
      expect(view.root.querySelector('.disc-pills')).toBe(null);
    } finally { view.close(); }

    let library = 0;
    view = mount({ send: fakeHost({ linked: 3 }).send, onLibrary: () => { library++; } });
    try {
      await settle();
      expect(text(el(view.root, '.disc-empty h2'))).toBe('No shared apps yet');
      expect(view.root.querySelector('.disc-pills')).toBe(null);
      expect(text(view.root)).toContain('Apps show up here when the people you are connected to share them. You can share one of yours from your Library.');
      expect(boxActions(view.root)).toEqual(['Go to Library', csv, 'See what comes with peerd']);
      expect(button(view.root, csv)?.classList.contains('linklike')).toBe(true);
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
      // No Library app from peers: one line under the pills, and no new button.
      const empty = el(view.root, '.disc-empty');
      expect(text(empty)).toBe(OFFLINE_EMPTY);
      expect(empty.classList.contains('disc-empty--boxed')).toBe(false);
      expect(empty.querySelector('button')).toBe(null);
      await click(view.root, 'Try again');
      expect(button(view.root, 'Connecting…')?.disabled).toBe(true);
      button(view.root, 'Connecting…')?.click(); await settle();
      expect(offline.count('dweb/base/start')).toBe(1);
      offline.state.running = true;
      start.resolve({ ok: true }); await settle();
      expect(text(el(view.root, '.disc-status-live'))).toBe('Connected to 3 people');
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
      // Offline, a tile says where the app is and offers no update.
      expect(text(el(view.root, '[data-key="kept"] .disc-tile-meta'))).toBe('In your Library');
      expect(text(view.root).includes('new version ready')).toBe(false);
      el(view.root, '[data-key="kept"] .disc-tile-action').click(); await settle();
      expect(host.writes()).toEqual([{ type: 'apps/open', appId: 'local-kept' }]);
    } finally { view.close(); }
  });

  it('offline, the line about Library apps waits for a good Library read', async () => {
    const first = deferred();
    /** @type {unknown[]} */ const replies = [first.promise, { ok: false }];
    const host = fakeHost({ running: false }, { 'apps/list': () => replies.length ? replies.shift() : { ok: true, apps: [] } });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(text(el(view.root, '.disc-status-live'))).toBe('Peer network is offline');
      expect(text(/** @type {Element} */ (libraryLine(view.root)))).toBe('Checking your Library…');
      expect(text(view.root).includes(OFFLINE_EMPTY)).toBe(false);
      first.resolve({ ok: false }); await settle();
      // The offline root offers no Install, so the line names what it shows.
      expect(text(/** @type {Element} */ (libraryLine(view.root))))
        .toBe('peerd could not read your Library. Try again in a moment.');
      expect(text(view.root).includes(OFFLINE_EMPTY)).toBe(false);
      await focusPoll();
      expect(text(view.root).includes(OFFLINE_EMPTY)).toBe(false);
      await focusPoll();
      expect(libraryLine(view.root)).toBe(null);
      expect(text(el(view.root, '.disc-empty'))).toBe(OFFLINE_EMPTY);
      // A failed refresh keeps the list and says it may be out of date; there is no Surprise me offline.
      replies.push({ ok: false });
      await focusPoll();
      expect(text(/** @type {Element} */ (libraryLine(view.root)))).toBe('Could not refresh your Library. This list may be out of date.');
      expect(text(el(view.root, '.disc-empty'))).toBe(OFFLINE_EMPTY);
      expect(host.writes().length).toBe(0);
    } finally { first.resolve({ ok: false }); view.close(); }
  });

  it('an offline blip keeps the order of the online grid', async () => {
    const d = card('d', 'D', didOf(4));
    const e = card('e', 'E', didOf(5));
    const host = fakeHost({
      heard: [card('a', 'A', ANA), card('b', 'B', BOB), card('c', 'C', CARL), d, e], library: [local('lib-d', d), local('lib-e', e)],
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      const before = tileKeys(view.root);
      host.state.running = false;
      await focusPoll();
      expect(tileKeys(view.root).sort()).toEqual(['d', 'e']);
      host.state.running = true;
      await focusPoll();
      expect(tileKeys(view.root)).toEqual(before);
    } finally { view.close(); }
  });

  it('offline, an app page shows the version in the Library and offers no update', async () => {
    const installed = card('a', 'App A', ANA);
    const host = fakeHost({ heard: [card('a', 'App A', ANA, { version_id: 'a-v2', seq: 2 })], library: [local('lib-a', installed)] }, {
      'apps/open': () => ({ ok: true }),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(tileAction(view.root, 'a')).toBe('Update | Open');
      // The heard read fails while the network is offline, so the newer card stays in memory.
      host.state.running = false;
      host.state.heardFails = true;
      await focusPoll();
      expect(tileAction(view.root, 'a')).toBe('Open');
      await openTile(view.root, 'a');
      expect(button(view.root, 'Update')).toBe(undefined);
      expect(text(panel(view.root))).toContain('In your Library.');
      await click(view.root, 'Technical details');
      expect(facts(view.root).find(([label]) => label === 'Version')?.[1]).toBe('a-v1');
      await click(view.root, 'Open');
      expect(host.writes()).toEqual([{ type: 'apps/open', appId: 'lib-a' }]);
    } finally { view.close(); }
  });

  it('a card that left the heard list before it reached the Library is not kept', async () => {
    const gone = card('gone', 'Gone app', BOB, { description: 'Only peers said this.' });
    const host = fakeHost({ heard: [gone] });
    const view = mount({ send: host.send });
    try {
      await settle();
      host.state.heard = [];
      await focusPoll();
      host.state.library = [local('local-gone', gone)];
      host.state.running = false;
      await focusPoll();
      expect(tileKeys(view.root)).toEqual(['gone']);
      // Nothing peers said is kept, so the tile says the maker gave none.
      expect(text(el(view.root, '[data-key="gone"] .disc-tile-desc.is-missing'))).toBe('No description from the maker.');
    } finally { view.close(); }
  });

  it('the offline grid keeps what peers said about a Library app after its card leaves the heard list', async () => {
    const kept = card('kept', 'Kept app', ANA, { description: 'Still described.' });
    const host = fakeHost({ heard: [kept, card('gone', 'Gone app', BOB)], library: [local('local-kept', kept)] });
    const view = mount({ send: host.send });
    try {
      await settle();
      host.state.heard = [];
      await focusPoll();
      host.state.running = false;
      await focusPoll();
      expect(tileKeys(view.root)).toEqual(['kept']);
      expect(text(el(view.root, '[data-key="kept"] .disc-tile-desc'))).toBe('Still described.');
    } finally { view.close(); }
  });

  it('a root change under the user keeps focus and typed text in the share row, the search and the status row', async () => {
    // Looking for people while typing a link, then someone shares an app.
    const looking = fakeHost({ lease: 'starting' });
    let view = mount({ send: looking.send });
    try {
      await settle();
      await press(view.root, 'Paste link');
      const input = /** @type {HTMLInputElement} */ (el(view.root, '.disc-start-form input'));
      expect(document.activeElement).toBe(input);
      // The share row sits under the head, above the waiting block, as on every root.
      expect(!!(input.compareDocumentPosition(el(view.root, '.disc-empty')) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
      enterLink(view.root, 'dwapp://content/partial');
      looking.state.lease = 'active';
      looking.state.heard = [card('a', 'App A', ANA)];
      await focusPoll();
      expect(tileKeys(view.root)).toEqual(['a']);
      expect(el(view.root, '.disc-start-form input')).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe('dwapp://content/partial');
      // Then the peer network goes offline: an open row stays where it was.
      looking.state.running = false;
      await focusPoll();
      expect(text(el(view.root, '.disc-status-live'))).toBe('Peer network is offline');
      expect(el(view.root, '.disc-start-form input')).toBe(input);
      expect(document.activeElement).toBe(input);
    } finally { view.close(); }

    // Typing a search, then the peer network goes offline.
    const app = card('a', 'App A', ANA);
    const offline = fakeHost({ heard: [app], library: [local('local-a', app)] });
    view = mount({ send: offline.send });
    try {
      await settle();
      const box = /** @type {HTMLInputElement} */ (el(view.root, 'input.disc-search'));
      box.focus();
      search(view.root, 'app');
      offline.state.running = false;
      await focusPoll();
      expect(text(el(view.root, '.disc-status-live'))).toBe('Peer network is offline');
      expect(el(view.root, 'input.disc-search')).toBe(box);
      expect(document.activeElement).toBe(box);
      expect(box.value).toBe('app');
    } finally { view.close(); }

    // On Refresh in the connected-empty root, then the first app is shared.
    const empty = fakeHost({ linked: 3 });
    view = mount({ send: empty.send });
    try {
      await settle();
      expect(text(view.root)).toContain('No shared apps yet');
      const status = el(view.root, '.disc-status');
      const refresh = el(view.root, 'button.disc-refresh');
      refresh.focus();
      empty.state.heard = [card('a', 'App A', ANA)];
      await focusPoll();
      expect(tileKeys(view.root)).toEqual(['a']);
      expect(el(view.root, '.disc-status')).toBe(status);
      expect(document.activeElement).toBe(refresh);
    } finally { view.close(); }

    // On the status-row Paste link, then the network goes offline: Try
    // again is a new node, so a stray key press never starts the network.
    const offlineLater = fakeHost({ heard: [card('a', 'App A', ANA)] }, { 'dweb/base/start': () => ({ ok: true }) });
    view = mount({ send: offlineLater.send });
    try {
      await settle();
      button(view.root, 'Paste link')?.focus();
      offlineLater.state.running = false;
      await focusPoll();
      expect(text(el(view.root, '.disc-status-live'))).toBe('Peer network is offline');
      expect(document.activeElement === button(view.root, 'Try again')).toBe(false);
      await strayEnter();
      expect(offlineLater.count('dweb/base/start')).toBe(0);
    } finally { view.close(); }
  });
});

describe('home.discover apps that come with peerd', () => {
  // The looking and empty roots draw no pills, so a link opens the list there.
  for (const [label, initial, root, opener, back] of /** @type {const} */ ([
    ['looking', { lease: 'starting' }, 'Looking for people who share apps…', 'See what comes with peerd', 'See what comes with peerd'],
    ['connected and empty', { linked: 3 }, 'No shared apps yet', 'See what comes with peerd', 'See what comes with peerd'],
    ['offline with no Library apps', { running: false }, 'Peer network is offline', 'Comes with peerd', 'All'],
  ])) {
    it(`the ${label} root reaches Comes with peerd: both starters and Commons, and focus follows the change`, async () => {
      const host = fakeHost(initial);
      const view = mount({ send: host.send });
      try {
        await settle();
        expect(text(view.root)).toContain(root);
        expect(!!view.root.querySelector('.disc-pills')).toBe(opener === 'Comes with peerd');
        await press(view.root, opener);
        expect(tileNames(view.root)).toEqual(['CSV Lab', 'WebAssembly Image Lab', 'Peerd-to-Peerd Commons']);
        expect(button(view.root, 'Add and open Commons')?.disabled).toBe(false);
        expect(document.activeElement).toBe(button(view.root, 'Comes with peerd'));
        await press(view.root, 'All');
        expect(view.root.querySelector('.disc-tile')).toBe(null);
        expect(text(view.root)).toContain(root);
        expect(document.activeElement).toBe(button(view.root, back));
        expect(host.writes().length).toBe(0);
      } finally { view.close(); }
    });
  }

  it('leaving Comes with peerd for a root with no pills lands focus on its heading', async () => {
    const host = fakeHost({ heard: [card('a', 'App A', ANA)] });
    const view = mount({ send: host.send });
    try {
      await settle();
      await press(view.root, 'Comes with peerd');
      // Peers stop sharing meanwhile; the pill keeps the apps that come with peerd on screen.
      host.state.heard = [];
      await focusPoll();
      expect(tileNames(view.root)).toEqual(['CSV Lab', 'WebAssembly Image Lab', 'Peerd-to-Peerd Commons']);
      search(view.root, 'kanban');
      await press(view.root, 'Clear filters');
      expect(text(el(view.root, '.disc-empty h2'))).toBe('No shared apps yet');
      expect(view.root.querySelector('.disc-pills')).toBe(null);
      expect(document.activeElement).toBe(el(view.root, 'h1'));
      expect(host.writes().length).toBe(0);
    } finally { view.close(); }
  });
});

describe('home.discover your apps', () => {
  /** @param {string} id @param {string} name @param {number} [createdAt] @param {Record<string, unknown>} [dweb] @returns {LibraryRow & {createdAt?:number}} */
  const row = (id, name, createdAt, dweb) => ({ id, name, ...(createdAt === undefined ? {} : { createdAt }), ...(dweb ? { dweb } : {}) });
  /** @param {ParentNode} root */
  const yours = (root) => [...root.querySelectorAll('.disc-yours-item')].map(item => item.getAttribute('data-app-id'));

  it('lists the Library apps above browsing, the most recently added first, each with Open; never as tiles', async () => {
    const peer = card('peer', 'Peer app', BOB);
    const host = fakeHost({
      heard: [peer],
      library: [row('older', 'Older app', 100), row('undated', 'Undated app'), row('newest', 'Newest app', 300), local('lib-peer', peer)],
    }, { 'apps/open': () => ({ ok: true }) });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(text(el(view.root, '.disc-yours h2'))).toBe('Your apps');
      // Dated records newest first; a record with no time keeps its Library place after them.
      expect(yours(view.root)).toEqual(['newest', 'older', 'undated', 'lib-peer']);
      expect([...view.root.querySelectorAll('.disc-yours-name')].map(node => text(node))).toEqual(['Newest app', 'Older app', 'Undated app', 'Peer app']);
      expect(el(view.root, '.disc-yours').querySelector('.disc-card, .disc-tile, [data-key]')).toBe(null);
      expect(tileKeys(view.root)).toEqual(['peer']);
      // It sits above the search and the tiles.
      expect(!!(el(view.root, '.disc-yours').compareDocumentPosition(el(view.root, 'input.disc-search')) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
      expect(button(el(view.root, '.disc-yours'), 'See all in Library')).toBe(undefined);
      el(view.root, '[data-app-id="undated"] button').click(); await settle();
      expect(host.writes()).toEqual([{ type: 'apps/open', appId: 'undated' }]);
      expect(view.root.querySelector('.disc-back')).toBe(null);
    } finally { view.close(); }
  });

  it('shows at most six, with a link to the rest of the Library', async () => {
    const library = Array.from({ length: 8 }, (_, i) => row(`app-${i}`, `App ${i}`, i));
    let opened = 0;
    const view = mount({ send: fakeHost({ library }).send, onLibrary: () => { opened++; } });
    try {
      await settle();
      expect(yours(view.root)).toEqual(['app-7', 'app-6', 'app-5', 'app-4', 'app-3', 'app-2']);
      await click(el(view.root, '.disc-yours'), 'See all in Library');
      expect(opened).toBe(1);
    } finally { view.close(); }
  });

  it('shows on the looking, empty and offline roots, and stays hidden while the Library holds nothing', async () => {
    const library = [row('mine', 'My app', 1)];
    for (const initial of [{ lease: 'starting' }, { linked: 3 }, { running: false }]) {
      const view = mount({ send: fakeHost({ ...initial, library }).send });
      try {
        await settle();
        expect(yours(view.root)).toEqual(['mine']);
      } finally { view.close(); }
    }
    const empty = mount({ send: fakeHost({ heard: [card('a', 'App A', ANA)] }).send });
    try {
      await settle();
      expect(empty.root.querySelector('.disc-yours')).toBe(null);
    } finally { empty.close(); }
  });

  it('offline with Library apps from peers, the grid lists each with Open, so Your apps does not list them twice', async () => {
    const peer = card('peer', 'Peer app', BOB);
    const view = mount({ send: fakeHost({ running: false, library: [local('lib-peer', peer), row('mine', 'My app', 1)] }).send });
    try {
      await settle();
      expect(text(el(view.root, '.disc-status-live'))).toBe('Peer network is offline');
      expect(tileKeys(view.root)).toEqual(['peer']);
      expect(tileAction(view.root, 'peer')).toBe('Open');
      expect(view.root.querySelector('.disc-yours')).toBe(null);
    } finally { view.close(); }
  });

  it('an Open that fails or may not have opened says so in its own row only', async () => {
    let outcome = 'failed';
    const host = fakeHost({ linked: 3, library: [row('mine', 'My app', 1)] }, {
      'apps/open': () => { if (outcome === 'lost') throw new Error('renderer deadline'); return { ok: false, outcomeKnown: true }; },
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(text(el(view.root, '.disc-empty h2'))).toBe('No shared apps yet');
      el(view.root, '[data-app-id="mine"] button').click(); await settle();
      expect(text(el(view.root, '[data-app-id="mine"] [role="alert"]'))).toBe(OPEN_FAILED);
      expect(view.root.querySelectorAll('[role="alert"]').length).toBe(1);
      outcome = 'lost';
      el(view.root, '[data-app-id="mine"] button').click(); await settle();
      const line = el(view.root, '[data-app-id="mine"] [role="status"]');
      expect([text(line), line.classList.contains('error')]).toEqual(['peerd is not sure the app opened. Check your tabs.', false]);
      expect(host.count('apps/open')).toBe(2);
    } finally { view.close(); }
  });
});

describe('home.discover tiles and filters', () => {
  it('tile ladder: can not run, then Update with Open, then Open, then Look at it; a tile with no button opens from the keyboard', async () => {
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
      library: [local('local-upd', old), local('local-open', card('open', 'Opener', ANA)), local('local-mine', mineOld)],
    }, { 'apps/open': () => ({ ok: true }) });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(tileAction(view.root, 'cant')).toBe('This browser cannot run it');
      expect(el(view.root, '[data-key="cant"] .disc-actions').querySelector('button')).toBe(null);
      // An installed app says where it is; the one with a newer version says so too.
      expect(tileAction(view.root, 'upd')).toBe('Update | Open');
      /** @param {string} key */
      const meta = (key) => text(el(view.root, `[data-key="${key}"] .disc-tile-meta`));
      expect(meta('upd')).toBe('In your Library · new version ready');
      expect(meta('open')).toBe('In your Library');
      expect(meta('rev')).toBe(`Made by ${shortKey(ANA)}`);
      expect(tileAction(view.root, 'open')).toBe('Open');
      expect(tileAction(view.root, 'rev')).toBe('Look at it');
      expect(tileAction(view.root, 'mine')).toBe('Open');
      expect(text(view.root).includes('Update ready')).toBe(false);

      el(view.root, '[data-key="open"] .disc-tile-action').click(); await settle();
      expect(host.writes()).toEqual([{ type: 'apps/open', appId: 'local-open' }]);
      expect(view.root.querySelector('.disc-back')).toBe(null);
      // Open next to Update runs the version the Library holds, and stays on the root.
      el(view.root, '[data-key="upd"] .disc-actions button.secondary').click(); await settle();
      expect(host.writes().at(-1)).toEqual({ type: 'apps/open', appId: 'local-upd' });
      expect(view.root.querySelector('.disc-back')).toBe(null);

      const name = el(view.root, '[data-key="cant"] .disc-tile-open');
      expect(name.tagName).toBe('BUTTON');
      name.focus();
      expect(document.activeElement).toBe(name);
      name.click(); await settle();
      expect(text(view.root)).toContain('This browser cannot run this app.');
      expect(host.writes().length).toBe(2);
    } finally { view.close(); }
  });

  it('a tile with no description says the maker gave none', async () => {
    const host = fakeHost({ heard: [card('bare', 'Bare app', ANA), card('said', 'Said app', BOB, { description: 'Says what it does.' })] });
    const view = mount({ send: host.send });
    try {
      await settle();
      const bare = el(view.root, '[data-key="bare"] .disc-tile-desc');
      expect([text(bare), bare.classList.contains('is-missing')]).toEqual(['No description from the maker.', true]);
      expect(text(el(view.root, '[data-key="said"] .disc-tile-desc'))).toBe('Says what it does.');
      expect(el(view.root, '[data-key="said"] .disc-tile-desc').classList.contains('is-missing')).toBe(false);
    } finally { view.close(); }
  });

  it('the search asks what the user wants to do, and a task finds an app by any of its words', async () => {
    const host = fakeHost({ heard: [
      card('split', 'Expense splitter', ANA, { description: 'Split shared costs and settle up with friends.' }),
      card('trip', 'Trip planner', BOB, { description: 'Plan routes, stops and packing lists.' }),
      card('chess', 'Chess clock', CARL, { description: 'A two-player clock.' }),
    ] });
    const view = mount({ send: host.send });
    try {
      await settle();
      const input = /** @type {HTMLInputElement} */ (el(view.root, 'input.disc-search'));
      const label = el(view.root, `label[for="${input.id}"]`);
      expect(text(label)).toBe('What do you want to do?');
      expect(input.getAttribute('aria-label')).toBe(null);
      expect(input.placeholder).toBe('For example, split a bill or plan a trip');
      // The search sits above the pills, as drawn.
      expect(!!(input.compareDocumentPosition(el(view.root, '.disc-pills')) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
      search(view.root, 'split a bill');
      expect(tileKeys(view.root)).toEqual(['split']);
      search(view.root, 'plan a trip');
      expect(tileKeys(view.root)).toEqual(['trip']);
      search(view.root, 'cl');
      expect(tileKeys(view.root)).toEqual(['chess']);
      expect(host.writes().length).toBe(0);
    } finally { view.close(); }
  });

  it('pills: All, From people you know (saved only), Updates, Comes with peerd, and Clear filters', async () => {
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
      expect([...view.root.querySelectorAll('.disc-pill')].map(node => text(node))).toEqual(['All', 'From people you know', 'Updates', 'Comes with peerd']);
      expect(pressed('All')).toBe('true');
      expect(tileKeys(view.root).length).toBe(4);
      await click(view.root, 'Updates');
      expect(pressed('Updates')).toBe('true');
      expect(pressed('All')).toBe('false');
      expect(tileKeys(view.root)).toEqual(['upd']);
      await click(view.root, 'From people you know');
      expect(tileKeys(view.root)).toEqual(['ana']);
      await click(view.root, 'Comes with peerd');
      const included = [...view.root.querySelectorAll('.disc-tile')];
      expect(included.map(node => text(el(node, '.disc-tile-name')))).toEqual(['CSV Lab', 'WebAssembly Image Lab', 'Peerd-to-Peerd Commons']);
      expect(included.every(node => text(node).includes('Comes with peerd'))).toBe(true);
      expect(included.slice(0, 2).map(node => text(el(node, '.disc-actions')))).toEqual(['Try it', 'Try it']);
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
      expect(tileAction(view.root, 'pending')).toBe('Look at it');
      expect(host.count('dweb/base/install')).toBe(1);
    } finally { install.resolve({ ok: false }); view.close(); }
  });

  it('a poll that changes a focused tile action drops the focus, so a stray key press runs nothing', async () => {
    const notes = card('notes', 'Notes', ANA);
    const orbit = card('orbit', 'Orbit', BOB);
    const host = fakeHost({ heard: [notes, orbit], library: [local('local-notes', notes)] }, {
      'apps/open': () => ({ ok: true }),
      'dweb/base/update-app': () => ({ ok: true }),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      // Open turns into Update when peers announce a newer version.
      el(view.root, '[data-key="notes"] .disc-tile-action').focus();
      host.state.heard = [card('notes', 'Notes', ANA, { version_id: 'notes-v2', seq: 2 }), orbit];
      await focusPoll();
      expect(tileAction(view.root, 'notes')).toBe('Update | Open');
      expect(document.activeElement === el(view.root, '[data-key="notes"] .disc-tile-action')).toBe(false);
      await strayEnter();
      // Review turns into Open when the Library gains the app elsewhere.
      el(view.root, '[data-key="orbit"] .disc-tile-action').focus();
      host.state.library = [local('local-notes', notes), local('local-orbit', orbit)];
      await focusPoll();
      expect(tileAction(view.root, 'orbit')).toBe('Open');
      expect(document.activeElement === el(view.root, '[data-key="orbit"] .disc-tile-action')).toBe(false);
      await strayEnter();
      expect(host.writes()).toEqual([]);
    } finally { view.close(); }
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
      expect(tileKeys(view.root).slice(0, 96).join(',')).toBe(before);
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
      await click(view.root, 'From people you know');
      expect(tileKeys(view.root).sort()).toEqual(['ana', 'pending']);
      host.state.heard = [card('ana', 'Ana app', ANA)];
      el(view.root, 'button.disc-refresh').click(); await settle();
      expect(tileAction(view.root, 'pending')).toBe('Installing…');
      await click(view.root, 'Updates');
      expect(tileKeys(view.root)).toEqual(['pending']);
      install.resolve({ ok: false, outcomeKnown: false }); await settle();
      el(view.root, 'button.disc-refresh').click(); await settle();
      expect(tileKeys(view.root)).toEqual(['pending']);
      expect(tileAction(view.root, 'pending')).toBe('Look at it');
      host.state.library = [local('local-pending', app)];
      el(view.root, 'button.disc-refresh').click(); await settle();
      expect(tileKeys(view.root)).toEqual([]);
      expect(text(view.root)).toContain('No matching apps');
      expect(host.count('dweb/base/install')).toBe(1);
    } finally { install.resolve({ ok: false }); view.close(); }
  });

  // Any peer can sign a card that names another maker's uri. Only the card its
  // own publisher signed stands for the Library record at that uri.
  it('a card that names another maker\'s installed version is not that app: Review, no installed line, and no Open', async () => {
    const address = formatDwappUri({ did: ANA, hash: 'a'.repeat(64) });
    const target = immutableAppRoot(address);
    const signed = card('signed', 'Signed app', ANA, { version_id: target.hash });
    const forged = card('forged', 'peerd Wallet (official)', BOB, {
      version_id: target.hash, uri: target.uri, description: 'Reviewed and approved by the peerd team.',
    });
    const host = fakeHost({ heard: [signed, forged] }, {
      'dweb/base/inspect-address': () => ({ ok: true, summary: { ...target, name: 'Signed app', decodedBytes: 3, fileCount: 1, entryFile: 'index.html', containsWasm: false } }),
      'dweb/base/install-address': () => ({ ok: true, app: { id: 'app-link' } }),
      'apps/open': () => ({ ok: true }),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      // The share link of this version installs it. Its receipt stands for the signed card only.
      await click(view.root, 'Paste link');
      enterLink(view.root, address);
      await click(view.root, 'Check link');
      await click(view.root, 'Install and share');
      await click(view.root, 'Discover');
      expect(tileAction(view.root, 'signed')).toBe('Open');
      expect(tileAction(view.root, 'forged')).toBe('Look at it');
      // So does the Library record at this uri, once the receipt is gone.
      await click(view.root, 'Paste link');
      enterLink(view.root, '');
      host.state.library = [{ id: 'app-link', dweb: { uri: target.uri, hash: target.hash, publisher: target.publisher } }];
      await focusPoll();
      expect(tileAction(view.root, 'signed')).toBe('Open');
      expect(tileAction(view.root, 'forged')).toBe('Look at it');
      await openTile(view.root, 'forged');
      expect(button(view.root, 'Install and share')).toBeTruthy();
      expect(view.root.querySelector('.disc-panel .disc-installed')).toBe(null);
      expect(button(panel(view.root), 'Open')).toBe(undefined);
      await click(view.root, 'Discover');
      // Surprise me still has it to suggest: it is not in the Library.
      await click(view.root, 'Surprise me');
      expect(text(el(view.root, '.disc-app-title'))).toBe('peerd Wallet (official)');
      expect(host.writes().map(call => call.type)).toEqual(['dweb/base/inspect-address', 'dweb/base/install-address']);
    } finally { view.close(); sessionStorage.removeItem(KEY); }
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

  it('install success: the installed panel, Open sends apps/open, Go to Library leaves, peerd:app-installed fires once', async () => {
    const app = card('a', 'Expense splitter', ANA, { description: 'Split shared costs.', size: 48213 });
    const host = fakeHost({ heard: [app] }, {
      'dweb/base/install': () => ({ ok: true, app: { id: 'local-a' } }),
      'apps/open': () => ({ ok: true }),
    });
    /** @type {unknown[]} */ const events = [];
    /** @param {Event} event */
    const listen = (event) => { events.push(/** @type {CustomEvent} */ (event).detail); };
    window.addEventListener('peerd:app-installed', listen);
    let library = 0;
    const view = mount({ send: host.send, onLibrary: () => { library++; } });
    const safety = () => [...view.root.querySelectorAll('.disc-safety-text')].map(node => text(node));
    try {
      await settle();
      await openTile(view.root, 'a');
      expect([...panel(view.root).querySelectorAll('.disc-step')].map(step => step.className.split(' ').at(-1))).toEqual(['is-current', 'is-pending', 'is-pending']);
      expect([...panel(view.root).querySelectorAll('.disc-step-title')].map(node => text(node))).toEqual(['Look at it', 'Install', 'Open']);
      expect(text(el(view.root, '.disc-app-size'))).toBe('48 KB');
      // Before the install, What to know says what peerd will check; the sharing line sits under the button.
      // It is a section labelled by its heading.
      const know = el(view.root, 'section.disc-safety');
      expect(text(el(know, 'h3'))).toBe('What to know');
      expect(el(know, 'h3').id).toBe(know.getAttribute('aria-labelledby') ?? '');
      expect(safety()).toEqual([
        `Made by ${shortKey(ANA)}. When you install it, peerd checks that every file is exactly what its maker shared. Nobody reviewed it for safety.`,
        'It runs in its own tab and cannot reach the internet by itself.',
        'You can remove it from your Library at any time.',
      ]);
      expect(text(el(view.root, '.disc-panel-cta .disc-footnote'))).toBe('Sharing means other people can get this app from you while your peer network is on.');
      expect(host.writes().length).toBe(0);
      await press(view.root, 'Install and share');
      expect(host.writes()).toEqual([{
        type: 'dweb/base/install', uri: app.uri, name: app.name, dwappId: 'a', slug: 'a', seq: 1, publisher: ANA,
      }]);
      expect(text(el(view.root, '.disc-panel .disc-installed')))
        .toBe('Installed. Expense splitter is now in your Library. Other people can get it from you while your peer network is on.');
      expect(text(el(view.root, '.disc-panel .disc-installed bdi'))).toBe('Expense splitter');
      expect(text(el(view.root, '.disc-app-size'))).toBe('In your Library');
      // The check belongs to the install: an edit on this device can change the files later.
      expect(safety()[0]).toBe(`Made by ${shortKey(ANA)}. When you installed it, peerd checked that it was exactly the app its maker shared. `
        + 'Nobody reviewed it for safety.');
      expect(view.root.querySelector('.disc-panel-cta')).toBe(null);
      expect(events).toEqual([{ appId: 'local-a' }]);
      // Focus lands on the installed line, never on Open, which runs the app.
      const line = el(view.root, '.disc-panel .disc-installed');
      expect(document.activeElement).toBe(line);
      expect([line.getAttribute('role'), line.getAttribute('tabindex')]).toEqual(['status', '-1']);
      expect([...el(view.root, '.disc-panel-actions').querySelectorAll('button')].map(node => text(node).trim())).toEqual(['Open', 'Go to Library']);
      expect(host.count('apps/open')).toBe(0);
      await click(view.root, 'Go to Library');
      expect(library).toBe(1);
      await click(view.root, 'Open');
      expect(host.writes().at(-1)).toEqual({ type: 'apps/open', appId: 'local-a' });
      expect(events.length).toBe(1);
      expect(host.count('dweb/base/install')).toBe(1);
      // A later visit says where the app is, not that it was just installed.
      await click(view.root, 'Discover');
      view.close();
      host.state.library = [local('local-a', app)];
      const later = mount({ send: host.send });
      try {
        await settle();
        await openTile(later.root, 'a');
        expect(text(el(later.root, '.disc-panel .disc-installed'))).toBe('In your Library. Other people can get it from you while your peer network is on.');
      } finally { later.close(); }
    } finally { window.removeEventListener('peerd:app-installed', listen); view.close(); }
  });

  it('a settled install moves focus to its status line only from the removed button, never from a control the user moved to', async () => {
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
      expect(text(panel(view.root))).toContain('is now in your Library.');
      expect(document.activeElement).toBe(toggle);

      await click(view.root, 'Discover');
      await openTile(view.root, 'b');
      await press(view.root, 'Install and share');
      expect(document.activeElement).toBe(document.body);
      second.resolve({ ok: true, app: { id: 'local-b' } }); await settle();
      expect(document.activeElement).toBe(view.root.querySelector('.disc-panel .disc-installed'));
      expect(host.count('apps/open')).toBe(0);
    } finally { first.resolve({ ok: false }); second.resolve({ ok: false }); view.close(); }
  });

  it('a known failure names the app and says Try again, resending exactly once; a runtime code keeps the host message for Technical details', async () => {
    /** @type {unknown[]} */ const replies = [
      { ok: false, error: 'raw host install text' },
      { ok: false, code: 'app-runtime-unsupported', error: 'Unsupported App runtime target: wasi.' },
    ];
    const host = fakeHost({ heard: [card('a', 'App', ANA)] }, { 'dweb/base/install': () => replies.shift() });
    const view = mount({ send: host.send });
    const hint = () => text(el(view.root, '.disc-panel .disc-hint'));
    try {
      await settle();
      await openTile(view.root, 'a');
      await click(view.root, 'Install and share');
      expect(text(el(view.root, '.disc-panel [role="alert"]'))).toBe('peerd could not install App.');
      expect(text(el(view.root, '.disc-panel [role="alert"] bdi'))).toBe('App');
      expect(hint()).toBe('The person who shares it may have gone offline. Try again in a moment.');
      expect(panel(view.root).querySelector('.disc-step.is-failed')).toBeTruthy();
      expect(text(view.root).includes('raw host install text')).toBe(false);
      expect(button(view.root, 'Install and share')).toBe(undefined);
      await click(view.root, 'Try again');
      expect(host.count('dweb/base/install')).toBe(2);
      expect(text(el(view.root, '.disc-panel [role="alert"]'))).toBe('peerd could not install App.');
      expect(hint()).toBe('This browser cannot run it. Technical details says why.');
      // The host's words stay off the main path.
      expect(text(panel(view.root)).includes('Unsupported App runtime target')).toBe(false);
      await click(view.root, 'Technical details');
      expect(facts(view.root).find(([label]) => label === 'Runtime')?.[1]).toBe('Unsupported App runtime target: wasi.');
    } finally { view.close(); }
  });

  it('a failed or unknown update still offers Open, as the installed version runs; an install page does not', async () => {
    const announced = card('upd', 'Updater', BOB, { version_id: 'upd-v2', seq: 2 });
    /** @type {unknown[]} */ const replies = [{ ok: false, error: 'raw host update text' }];
    const host = fakeHost({
      heard: [announced, card('a', 'App', ANA)], library: [local('local-upd', announced, { version_id: 'upd-v1', seq: 1 })],
    }, {
      'dweb/base/update-app': () => { if (replies.length) return replies.shift(); throw new Error('renderer deadline'); },
      'dweb/base/install': () => ({ ok: false, error: 'raw host install text' }),
      'apps/open': () => ({ ok: true }),
    });
    const view = mount({ send: host.send });
    const labels = () => [...panel(view.root).querySelectorAll('button')].map(node => text(node).trim());
    try {
      await settle();
      el(view.root, '[data-key="upd"] .disc-tile-action').click(); await settle();
      expect(text(el(view.root, '.disc-panel [role="alert"]'))).toBe('peerd could not update Updater.');
      expect(text(el(view.root, '.disc-panel .disc-hint'))).toBe('The person who shares it may have gone offline. Try again in a moment.');
      expect(labels()).toEqual(['Try again', 'Open']);
      // The page updates, so every line under the panel says update too.
      expect(text(el(view.root, '.disc-safety-text'))).toContain('When you update it, peerd checks that every file is exactly what its maker shared.');
      expect(text(panel(view.root))).toContain('Another version of this app is in your Library. Open runs the version you have.');
      await click(view.root, 'Open');
      expect(host.writes().at(-1)).toEqual({ type: 'apps/open', appId: 'local-upd' });
      await click(view.root, 'Try again');
      expect(text(el(view.root, '.disc-panel [role="status"]:not(.disc-installed)')))
        .toBe('peerd is not sure the update finished. It may still finish by itself.');
      expect(text(el(view.root, '.disc-panel .disc-hint'))).toBe('Check again before you try to update it again.');
      expect(labels()).toEqual(['Check again', 'Open']);
      expect(text(panel(view.root))).toContain('Another version of this app is in your Library. Open runs the version you have.');
      await click(view.root, 'Discover');
      await openTile(view.root, 'a');
      await click(view.root, 'Install and share');
      expect(labels()).toEqual(['Try again']);
      expect(host.count('dweb/base/update-app')).toBe(2);
    } finally { view.close(); }
  });

  for (const [label, reply] of /** @type {const} */ ([['an unknown reply', 'unknown'], ['a thrown send', 'throw']])) {
    it(`unknown install (${label}): neutral panel, no replay, Check again clears only on the exact identity`, async () => {
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
        expect(text(el(view.root, '.disc-panel [role="status"]:not(.disc-installed)'))).toBe(UNKNOWN_INSTALL);
        expect(text(el(view.root, '.disc-panel .disc-hint'))).toBe('Check again before you try to install it again.');
        expect(panel(view.root).querySelector('[role="alert"]')).toBe(null);
        expect(panel(view.root).querySelector('.error')).toBe(null);
        expect(panel(view.root).querySelector('.disc-step.is-unknown')).toBeTruthy();
        expect(text(view.root).includes('raw renderer transport text')).toBe(false);
        expect(button(view.root, 'Install and share')).toBe(undefined);
        expect(button(view.root, 'Try again')).toBe(undefined);
        await click(view.root, 'Check again');
        expect(text(panel(view.root))).toContain(UNKNOWN_INSTALL);
        for (const drift of [{ version_id: 'a-v2', seq: 2 }, { version_id: 'a-other', seq: 3 }]) {
          host.state.library = [local('local-other', app, drift)];
          await click(view.root, 'Check again');
          expect(text(panel(view.root))).toContain(UNKNOWN_INSTALL);
        }
        expect(host.count('dweb/base/install')).toBe(1);
        host.state.library = [local('local-a', app)];
        await click(view.root, 'Check again');
        // The install did finish: the line says so.
        expect(text(panel(view.root))).toContain('Installed. App is now in your Library.');
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
      expect(text(el(view.root, '.disc-panel [role="status"]:not(.disc-installed)'))).toBe('peerd is not sure the update finished. It may still finish by itself.');
      for (const drift of [{ version: 'upd-v1', seq: 1 }, { version: 'upd-other', seq: 2 }]) {
        version = drift.version; seq = drift.seq; refreshLibrary();
        await click(view.root, 'Check again');
        expect(text(panel(view.root))).toContain('is not sure the update finished');
      }
      await click(view.root, 'Discover');
      expect(tileAction(view.root, 'upd')).toBe('Look at it');
      await openTile(view.root, 'upd');
      version = 'upd-v2'; seq = 2; refreshLibrary();
      await click(view.root, 'Check again');
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
      expect(text(el(view.root, '.disc-panel [role="status"]:not(.disc-installed)'))).toBe(KEEPS_GOING);
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
      expect(text(el(view.root, '.disc-panel [role="status"]:not(.disc-installed)'))).toBe(UNKNOWN_INSTALL);
      expect(button(view.root, 'Install and share')).toBe(undefined);
      await click(view.root, 'Discover');
      await openTile(view.root, 'upd');
      expect(text(el(view.root, '.disc-panel [role="status"]:not(.disc-installed)')))
        .toBe('peerd is not sure the update finished. It may still finish by itself.');
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
      expect(text(panel(view.root))).toContain('Installed. App A is now in your Library.');
      await click(view.root, 'Discover');
      el(view.root, '[data-key="upd"] .disc-tile-action').click(); await settle();
      expect(text(panel(view.root))).toContain('peerd could not update Updater.');
      view.close();
      // Meanwhile, in the Library: App A was deleted and Updater was updated.
      host.state.library = [local('local-upd', announced)];
      view = mount({ send: host.send, effects });
      await settle();
      expect(tileAction(view.root, 'a')).toBe('Look at it');
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
      'dweb/base/update-app': (message) => {
        if (message.strategy) host.state.library = [local('local-trip', announced)];
        return replies.shift();
      },
    });
    const view = mount({ send: host.send });
    const updates = () => host.calls.filter(call => call.type === 'dweb/base/update-app');
    try {
      await settle();
      el(view.root, '[data-key="trip"] .disc-tile-action').click(); await settle();
      expect(text(panel(view.root))).toContain('Update ready');
      expect(text(panel(view.root))).toContain('You changed this app on this device. The update does not replace your changes unless you choose that.');
      expect(text(panel(view.root))).toContain('Keep my copy puts your changed copy in your Library, next to the new version.');
      expect(text(el(view.root, '.disc-chip--strong'))).toBe('Changed on this device');
      expect(text(el(view.root, '.disc-app-size'))).toBe('In your Library');
      expect(view.root.querySelector('ol.disc-steps')).toBe(null);
      expect(text(view.root).includes('What to know')).toBe(false);
      await click(view.root, 'Cancel');
      expect(view.root.querySelector('.disc-back')).toBe(null);
      expect(document.activeElement).toBe(view.root.querySelector('[data-key="trip"] .disc-tile-open'));
      expect(updates().length).toBe(1);
      expect(tileAction(view.root, 'trip')).toBe('Update | Open');
      el(view.root, '[data-key="trip"] .disc-tile-action').click(); await settle();
      await click(view.root, 'Replace my changes');
      expect(updates()[2]).toEqual({
        type: 'dweb/base/update-app', appId: 'local-trip', uri: announced.uri, name: announced.name, dwappId: 'trip',
        slug: 'trip', seq: 2, publisher: BOB, strategy: 'replace', conflictToken: 8,
      });
      expect(text(panel(view.root))).toContain('In your Library.');
      expect(view.root.querySelector('.disc-chip--strong')).toBe(null);
      expect(updates().length).toBe(3);
    } finally { view.close(); }

    // The fork name holds a peer-signed card name, here with its own isolate
    // end and a right-to-left override. The name loses both, and FSI and PDI
    // keep it inside the quotes.
    const forkName = 'Trip\u2069 planner\u202E (fork)';
    const fork = fakeHost({ heard: [announced], library: [local('local-trip', announced, { version_id: 'trip-v1', seq: 1 })] }, {
      'dweb/base/update-app': (message) => {
        if (!message.strategy) return { ok: false, error: 'local-changes', conflictToken: 7 };
        fork.state.library = [local('local-trip', announced)];
        return { ok: true, fork: { name: forkName } };
      },
    });
    const second = mount({ send: fork.send });
    try {
      await settle();
      el(second.root, '[data-key="trip"] .disc-tile-action').click(); await settle();
      await click(second.root, 'Keep my copy and update');
      expect(fork.writes().map(call => [call.strategy, call.conflictToken])).toEqual([[undefined, undefined], ['fork', 7]]);
      expect(panelNotice(second.root)).toBe('Kept your changed copy as “\u2068Trip planner (fork)\u2069” and updated this app.');
      expect([...panelNotice(second.root)].filter(ch => /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(ch)))
        .toEqual(['\u2068', '\u2069']);
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
      expect(text(el(view.root, '.disc-chip--strong'))).toBe('Changed on this device');
      // Peers announce a newer version: the token answered the older offer.
      host.state.heard = [newer];
      await focusPoll();
      expect(view.root.querySelector('.disc-chip--strong')).toBe(null);
      expect(button(view.root, 'Replace my changes')).toBe(undefined);
      await click(view.root, 'Update');
      expect(updates().map(call => [call.seq, call.conflictToken])).toEqual([[2, undefined], [3, undefined]]);
      expect(text(el(view.root, '.disc-chip--strong'))).toBe('Changed on this device');
      // The update is resolved in the Library: the offer and its token are gone.
      host.state.library = [local('local-trip', newer)];
      await focusPoll();
      expect(view.root.querySelector('.disc-chip--strong')).toBe(null);
      expect(button(view.root, 'Replace my changes')).toBe(undefined);
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
      'dweb/base/update-app': () => {
        host.state.library = [local('local-upd', announced)];
        return { ok: true, warning: 'audit-write-failed', warnings: ['audit-write-failed', 'previous-version-cleanup-pending'] };
      },
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, 'fresh');
      await click(view.root, 'Install and share');
      expect(panelNotice(view.root)).toBe('Installed, but peerd could not add it to the security log.');
      await click(view.root, 'Discover');
      await click(view.root, 'From people you know');
      expect(tileKeys(view.root)).toEqual(['fresh']);
      await click(view.root, 'All');
      el(view.root, '[data-key="upd"] .disc-tile-action').click(); await settle();
      const status = panelNotice(view.root);
      expect(status).toContain('Updated, but peerd could not add it to the security log.');
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

  // A Library read that starts before a commit answers with the Library as it was.
  for (const effect of /** @type {const} */ (['an install', 'an update', 'a Commons add'])) {
    it(`${effect} that commits during a Library read reads the Library again after it`, async () => {
      const app = card('a', 'App', ANA, { version_id: 'a-v2', seq: 2 });
      const commons = effect === 'a Commons add';
      const before = effect === 'an update' ? [local('local-a', app, { version_id: 'a-v1', seq: 1 })] : [];
      const commit = deferred();
      const early = deferred();
      let hold = false;
      const host = fakeHost({ heard: [app], library: before }, {
        'apps/list': () => hold ? early.promise : { ok: true, apps: host.state.library },
        'dweb/base/install': () => commit.promise,
        'dweb/base/update-app': () => commit.promise,
        'dweb/open-commons': () => commit.promise,
      });
      const view = mount({ send: host.send });
      try {
        await settle();
        if (commons) {
          await click(view.root, 'Comes with peerd');
          await click(view.root, 'Add and open Commons');
          await until(() => host.count('dweb/open-commons') === 1);
        } else {
          await openTile(view.root, 'a');
          await click(view.root, effect === 'an update' ? 'Update' : 'Install and share');
        }
        hold = true;
        await focusPoll();
        hold = false;
        host.state.library = commons ? [{ id: 'app-commons', dweb: { seed: 'commons' } }] : [local('local-a', app)];
        commit.resolve(effect === 'an install' ? { ok: true, app: { id: 'local-a' } } : { ok: true });
        await settle();
        const reads = host.count('apps/list');
        early.resolve({ ok: true, apps: before }); await settle();
        expect(host.count('apps/list')).toBeGreaterThan(reads);
        expect(button(view.root, commons ? 'Add and open Commons' : 'Update')).toBe(undefined);
      } finally { commit.resolve({ ok: false }); early.resolve({ ok: false }); view.close(); }
    });
  }

  it('a Library read that started before an update committed never offers that update again', async () => {
    const app = card('a', 'App', ANA, { version_id: 'a-v2', seq: 2 });
    const before = [local('local-a', app, { version_id: 'a-v1', seq: 1 })];
    const commit = deferred();
    const early = deferred();
    const fresh = deferred();
    /** @type {unknown[]} */ const held = [];
    const host = fakeHost({ heard: [app], library: before }, {
      'apps/list': () => held.length ? held.shift() : { ok: true, apps: host.state.library },
      'dweb/base/update-app': () => commit.promise,
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, 'a');
      await click(view.root, 'Update');
      held.push(early.promise, fresh.promise);
      await focusPoll();
      host.state.library = [local('local-a', app)];
      commit.resolve({ ok: true }); await settle();
      // The read that started before the commit lands with the older version.
      early.resolve({ ok: true, apps: before }); await settle();
      expect(button(view.root, 'Update')).toBe(undefined);
      expect(text(panel(view.root))).toContain('In your Library. Other people can get it from you');
      await click(view.root, 'Discover');
      expect(tileAction(view.root, 'a')).toBe('Open');
      expect(text(view.root).includes('new version ready')).toBe(false);
      // The read that started after the commit decides from now on.
      fresh.resolve({ ok: true, apps: [] }); await settle();
      expect(tileAction(view.root, 'a')).toBe('Look at it');
      expect(host.count('dweb/base/update-app')).toBe(1);
    } finally { commit.resolve({ ok: false }); early.resolve({ ok: false }); fresh.resolve({ ok: false }); view.close(); }
  });

  // Only the mounted view's own Library read refreshes the catalog it shows.
  for (const outcome of /** @type {const} */ (['committed', 'unknown'])) {
    it(`an update that settles after a remount keeps its custody until the mounted view reads the Library (${outcome})`, async () => {
      const app = card('a', 'App', ANA, { version_id: 'a-v2', seq: 2 });
      const commit = deferred();
      const late = deferred();
      let hold = false;
      const host = fakeHost({ heard: [app], library: [local('local-a', app, { version_id: 'a-v1', seq: 1 })] }, {
        'apps/list': () => hold ? late.promise : { ok: true, apps: host.state.library },
        'dweb/base/update-app': () => commit.promise,
      });
      const effects = createEffects();
      const custody = outcome === 'committed' ? effects.committed : effects.unconfirmed;
      let view = mount({ send: host.send, effects });
      try {
        await settle();
        await openTile(view.root, 'a');
        await click(view.root, 'Update');
        if (outcome === 'unknown') {
          commit.reject(new Error('renderer deadline')); await settle();
          // A Library read of this view is still in flight when it closes.
          hold = true; await focusPoll(); hold = false;
        }
        view.close();
        view = mount({ send: host.send, effects });
        await settle();
        expect(tileAction(view.root, 'a')).toBe(outcome === 'committed' ? 'Updating…' : 'Look at it');
        host.state.library = [local('local-a', app)];
        const reads = host.count('apps/list');
        // The closed view reads the Library after the commit, or its read in flight lands.
        if (outcome === 'committed') commit.resolve({ ok: true });
        else late.resolve({ ok: true, apps: host.state.library });
        await settle();
        expect(host.count('apps/list')).toBe(reads + (outcome === 'committed' ? 1 : 0));
        expect(tileAction(view.root, 'a')).toBe(outcome === 'committed' ? 'Open' : 'Look at it');
        expect(custody.has('a')).toBe(true);
        await focusPoll();
        expect(custody.has('a')).toBe(false);
        expect(tileAction(view.root, 'a')).toBe('Open');
        expect(host.count('dweb/base/update-app')).toBe(1);
      } finally { commit.resolve({ ok: false }); late.resolve({ ok: false }); view.close(); }
    });
  }

  it('a failed Open says so in an alert inside its tile and never offers Install again', async () => {
    const app = card('a', 'App A', ANA);
    let openOutcome = 'failed';
    const host = fakeHost({ heard: [app], library: [local('local-a', app)] }, {
      'apps/open': () => {
        if (openOutcome === 'lost') throw new Error('renderer deadline');
        return { ok: false, outcomeKnown: openOutcome !== 'unknown' };
      },
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      el(view.root, '[data-key="a"] .disc-tile-action').click(); await settle();
      // why inside the tile: a line above a long grid sits off screen for the tile the user clicked.
      expect(text(el(view.root, '[data-key="a"] [role="alert"]'))).toBe(OPEN_FAILED);
      expect(el(view.root, '[data-key="a"] [role="alert"]').classList.contains('error')).toBe(true);
      expect(view.root.querySelector('.disc-view > [role="alert"]')).toBe(null);
      expect(tileAction(view.root, 'a')).toBe('Open');
      await openTile(view.root, 'a');
      await click(view.root, 'Open');
      expect(text(el(view.root, '.disc-panel [role="alert"]'))).toBe(OPEN_FAILED);
      expect(button(view.root, 'Install and share')).toBe(undefined);
      expect(button(view.root, 'Try again')).toBe(undefined);
      expect(button(panel(view.root), 'Open')?.disabled).toBe(false);
      expect(host.writes()).toEqual([{ type: 'apps/open', appId: 'local-a' }, { type: 'apps/open', appId: 'local-a' }]);
      // A row on the maker page says so too, inside that row.
      await click(view.root, `Made by ${shortKey(ANA)}`);
      el(view.root, '[data-key="a"] .disc-tile-action').click(); await settle();
      expect(text(el(view.root, '[data-key="a"] [role="alert"]'))).toBe(OPEN_FAILED);
      expect(host.count('apps/open')).toBe(3);
      for (openOutcome of ['unknown', 'lost']) {
        el(view.root, '[data-key="a"] .disc-tile-action').click(); await settle();
        expect(text(el(view.root, '[data-key="a"] [role="status"]'))).toBe('peerd is not sure the app opened. Check your tabs.');
        expect(el(view.root, '[data-key="a"]').querySelector('.error')).toBe(null);
        await openTile(view.root, 'a');
        await click(view.root, 'Open');
        expect(text(panel(view.root))).toContain('peerd is not sure the app opened. Check your tabs.');
        expect(panel(view.root).querySelector('.error')).toBe(null);
        await click(view.root, `Made by ${shortKey(ANA)}`);
      }
    } finally { view.close(); }
  });

  it('an installed app with a newer version offers Update and Open, and claims nothing about the new version', async () => {
    const announced = card('trip', 'Trip planner', BOB, { version_id: 'trip-v2', seq: 2 });
    const host = fakeHost({ heard: [announced], library: [local('local-trip', announced, { version_id: 'trip-v1', seq: 1 })] }, {
      'apps/open': () => ({ ok: true }),
      'dweb/base/update-app': () => { host.state.library = [local('local-trip', announced)]; return { ok: true }; },
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, 'trip');
      expect(text(panel(view.root))).toContain('Update ready');
      // Update installs and shares, so What to know stays, about the version peers announce.
      expect(text(view.root)).toContain('What to know');
      expect(text(el(view.root, '.disc-safety-text'))).toContain('When you update it, peerd checks that every file is exactly what its maker shared.');
      // The panel says update, never share, so its footnote says what an update does.
      expect(text(panel(view.root))).toContain('After you update, other people can get the new version from you while your peer network is on.');
      expect(text(el(view.root, '.disc-panel .disc-primary'))).toBe('Update');
      expect(button(panel(view.root), 'Open')?.classList.contains('disc-primary')).toBe(false);
      expect(panel(view.root).querySelector('ol.disc-steps')).toBe(null);
      expect(text(view.root).includes('Other people can get it from you')).toBe(false);
      await click(view.root, 'Open');
      expect(host.writes()).toEqual([{ type: 'apps/open', appId: 'local-trip' }]);
      await click(view.root, 'Update');
      await until(() => text(panel(view.root)).includes('In your Library.'));
      expect(host.count('dweb/base/update-app')).toBe(1);
      expect(button(panel(view.root), 'Update')).toBe(undefined);
    } finally { view.close(); }
  });

  it('an installed app whose new version can not run still opens; its page says the update can not run and offers no Update', async () => {
    const installed = card('wasi', 'WASI app', CARL);
    const host = fakeHost({
      heard: [card('wasi', 'WASI app', CARL, { version_id: 'wasi-v2', seq: 2, uri: `peerd://${CARL}/wasi-v2`,
        runtimeCompatibility: { status: 'unsupported', message: 'Unsupported App runtime target: wasi.' } })],
      library: [local('local-wasi', installed)],
    }, { 'apps/open': () => ({ ok: true }) });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(tileAction(view.root, 'wasi')).toBe('Open');
      expect(text(view.root).includes('new version ready')).toBe(false);
      await click(view.root, 'Updates');
      expect(tileKeys(view.root)).toEqual([]);
      await click(view.root, 'All');
      el(view.root, '[data-key="wasi"] .disc-tile-action').click(); await settle();
      expect(host.writes()).toEqual([{ type: 'apps/open', appId: 'local-wasi' }]);
      await openTile(view.root, 'wasi');
      expect(text(panel(view.root))).toContain('This browser cannot run the new version.');
      expect(text(view.root).includes('This browser cannot run this app.')).toBe(false);
      expect(button(view.root, 'Update')).toBe(undefined);
      expect(text(view.root).includes('What to know')).toBe(false);
      // Only the head says the app is in the Library; nothing claims the new version.
      expect(text(el(view.root, '.disc-app-size'))).toBe('In your Library');
      expect(text(panel(view.root)).includes('In your Library')).toBe(false);
      await click(view.root, 'Open');
      expect(host.writes().at(-1)).toEqual({ type: 'apps/open', appId: 'local-wasi' });
      expect(host.count('dweb/base/update-app')).toBe(0);
    } finally { view.close(); }
  });

  it('an update offer that turns runnable never turns a focused Open into Update', async () => {
    const installed = card('wasi', 'WASI app', CARL);
    const flagged = card('wasi', 'WASI app', CARL, { version_id: 'wasi-v2', seq: 2,
      runtimeCompatibility: { status: 'unsupported', message: 'Unsupported App runtime target: wasi.' } });
    const runnable = card('wasi', 'WASI app', CARL, { version_id: 'wasi-v3', seq: 3 });
    const host = fakeHost({ heard: [flagged], library: [local('local-wasi', installed)] }, {
      'apps/open': () => ({ ok: true }), 'dweb/base/update-app': () => ({ ok: true }),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, 'wasi');
      button(panel(view.root), 'Open')?.focus();
      expect(document.activeElement).toBe(button(panel(view.root), 'Open'));
      host.state.heard = [runnable];
      await focusPoll();
      expect(text(panel(view.root))).toContain('Update ready');
      await strayEnter();
      expect(host.count('dweb/base/update-app')).toBe(0);
    } finally { view.close(); }
  });

  it('the installed line claims this version only when the Library holds it', async () => {
    // The user's own app shared at a newer version from another device, and a
    // card older than the version in the Library.
    const host = fakeHost({
      heard: [card('mine', 'Mine', SELF, { version_id: 'mine-v2', seq: 2 }), card('trip', 'Trip planner', BOB)],
      library: [local('local-mine', card('mine', 'Mine', SELF)), local('local-trip', card('trip', 'Trip planner', BOB, { version_id: 'trip-v2', seq: 2 }))],
    }, { 'apps/open': () => ({ ok: true }) });
    const view = mount({ send: host.send });
    try {
      await settle();
      for (const [key, appId] of /** @type {const} */ ([['mine', 'local-mine'], ['trip', 'local-trip']])) {
        await openTile(view.root, key);
        expect(text(panel(view.root))).toContain('Another version of this app is in your Library. Open runs the version you have.');
        expect(text(view.root).includes('Other people can get it from you')).toBe(false);
        await click(view.root, 'Open');
        expect(host.writes().at(-1)).toEqual({ type: 'apps/open', appId });
        await click(view.root, 'Discover');
      }
    } finally { view.close(); }
  });

  it('the user made the app: What to know says so, and never that an install checked it against its maker', async () => {
    // Made here and shared from the Library, so no install checked it.
    const mine = card('mine', 'My app', SELF);
    const host = fakeHost({ heard: [mine], library: [local('local-mine', mine, { local: true })] });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, 'mine');
      expect(text(panel(view.root))).toContain('In your Library.');
      expect(text(el(view.root, '.disc-safety-text'))).toBe('You made this app. Other people get the files you share from your Library.');
      expect(text(el(view.root, '.disc-safety')).includes('peerd checked')).toBe(false);
      expect(host.writes().length).toBe(0);
    } finally { view.close(); }
  });

  it('an installed app whose own version can not run here shows the can not run state', async () => {
    const flagged = card('wasi', 'WASI app', CARL, { runtimeCompatibility: { status: 'unsupported', message: 'Unsupported App runtime target: wasi.' } });
    const host = fakeHost({ heard: [flagged], library: [local('local-wasi', flagged)] });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(tileAction(view.root, 'wasi')).toBe('This browser cannot run it');
      await openTile(view.root, 'wasi');
      expect(text(panel(view.root))).toContain('This browser cannot run this app.');
      expect(button(view.root, 'Open')).toBe(undefined);
      // The catalog's version decides, even when a record shares the card's uri.
      host.state.library = [local('local-wasi', flagged, { version_id: 'wasi-v0', seq: 0 })];
      await focusPoll();
      expect(text(panel(view.root))).toContain('This browser cannot run the new version.');
      expect(button(panel(view.root), 'Open')).toBeTruthy();
      expect(host.writes().length).toBe(0);
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
      expect(text(panel(view.root))).toContain('This browser cannot run this app.');
      expect(button(view.root, 'Install and share')).toBe(undefined);
      expect(view.root.querySelector('ol.disc-steps')).toBe(null);
      expect(text(view.root).includes('What to know')).toBe(false);
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
        expect(text(el(view.root, '.disc-section [role="status"]'))).toBe('Could not copy. Select the text and copy it yourself.');
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

describe('home.discover share dialog', () => {
  const hash = 'a'.repeat(64);
  const app = card('share', 'Expense splitter', ANA, { version_id: hash, uri: `peerd://${ANA}/${hash}` });
  /**
   * @param {unknown} clipboard
   * @param {(view: ReturnType<typeof mount>, host: ReturnType<typeof fakeHost>) => Promise<void>} run
   * @param {Partial<HostState>} [initial]
   */
  const withShare = async (clipboard, run, initial = {}) => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    const host = fakeHost({ heard: [app], ...initial });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, initial.heard?.[0]?.dwapp_id ?? 'share');
      await run(view, host);
    } finally {
      view.close();
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  };
  /** @param {ParentNode} root */
  const dialog = (root) => root.querySelector('[role="dialog"]');
  /** @param {string} key */
  const keydown = async (key, shiftKey = false) => {
    /** @type {HTMLElement} */ (document.activeElement).dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
    await settle();
  };

  it('Share opens a dialog with the link; Copy link copies it and says so; Escape returns focus to Share; nothing is sent', async () => {
    /** @type {string[]} */ const writes = [];
    await withShare({ writeText: async (/** @type {string} */ value) => { writes.push(value); } }, async (view, host) => {
      expect(text(el(view.root, '[data-share-open]')).trim()).toBe('Share');
      expect(dialog(view.root)).toBe(null);
      await press(view.root, 'Share');
      const box = el(view.root, '[role="dialog"]');
      expect(box.getAttribute('aria-modal')).toBe('true');
      expect(text(el(view.root, `#${box.getAttribute('aria-labelledby')}`))).toBe('Share Expense splitter');
      const input = /** @type {HTMLInputElement} */ (el(box, 'input'));
      expect(text(el(box, `label[for="${input.id}"]`))).toBe('Share link');
      expect([input.value, input.readOnly]).toEqual([discoveryAddress(app), true]);
      expect(text(box)).toContain('Send this link to a friend. They open it in peerd with the peer network on, and can look at the app before they install it.');
      expect(text(box)).toContain('The link points to this exact version. If its maker updates the app later, your friend gets the version you shared.');
      // Focus moves into the dialog, onto its action.
      expect(document.activeElement).toBe(button(box, 'Copy link'));
      const status = el(box, '[role="status"]');
      expect(text(status)).toBe('');
      await click(box, 'Copy link');
      expect(writes).toEqual([discoveryAddress(app)]);
      expect(el(box, '[role="status"]')).toBe(status);
      expect(text(status)).toBe('Link copied.');
      await keydown('Escape');
      expect(dialog(view.root)).toBe(null);
      expect(document.activeElement).toBe(el(view.root, '[data-share-open]'));
      expect(host.writes().length).toBe(0);
    });
  });

  it('Tab stays inside the dialog; Close and a click outside close it and return focus to Share', async () => {
    await withShare({ writeText: async () => {} }, async (view) => {
      await press(view.root, 'Share');
      const box = el(view.root, '[role="dialog"]');
      const close = el(box, 'button[aria-label="Close"]');
      const copy = /** @type {HTMLButtonElement} */ (button(box, 'Copy link'));
      await keydown('Tab');
      expect(document.activeElement).toBe(close);
      await keydown('Tab', true);
      expect(document.activeElement).toBe(copy);
      close.click(); await settle();
      expect(dialog(view.root)).toBe(null);
      expect(document.activeElement).toBe(el(view.root, '[data-share-open]'));
      await press(view.root, 'Share');
      // A click inside keeps it open; a click on the backdrop closes it.
      el(view.root, '[role="dialog"] p').click(); await settle();
      expect(dialog(view.root)).toBeTruthy();
      el(view.root, '.peerd-modal-backdrop').click(); await settle();
      expect(dialog(view.root)).toBe(null);
      expect(document.activeElement).toBe(el(view.root, '[data-share-open]'));
    });
  });

  it('a click on the dialog text keeps focus in the dialog, so Tab stays inside and Escape still closes it', async () => {
    await withShare({ writeText: async () => {} }, async (view) => {
      await press(view.root, 'Share');
      const box = el(view.root, '[role="dialog"]');
      // A real click on text focuses the nearest box that takes focus. A
      // synthetic click moves no focus, so the case focuses the dialog itself.
      box.focus();
      expect(document.activeElement).toBe(box);
      await keydown('Tab');
      expect(document.activeElement).toBe(el(box, 'button[aria-label="Close"]'));
      box.focus();
      await keydown('Tab', true);
      expect(document.activeElement).toBe(button(box, 'Copy link'));
      box.focus();
      await keydown('Escape');
      expect(dialog(view.root)).toBe(null);
      expect(document.activeElement).toBe(el(view.root, '[data-share-open]'));
    });
  });

  it('a saved maker is named, and an app with no share link has no Share', async () => {
    await withShare({ writeText: async () => {} }, async (view) => {
      await press(view.root, 'Share');
      expect(text(el(view.root, '[role="dialog"]'))).toContain('If Ana updates the app later, your friend gets the version you shared.');
    }, { contacts: [{ did: ANA, name: 'Ana', saved: true }] });
    await withShare({ writeText: async () => {} }, async (view) => {
      expect(view.root.querySelector('[data-share-open]')).toBe(null);
    }, { heard: [card('drift', 'Drift app', ANA, { version_id: hash, uri: 'peerd://other/hash' })] });
  });

  for (const clipboard of [undefined, { writeText: async () => { throw new Error('permission denied raw error'); } }]) {
    it('a failed copy says what to do in the dialog and never claims a copy', async () => {
      await withShare(clipboard, async (view) => {
        await press(view.root, 'Share');
        await click(view.root, 'Copy link');
        const box = el(view.root, '[role="dialog"]');
        expect(text(el(box, '[role="status"]'))).toBe('peerd could not copy the link. Select it and copy it yourself.');
        expect(text(view.root).includes('Link copied.')).toBe(false);
        expect(text(view.root).includes('permission denied raw error')).toBe(false);
        expect(button(box, 'Copy link')?.disabled).toBe(false);
        // The note under Technical details is for its own Copy buttons.
        await keydown('Escape');
        await click(view.root, 'Technical details');
        expect(text(view.root).includes('Could not copy.')).toBe(false);
      });
    });
  }

  it('never says Link copied for a newer version when an older copy completes', async () => {
    const release = deferred();
    /** @type {string[]} */ const writes = [];
    const clipboard = { writeText: async (/** @type {string} */ value) => { writes.push(value); await release.promise; } };
    await withShare(clipboard, async (view, host) => {
      try {
        await press(view.root, 'Share');
        await click(view.root, 'Copy link');
        expect(button(view.root, 'Copy link')?.disabled).toBe(true);
        const next = 'b'.repeat(64);
        const newer = { ...app, seq: 2, version_id: next, uri: `peerd://${ANA}/${next}` };
        host.state.heard = [newer];
        await focusPoll();
        expect(/** @type {HTMLInputElement} */ (el(view.root, '[role="dialog"] input')).value).toBe(discoveryAddress(newer));
        release.resolve(undefined); await settle();
        expect(text(el(view.root, '[role="dialog"] [role="status"]'))).toBe('');
        await click(view.root, 'Copy link');
        expect(writes).toEqual([discoveryAddress(app), discoveryAddress(newer)]);
        expect(text(el(view.root, '[role="dialog"] [role="status"]'))).toBe('Link copied.');
      } finally { release.resolve(undefined); }
    });
  });

  it('the share-link page shares the link it checked', async () => {
    const address = formatDwappUri({ did: ANA, hash: 'c'.repeat(64) });
    const target = immutableAppRoot(address);
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    /** @type {string[]} */ const writes = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (/** @type {string} */ value) => { writes.push(value); } } });
    const host = fakeHost({ contacts: [{ did: ANA, name: 'Ana', saved: true }] }, {
      'dweb/base/inspect-address': () => ({ ok: true, summary: { ...target, name: 'Linked app', decodedBytes: 3, fileCount: 1, entryFile: 'index.html', containsWasm: false } }),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await click(view.root, 'Paste link');
      enterLink(view.root, address);
      await click(view.root, 'Check link');
      await press(view.root, 'Share');
      const box = el(view.root, '[role="dialog"]');
      expect(text(el(box, 'h2'))).toBe('Share Linked app');
      expect(/** @type {HTMLInputElement} */ (el(box, 'input')).value).toBe(address);
      await click(box, 'Copy link');
      expect(writes).toEqual([address]);
      expect(host.writes().map(call => call.type)).toEqual(['dweb/base/inspect-address']);
    } finally {
      view.close();
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
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
      // Nothing to pick on the Comes with peerd pill: the button stays on, as drawn, and says why no page opened.
      await click(view.root, 'Comes with peerd');
      expect(button(view.root, 'Surprise me')?.disabled).toBe(false);
      await click(view.root, 'Surprise me');
      expect(view.root.querySelector('.disc-back')).toBe(null);
      const note = el(view.root, '.disc-footnote[aria-live="polite"]');
      expect([note.getAttribute('role'), text(note)]).toEqual(['status', NO_SUGGESTION]);
      await click(view.root, 'All');
      expect(text(view.root).includes(NO_SUGGESTION)).toBe(false);
      host.state.libraryFails = true;
      el(view.root, 'button.disc-refresh').click(); await settle();
      expect(button(view.root, 'Surprise me')?.disabled).toBe(true);
      expect(text(/** @type {Element} */ (libraryLine(view.root))))
        .toBe('Could not refresh your Library. Surprise me stays off until peerd can read it.');
      expect(host.writes().length).toBe(0);
    } finally { library.resolve({ ok: false }); view.close(); }
  });

  it('Surprise me with every app installed says why no page opened, until the filters or the page change', async () => {
    const app = card('a', 'App A', ANA);
    const host = fakeHost({ heard: [app], library: [local('local-a', app)] });
    const view = mount({ send: host.send });
    try {
      await settle();
      // No filter and no search: the line names the Library, never the filters.
      await click(view.root, 'Surprise me');
      expect(view.root.querySelector('.disc-back')).toBe(null);
      const note = el(view.root, '.disc-footnote[aria-live="polite"]');
      expect([note.getAttribute('role'), text(note)]).toEqual(['status', ALL_IN_LIBRARY]);
      search(view.root, 'app');
      expect(view.root.querySelector('.disc-footnote[aria-live="polite"]')).toBe(null);
      await click(view.root, 'Surprise me');
      expect(text(el(view.root, '.disc-footnote[aria-live="polite"]'))).toBe(NO_SUGGESTION);
      // A page visit clears it too.
      await openTile(view.root, 'a');
      await click(view.root, 'Discover');
      expect(text(view.root).includes(NO_SUGGESTION)).toBe(false);
      await click(view.root, 'From people you know');
      search(view.root, '');
      await click(view.root, 'Surprise me');
      expect(text(el(view.root, '.disc-footnote[aria-live="polite"]'))).toBe(NO_SUGGESTION);
      // And so does Clear filters.
      await click(view.root, 'Clear filters');
      expect(text(view.root).includes(NO_SUGGESTION)).toBe(false);
      expect(host.writes().length).toBe(0);
    } finally { view.close(); }
  });

  it('Surprise me with no filter claims only what is true when an app it skips is not in the Library', async () => {
    const installed = card('a', 'App A', ANA);
    const host = fakeHost({
      heard: [installed, card('cant', 'Cant run', BOB, { runtimeCompatibility: { status: 'unsupported', message: 'Not supported' } })],
      library: [local('local-a', installed)],
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await click(view.root, 'Surprise me');
      expect(view.root.querySelector('.disc-back')).toBe(null);
      expect(text(el(view.root, '.disc-footnote[aria-live="polite"]'))).toBe('No new suggestions.');
      expect(host.writes().length).toBe(0);
    } finally { view.close(); }
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
      expect(text(el(view.root, '.disc-start-row [role="alert"]'))).toBe('This link points to one file inside an app. Paste the link to the whole app.');
      // The parser's own words ("Invalid dwapp URI") never reach the row.
      enterLink(view.root, 'hello');
      await click(view.root, 'Check link');
      expect(text(el(view.root, '.disc-start-row [role="alert"]'))).toBe('This is not a share link. Paste the whole link you were sent.');
      expect(host.count('dweb/base/inspect-address')).toBe(0);

      enterLink(view.root, address);
      await click(view.root, 'Check link');
      enterLink(view.root, formatDwappUri({ did: ANA, hash: 'b'.repeat(64) }));
      late.resolve({ ok: true, summary }); await settle();
      expect(view.root.querySelector('.disc-back')).toBe(null);
      expect(host.count('dweb/base/inspect-address')).toBe(1);

      enterLink(view.root, address);
      await click(view.root, 'Check link');
      expect(text(el(view.root, '.disc-start-row [role="alert"]'))).toBe('peerd could not check this app. The link may be wrong, or the people who have it may be offline. Check the link, then try again.');
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

  it('a link this browser cannot run says so in plain words; the host text reaches only Technical details', async () => {
    /** @type {unknown[]} */ const inspections = [
      { ok: false, code: 'app-runtime-unsupported', error: 'Unsupported App runtime target: wasi.' },
      { ok: true, summary },
    ];
    const host = fakeHost({ heard: [peerApp] }, {
      'dweb/base/inspect-address': () => inspections.shift(),
      'dweb/base/install-address': () => ({ ok: false, code: 'app-runtime-mismatch', error: 'App runtime requirements do not match the signed version.' }),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await click(view.root, 'Paste link');
      enterLink(view.root, address);
      await click(view.root, 'Check link');
      expect(text(el(view.root, '.disc-start-row [role="alert"]'))).toBe('peerd could not check this app. This browser cannot run it.');
      expect(text(view.root).includes('Unsupported App runtime target')).toBe(false);
      await click(view.root, 'Check link');
      await click(view.root, 'Install and share');
      expect(text(el(view.root, '.disc-panel [role="alert"]'))).toBe('peerd could not install Signed app.');
      expect(text(el(view.root, '.disc-panel .disc-hint'))).toBe('This browser cannot run it. Technical details says why.');
      expect(text(panel(view.root)).includes('do not match')).toBe(false);
      await click(view.root, 'Technical details');
      expect(facts(view.root).find(([label]) => label === 'Runtime')?.[1]).toBe('App runtime requirements do not match the signed version.');
    } finally { view.close(); sessionStorage.removeItem(KEY); }
  });

  it('an install that cannot keep its receipt sends nothing and says to reload', async () => {
    const host = fakeHost({ heard: [peerApp] }, { 'dweb/base/inspect-address': () => ({ ok: true, summary }) });
    const view = mount({ send: host.send });
    const original = Storage.prototype.setItem;
    try {
      await settle();
      await click(view.root, 'Paste link');
      enterLink(view.root, address);
      await click(view.root, 'Check link');
      Storage.prototype.setItem = () => { throw new Error('quota exceeded'); };
      await click(view.root, 'Install and share');
      Storage.prototype.setItem = original;
      expect(text(el(view.root, '.disc-panel [role="alert"]'))).toBe('peerd could not install Signed app.');
      expect(text(el(view.root, '.disc-panel .disc-hint'))).toBe('Reload the page, then try again.');
      expect(host.writes().map(call => call.type)).toEqual(['dweb/base/inspect-address']);
    } finally { Storage.prototype.setItem = original; view.close(); sessionStorage.removeItem(KEY); }
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
        await click(view.root, 'Check again');
        expect(text(panel(view.root))).toContain('peerd still cannot tell if the install finished.');
        expect(sessionStorage.getItem(KEY)).toBe(address);
        await click(view.root, 'Discover');
        expect(/** @type {HTMLInputElement} */ (el(view.root, '.disc-start-form input')).disabled).toBe(true);
        await click(view.root, 'Check link');
        exact = true;
        await click(view.root, 'Check again');
        expect(sessionStorage.getItem(KEY)).toBe(null);
        expect(button(panel(view.root), 'Open')?.disabled).toBe(false);
        expect(host.count('dweb/base/install-address')).toBe(1);
      } finally { view.close(); sessionStorage.removeItem(KEY); }
    });
  }

  it('a slow link check never replaces a page the user opened meanwhile; Check link runs it again', async () => {
    const slow = deferred();
    let hold = true;
    const host = fakeHost({ heard: [peerApp] }, {
      'dweb/base/inspect-address': () => hold ? slow.promise : { ok: true, summary },
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await click(view.root, 'Paste link');
      enterLink(view.root, address);
      await click(view.root, 'Check link');
      await openTile(view.root, 'peer');
      hold = false;
      slow.resolve({ ok: true, summary }); await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('Peer app');
      await click(view.root, 'Discover');
      expect(/** @type {HTMLInputElement} */ (el(view.root, '.disc-start-form input')).value).toBe(address);
      await click(view.root, 'Check link');
      expect(text(el(view.root, '.disc-app-title'))).toBe('Signed app');
      expect(host.count('dweb/base/inspect-address')).toBe(2);
      expect(host.count('dweb/base/install-address')).toBe(0);
    } finally { slow.resolve({ ok: false }); view.close(); }
  });

  it('a failed share-link install keeps the preview; Try again sends the install again, never a new check', async () => {
    /** @type {unknown[]} */ const replies = [{ ok: false, error: 'raw host install text' }, { ok: true, app: { id: 'app-link' } }];
    const host = fakeHost({ heard: [peerApp] }, {
      'dweb/base/inspect-address': () => ({ ok: true, summary }),
      'dweb/base/install-address': () => replies.shift(),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await click(view.root, 'Paste link');
      enterLink(view.root, address);
      await click(view.root, 'Check link');
      await click(view.root, 'Install and share');
      expect(text(el(view.root, '.disc-panel [role="alert"]'))).toBe('peerd could not install Signed app.');
      expect(text(el(view.root, '.disc-panel .disc-hint'))).toBe('The person who shares it may have gone offline. Try again in a moment.');
      expect(text(view.root).includes('raw host install text')).toBe(false);
      expect(text(el(view.root, '.disc-app-title'))).toBe('Signed app');
      expect(sessionStorage.getItem(KEY)).toBe(null);
      await click(view.root, 'Try again');
      expect(host.count('dweb/base/install-address')).toBe(2);
      expect(host.count('dweb/base/inspect-address')).toBe(1);
      expect(button(panel(view.root), 'Open')?.disabled).toBe(false);
    } finally { view.close(); sessionStorage.removeItem(KEY); }
  });

  it('a share-link install moves focus to the installed line, never to Open, and offers Go to Library', async () => {
    const host = fakeHost({ heard: [peerApp] }, {
      'dweb/base/inspect-address': () => ({ ok: true, summary }),
      'dweb/base/install-address': () => ({ ok: true, app: { id: 'app-link' } }),
    });
    let library = 0;
    const view = mount({ send: host.send, onLibrary: () => { library++; } });
    try {
      await settle();
      await click(view.root, 'Paste link');
      enterLink(view.root, address);
      await click(view.root, 'Check link');
      // The page opens after peerd checked every file, so What to know says so.
      expect(text(el(view.root, '.disc-safety-text'))).toBe(`Made by ${shortKey(ANA)}. peerd checked that this is exactly the app its maker shared. Nobody reviewed it for safety.`);
      expect(text(el(view.root, '.disc-panel-cta .disc-footnote'))).toBe('Sharing means other people can get this app from you while your peer network is on.');
      await press(view.root, 'Install and share');
      expect(document.activeElement).toBe(view.root.querySelector('.disc-panel .disc-installed'));
      expect(text(el(view.root, '.disc-panel .disc-installed')))
        .toBe('Installed. Signed app is now in your Library. Other people can get it from you while your peer network is on.');
      expect(text(el(view.root, '.disc-app-size'))).toBe('In your Library');
      expect([...el(view.root, '.disc-panel-actions').querySelectorAll('button')].map(node => text(node).trim())).toEqual(['Open', 'Go to Library']);
      await click(view.root, 'Go to Library');
      expect(library).toBe(1);
      expect(host.count('apps/open')).toBe(0);
      // A new check of the same link says where the app is, not that this check installed it.
      host.state.library = [{ id: 'app-link', dweb: { uri: target.uri, hash: target.hash, publisher: target.publisher } }];
      await click(view.root, 'Discover');
      await click(view.root, 'Paste link');
      await click(view.root, 'Check link');
      expect(text(el(view.root, '.disc-panel .disc-installed'))).toBe('In your Library. Other people can get it from you while your peer network is on.');
      expect(host.count('dweb/base/install-address')).toBe(1);
    } finally { view.close(); sessionStorage.removeItem(KEY); }
  });

  it('a failed Open on the share-link page says what the app page says', async () => {
    /** @type {unknown[]} */ const opens = [{ ok: false, outcomeKnown: true }, { ok: false, outcomeKnown: false }];
    const host = fakeHost({ heard: [peerApp] }, {
      'dweb/base/inspect-address': () => ({ ok: true, summary }),
      'dweb/base/install-address': () => ({ ok: true, app: { id: 'app-link' } }),
      'apps/open': () => { if (opens.length) return opens.shift(); throw new Error('renderer deadline'); },
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await click(view.root, 'Paste link');
      enterLink(view.root, address);
      await click(view.root, 'Check link');
      await click(view.root, 'Install and share');
      await click(view.root, 'Open');
      expect(text(el(view.root, '.disc-panel [role="alert"]'))).toBe(OPEN_FAILED);
      expect(el(view.root, '.disc-panel [role="alert"]').classList.contains('error')).toBe(true);
      // An admitted failure or a lost reply can leave the App open.
      for (const expectedCount of [2, 3]) {
        await click(view.root, 'Open');
        expect(text(panel(view.root))).toContain('peerd is not sure the app opened. Check your tabs.');
        expect(panel(view.root).querySelector('.error')).toBe(null);
        expect([...panel(view.root).querySelectorAll('[role="status"]')].some(node => text(node) === 'peerd is not sure the app opened. Check your tabs.')).toBe(true);
        expect(host.count('apps/open')).toBe(expectedCount);
      }
    } finally { view.close(); sessionStorage.removeItem(KEY); }
  });

  for (const outcome of /** @type {const} */ (['installed', 'failed'])) {
    it(`a share-link install keeps going across a remount, and the next view shows it ${outcome}`, async () => {
      const install = deferred();
      const host = fakeHost({ heard: [peerApp] }, {
        'dweb/base/inspect-address': () => ({ ok: true, summary }),
        'dweb/base/install-address': () => install.promise,
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
        expect(text(el(view.root, '.disc-panel [role="status"]:not(.disc-installed)'))).toBe(KEEPS_GOING);
        view.close();
        view = mount({ send: host.send, effects }, { keepReceipt: true });
        await settle();
        expect(text(el(view.root, '.disc-panel [role="status"]:not(.disc-installed)'))).toBe(KEEPS_GOING);
        expect(panel(view.root).querySelector('button')).toBe(null);
        install.resolve(outcome === 'installed' ? { ok: true, app: { id: 'app-link' } } : { ok: false, error: 'raw host install text' });
        await settle();
        expect(sessionStorage.getItem(KEY)).toBe(null);
        expect(text(view.root).includes(UNKNOWN_INSTALL)).toBe(false);
        if (outcome === 'installed') {
          expect(text(panel(view.root))).toContain('Installed. Unnamed app is now in your Library.');
          await click(view.root, 'Open');
          expect(host.writes().at(-1)).toEqual({ type: 'apps/open', appId: 'app-link' });
        } else {
          expect(text(el(view.root, '.disc-panel [role="alert"]'))).toBe('peerd could not install Unnamed app.');
          await click(view.root, 'Try again');
          expect(host.count('dweb/base/install-address')).toBe(2);
          await click(view.root, 'Discover');
          await click(view.root, 'Paste link');
          expect(/** @type {HTMLInputElement} */ (el(view.root, '.disc-start-form input')).disabled).toBe(false);
        }
        expect(host.count('dweb/base/inspect-address')).toBe(1);
      } finally { install.resolve({ ok: false }); view.close(); sessionStorage.removeItem(KEY); }
    });
  }

  it('Back during a share-link install says it keeps going; only an unknown outcome says it could not confirm', async () => {
    const install = deferred();
    const host = fakeHost({ heard: [peerApp] }, {
      'dweb/base/inspect-address': () => ({ ok: true, summary }),
      'dweb/base/install-address': () => install.promise,
    });
    const view = mount({ send: host.send });
    const status = () => text(el(view.root, '.disc-start-row.is-open [role="status"]'));
    try {
      await settle();
      await click(view.root, 'Paste link');
      enterLink(view.root, address);
      await click(view.root, 'Check link');
      await click(view.root, 'Install and share');
      await click(view.root, 'Discover');
      expect(status()).toBe(KEEPS_GOING);
      install.resolve({ ok: false, outcomeKnown: false }); await settle();
      expect(status()).toBe(RECEIPT_HELD);
      // The row explains the held receipt, so it cannot be closed.
      expect(button(view.root, 'Cancel')).toBe(undefined);
      expect(host.count('dweb/base/install-address')).toBe(1);
    } finally { install.resolve({ ok: false }); view.close(); sessionStorage.removeItem(KEY); }
  });

  // dweb/base/install has no uri dedupe, so a second install would add a second copy.
  for (const outcome of /** @type {const} */ (['installed', 'unknown'])) {
    it(`a share-link install holds the heard page of the same app, which never sends a second install (${outcome})`, async () => {
      const same = card('same', 'Same app', ANA, { version_id: target.hash });
      const record = { id: 'app-link', dweb: { uri: target.uri, hash: target.hash, publisher: target.publisher } };
      const install = deferred();
      // A Library read that starts before the commit answers with the Library as it was.
      const early = deferred();
      let hold = false;
      const host = fakeHost({ heard: [same] }, {
        'dweb/base/inspect-address': () => ({ ok: true, summary }),
        'dweb/base/install-address': () => install.promise,
        'apps/list': () => hold ? early.promise : { ok: true, apps: host.state.library },
      });
      const view = mount({ send: host.send });
      const earlyRead = async () => { hold = true; await focusPoll(); hold = false; host.state.library = [record]; };
      try {
        await settle();
        await openTile(view.root, 'same');
        // The heard page as drawn before the share-link install.
        const stale = /** @type {HTMLButtonElement} */ (button(view.root, 'Install and share'));
        expect(stale.disabled).toBe(false);
        await click(view.root, 'Discover');
        await click(view.root, 'Paste link');
        enterLink(view.root, address);
        await click(view.root, 'Check link');
        await click(view.root, 'Install and share');
        await click(view.root, 'Discover');
        expect(tileAction(view.root, 'same')).toBe('Installing…');
        await openTile(view.root, 'same');
        expect(text(el(view.root, '.disc-panel [role="status"]:not(.disc-installed)'))).toBe(KEEPS_GOING);
        expect(panel(view.root).querySelector('button')).toBe(null);
        stale.click(); await settle();
        expect(host.writes().map(call => call.type)).toEqual(['dweb/base/inspect-address', 'dweb/base/install-address']);
        if (outcome === 'installed') {
          await earlyRead();
          install.resolve({ ok: true, app: { id: 'app-link' } }); await settle();
        } else {
          install.resolve({ ok: false, outcomeKnown: false }); await settle();
          expect(text(el(view.root, '.disc-panel [role="status"]:not(.disc-installed)'))).toBe(UNKNOWN_INSTALL);
          await click(view.root, 'Check again');
          expect(text(el(view.root, '.disc-panel [role="status"]:not(.disc-installed)'))).toBe(UNKNOWN_INSTALL);
          expect(button(view.root, 'Install and share')).toBe(undefined);
          // The share-link Refresh finds the exact receipt.
          await earlyRead();
          await click(view.root, 'Discover');
          await click(view.root, 'Check link');
          await click(view.root, 'Check again');
          await click(view.root, 'Discover');
          await openTile(view.root, 'same');
        }
        // The early read has not landed, and the heard page shows the app at once.
        expect(text(el(view.root, '.disc-panel .disc-installed')))
          .toBe('In your Library. Other people can get it from you while your peer network is on.');
        expect(button(panel(view.root), 'Open')?.disabled).toBe(false);
        stale.click(); await settle();
        // It lands with the Library as it was. A fresh read follows it, so
        // the tile stays Open when the link is cleared.
        early.resolve({ ok: true, apps: [] }); await settle();
        await click(view.root, 'Discover');
        // Back from a link page with no receipt left closes the share row.
        if (outcome === 'unknown') await click(view.root, 'Paste link');
        enterLink(view.root, '');
        expect(tileAction(view.root, 'same')).toBe('Open');
        expect(host.count('dweb/base/install')).toBe(0);
        expect(host.count('dweb/base/install-address')).toBe(1);
      } finally { install.resolve({ ok: false }); early.resolve({ ok: false }); view.close(); sessionStorage.removeItem(KEY); }
    });
  }

  // The mirror: dweb/base/install-address does not see a heard install or
  // update that runs or stays unconfirmed, so a second install would add a
  // second copy. Once it settles, the page says what its app page says.
  for (const effect of /** @type {const} */ (['an install', 'an unknown install', 'an update', 'an unknown update'])) {
    it(`${effect} from the heard page holds the share-link page of that version, which never sends a second install`, async () => {
      const update = effect.endsWith('update');
      const unknown = effect.includes('unknown');
      const same = card('same', 'Same app', ANA, { version_id: target.hash, seq: 2 });
      const type = update ? 'dweb/base/update-app' : 'dweb/base/install';
      const appId = update ? 'local-same' : 'app-same';
      const reply = deferred();
      // A Library read that starts after the effect settles, held so the page shows the receipt alone.
      const read = deferred();
      let hold = false;
      const host = fakeHost({
        heard: [same], library: update ? [local(appId, same, { uri: 'peerd://older', version_id: 'same-v1', seq: 1 })] : [],
      }, {
        'dweb/base/inspect-address': () => ({ ok: true, summary }), [type]: () => reply.promise,
        'apps/list': () => hold ? read.promise : { ok: true, apps: host.state.library },
        'apps/open': () => ({ ok: true }),
      });
      const view = mount({ send: host.send });
      const IN_LIBRARY = 'In your Library. Other people can get it from you while your peer network is on.';
      const installed = () => text(el(view.root, '.disc-panel .disc-installed'));
      try {
        await settle();
        await click(view.root, 'Paste link');
        enterLink(view.root, address);
        await click(view.root, 'Check link');
        // The share-link page as drawn before the heard effect.
        const stale = /** @type {HTMLButtonElement} */ (button(view.root, 'Install and share'));
        expect(stale.disabled).toBe(false);
        await click(view.root, 'Discover');
        await openTile(view.root, 'same');
        await click(view.root, update ? 'Update' : 'Install and share');
        if (unknown) { reply.resolve({ ok: false, outcomeKnown: false }); await settle(); }
        await click(view.root, 'Discover');
        await click(view.root, 'Paste link');
        await click(view.root, 'Check link');
        const message = unknown ? `peerd is not sure the ${update ? 'update' : 'install'} finished. It may still finish by itself.`
          : `You can leave this page. The ${update ? 'update' : 'install'} keeps going.`;
        expect(text(el(view.root, '.disc-panel [role="status"]:not(.disc-installed)'))).toBe(message);
        expect(button(view.root, 'Install and share')).toBe(undefined);
        stale.click(); await settle();
        if (unknown) {
          // Refresh reads the Library again. It does not hold this version yet.
          const reads = host.count('apps/list');
          await click(view.root, 'Check again');
          expect(host.count('apps/list')).toBeGreaterThan(reads);
          expect(text(el(view.root, '.disc-panel [role="status"]:not(.disc-installed)'))).toBe(message);
          expect(button(view.root, 'Install and share')).toBe(undefined);
        }
        expect(host.writes().map(call => call.type)).toEqual(['dweb/base/inspect-address', type, 'dweb/base/inspect-address']);
        if (unknown) {
          // Refresh finds this version in the Library.
          host.state.library = [local(appId, same)];
          await click(view.root, 'Check again');
        } else {
          hold = true;
          reply.resolve(update ? { ok: true } : { ok: true, app: { id: appId } }); await settle();
          // No Library read shows it yet. The receipt of the effect says it is there.
          expect(installed()).toBe(IN_LIBRARY);
          expect(button(view.root, 'Install and share')).toBe(undefined);
          hold = false;
          host.state.library = [local(appId, same)];
          read.resolve({ ok: true, apps: host.state.library }); await settle();
        }
        expect(installed()).toBe(IN_LIBRARY);
        expect(button(view.root, 'Install and share')).toBe(undefined);
        await click(view.root, 'Open');
        expect(host.writes().slice(3)).toEqual([{ type: 'apps/open', appId }]);
      } finally { reply.resolve({ ok: false }); read.resolve({ ok: false }); view.close(); sessionStorage.removeItem(KEY); }
    });
  }

  for (const action of /** @type {const} */ (['install', 'update'])) {
    it(`a heard ${action} keeps its target and receipt across a remount with no heard card`, async () => {
      const same = card('same', 'Same app', ANA, { version_id: target.hash, seq: 2 });
      const type = action === 'update' ? 'dweb/base/update-app' : 'dweb/base/install';
      const appId = 'local-same';
      const reply = deferred();
      const host = fakeHost({
        heard: [same], library: action === 'update' ? [local(appId, same, { uri: 'peerd://older', version_id: 'same-v1', seq: 1 })] : [],
      }, { 'dweb/base/inspect-address': () => ({ ok: true, summary }), [type]: () => reply.promise, 'apps/open': () => ({ ok: true }) });
      const effects = createEffects();
      let view = mount({ send: host.send, effects });
      try {
        await settle();
        await openTile(view.root, 'same');
        await click(view.root, action === 'update' ? 'Update' : 'Install and share');
        view.close();
        host.state.heard = [];
        view = mount({ send: host.send, effects });
        await settle();
        await click(view.root, 'Paste link');
        enterLink(view.root, address);
        await click(view.root, 'Check link');
        expect(text(panel(view.root))).toContain(`You can leave this page. The ${action} keeps going.`);
        expect(button(view.root, 'Install and share')).toBe(undefined);
        // A failed heard read must not release the shared target either.
        host.state.heardFails = true;
        await focusPoll();
        expect(button(view.root, 'Install and share')).toBe(undefined);
        reply.resolve(action === 'update' ? { ok: true } : { ok: true, app: { id: appId } });
        await settle();
        // The closed view's read is ignored. The receipt still prevents a
        // second install before this mounted view reads the Library again.
        expect(text(panel(view.root))).toContain('In your Library.');
        expect(button(view.root, 'Install and share')).toBe(undefined);
        await click(view.root, 'Open');
        expect(host.writes().at(-1)).toEqual({ type: 'apps/open', appId });
        expect(host.count('dweb/base/install-address')).toBe(0);
        host.state.library = [local(appId, same)];
        await focusPoll();
        expect(effects.committed.size).toBe(0);
        expect(text(panel(view.root))).toContain('In your Library.');
      } finally { reply.resolve({ ok: false }); view.close(); sessionStorage.removeItem(KEY); }
    });
  }

  it('a failed install is stale once the Library holds this version: the tile and page say Open, and Try again never sends an update', async () => {
    const same = card('same', 'Same app', ANA, { version_id: target.hash });
    const host = fakeHost({ heard: [same] }, {
      'dweb/base/install': () => ({ ok: false, error: 'raw host install text' }),
      'dweb/base/inspect-address': () => ({ ok: true, summary }),
      'dweb/base/install-address': () => {
        host.state.library = [{ id: 'app-link', dweb: { uri: target.uri, hash: target.hash, publisher: target.publisher } }];
        return { ok: true, app: { id: 'app-link' } };
      },
      'apps/open': () => ({ ok: true }),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, 'same');
      await click(view.root, 'Install and share');
      expect(button(view.root, 'Try again')).toBeTruthy();
      // The same version then arrives from its share link.
      await click(view.root, 'Discover');
      await click(view.root, 'Paste link');
      enterLink(view.root, address);
      await click(view.root, 'Check link');
      await click(view.root, 'Install and share');
      await click(view.root, 'Discover');
      expect(tileAction(view.root, 'same')).toBe('Open');
      await openTile(view.root, 'same');
      expect(text(el(view.root, '.disc-panel .disc-installed'))).toContain('In your Library.');
      expect(view.root.querySelector('.disc-panel [role="alert"]')).toBe(null);
      expect(button(view.root, 'Try again')).toBe(undefined);
      await click(view.root, 'Open');
      expect(host.writes().map(call => call.type)).toEqual(['dweb/base/install', 'dweb/base/inspect-address', 'dweb/base/install-address', 'apps/open']);
    } finally { view.close(); sessionStorage.removeItem(KEY); }
  });

  it('Check link says it is checking while the app downloads; Cancel and Escape close the row and return focus to Paste link', async () => {
    const slow = deferred();
    const host = fakeHost({ heard: [peerApp] }, { 'dweb/base/inspect-address': () => slow.promise });
    const view = mount({ send: host.send });
    const status = () => view.root.querySelector('.disc-start-row.is-open [role="status"]');
    try {
      await settle();
      await click(view.root, 'Paste link');
      const idleStatus = el(view.root, '.disc-start-row.is-open [role="status"]');
      expect(idleStatus.textContent).toBe('');
      enterLink(view.root, address);
      await click(view.root, 'Check link');
      expect(status()).toBe(idleStatus);
      expect(text(idleStatus)).toBe('Checking the link. peerd downloads the app and checks every file…');
      // Cancel while the check runs: the row closes, and the late result opens nothing.
      await press(view.root, 'Cancel');
      expect(view.root.querySelector('.disc-start-form')).toBe(null);
      expect(document.activeElement).toBe(view.root.querySelector('[data-paste-link]'));
      slow.resolve({ ok: true, summary }); await settle();
      expect(view.root.querySelector('.disc-back')).toBe(null);
      // Escape in the link input closes the row too, and keeps the typed link.
      await click(view.root, 'Paste link');
      const input = /** @type {HTMLInputElement} */ (el(view.root, '.disc-start-form input'));
      expect(input.value).toBe(address);
      expect(status()?.textContent).toBe('');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle();
      expect(view.root.querySelector('.disc-start-form')).toBe(null);
      expect(document.activeElement).toBe(view.root.querySelector('[data-paste-link]'));
      expect(host.count('dweb/base/inspect-address')).toBe(1);
    } finally { slow.resolve({ ok: false }); view.close(); }
  });

  it('a version the Library gains while the share-link page is open shows as installed, and Open opens that copy', async () => {
    const host = fakeHost({ heard: [peerApp] }, {
      'dweb/base/inspect-address': () => ({ ok: true, summary }),
      'apps/open': () => ({ ok: true }),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await click(view.root, 'Paste link');
      enterLink(view.root, address);
      await click(view.root, 'Check link');
      expect(button(view.root, 'Install and share')?.disabled).toBe(false);
      // Another tab installs this version. No heard card names it.
      host.state.library = [{ id: 'app-other', dweb: { uri: target.uri, hash: target.hash, publisher: target.publisher } }];
      await focusPoll();
      expect(text(el(view.root, '.disc-panel .disc-installed')))
        .toBe('In your Library. Other people can get it from you while your peer network is on.');
      expect(button(view.root, 'Install and share')).toBe(undefined);
      await click(view.root, 'Open');
      expect(host.writes()).toEqual([{ type: 'dweb/base/inspect-address', address }, { type: 'apps/open', appId: 'app-other' }]);
    } finally { view.close(); sessionStorage.removeItem(KEY); }
  });

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
      expect(text(el(view.root, '.disc-app-maker'))).toBe('Made by Ana, someone you know');
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
        .toBe(RECEIPT_HELD);
      expect(/** @type {HTMLInputElement} */ (el(view.root, '.disc-start-form input')).disabled).toBe(true);
      expect(button(view.root, 'Check link')?.disabled).toBe(true);
      expect(text(view.root)).toContain('Turn on the peer network first.');
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
      expect(text(el(view.root, '[data-key="a"] .disc-tile-meta'))).toBe('Made by Ana, someone you know');
      expect(text(el(view.root, '[data-key="b"] .disc-tile-meta'))).toBe(`Made by ${shortKey(BOB)}`);
      expect(text(el(view.root, '[data-key="c"] .disc-tile-meta'))).toBe(`Made by ${shortKey(CARL)}`);
      expect(text(view.root).includes('Bob the Builder')).toBe(false);
      expect(text(view.root).includes('Twin')).toBe(false);
      await openTile(view.root, 'b');
      expect(text(el(view.root, '.disc-app-maker'))).toBe(`Made by ${shortKey(BOB)}`);
      expect(el(view.root, '.disc-app-maker .type-code')).toBeTruthy();
    } finally { view.close(); }
  });

  it('a right-to-left contact name and a short key sit in <bdi> wherever text follows them', async () => {
    const rtl = 'שרה';
    const host = fakeHost({
      heard: [card('a', 'Ana app', ANA, { size: 48213 }), card('b', 'Bob app', BOB, { size: 1000 })],
      contacts: [{ did: ANA, name: rtl, saved: true }],
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(text(el(view.root, '[data-key="a"] .disc-tile-meta'))).toBe(`Made by ${rtl}, someone you know · 48 KB`);
      expect(text(el(view.root, '[data-key="a"] .disc-tile-meta bdi'))).toBe(rtl);
      expect(text(el(view.root, '[data-key="b"] .disc-tile-meta bdi.type-code'))).toBe(shortKey(BOB));
      await openTile(view.root, 'a');
      expect(text(el(view.root, '.disc-app-maker bdi'))).toBe(rtl);
      await click(view.root, `Made by ${rtl}, someone you know`);
      expect(text(el(view.root, '.disc-section--tight .type-label-strong bdi'))).toBe(rtl);
      // The page names the maker, so its rows say only the size.
      expect(text(el(view.root, 'li.disc-app-row .type-small'))).toBe('48 KB');
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
      await click(view.root, 'Made by Ana, someone you know');
      expect(host.count('contacts/list')).toBe(contactsBefore + 1);
      expect(document.activeElement).toBe(view.root.querySelector('.disc-back'));
      expect(text(el(view.root, '.disc-person-head h2'))).toBe('Ana');
      expect(view.root.querySelector('.disc-person-head h2 .type-code')).toBe(null);
      expect(text(view.root)).toContain('Someone you know. You saved this name on this device.');
      expect(text(view.root)).toContain('Apps from Ana');
      expect([...view.root.querySelectorAll('li.disc-app-row')].map(row => row.getAttribute('data-key')).sort()).toEqual(['a1', 'a2']);
      await click(view.root, 'Technical details');
      expect(facts(view.root)).toEqual([['Made by', `${ANA}Copy`]]);
      expect(tileAction(view.root, 'a2')).toBe('Look at it');
      el(view.root, '[data-key="a2"] .disc-tile-action').click(); await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('Budget board');

      await click(view.root, 'Discover');
      await openTile(view.root, 'c');
      el(view.root, '.disc-app-maker').click(); await settle();
      expect(text(el(view.root, '.disc-person-head h2'))).toBe(shortKey(CARL));
      // A short key keeps the code style it has in "Made by".
      expect(text(el(view.root, '.disc-person-head h2 bdi.type-code'))).toBe(shortKey(CARL));
      expect(text(el(view.root, '.disc-section--tight .type-label-strong bdi.type-code'))).toBe(shortKey(CARL));
      expect(text(el(view.root, '.disc-person-id .type-small'))).toBe('You have not saved a name for this maker.');
      expect(text(view.root).includes('Someone you know')).toBe(false);
      expect(host.writes().length).toBe(0);
    } finally { view.close(); }
  });

  it('Back on a maker page returns to the page that opened it and names it; its Back then goes to Discover', async () => {
    const link = formatDwappUri({ did: ANA, hash: 'd'.repeat(64) });
    const host = fakeHost({ heard: [card('a', 'Expense splitter', ANA)], contacts: [{ did: ANA, name: 'Ana', saved: true }] }, {
      'dweb/base/inspect-address': () => ({ ok: true, summary: { ...immutableAppRoot(link), name: 'Linked app', decodedBytes: 3, fileCount: 1, entryFile: 'index.html', containsWasm: false } }),
    });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, 'a');
      await press(view.root, 'Made by Ana, someone you know');
      const back = el(view.root, '.disc-back');
      expect(text(back).trim()).toBe('Expense splitter');
      expect(text(el(back, 'bdi'))).toBe('Expense splitter');
      await press(view.root, 'Expense splitter');
      expect(text(el(view.root, '.disc-app-title'))).toBe('Expense splitter');
      expect(document.activeElement).toBe(view.root.querySelector('.disc-app-maker'));
      expect(text(el(view.root, '.disc-back')).trim()).toBe('Discover');
      await click(view.root, 'Discover');
      expect(document.activeElement).toBe(view.root.querySelector('[data-key="a"] .disc-tile-open'));
      // The share-link page works the same way.
      await click(view.root, 'Paste link');
      enterLink(view.root, link);
      await click(view.root, 'Check link');
      await click(view.root, 'Made by Ana, someone you know');
      await click(view.root, 'Linked app');
      expect(text(el(view.root, '.disc-app-title'))).toBe('Linked app');
      expect(host.writes().map(call => call.type)).toEqual(['dweb/base/inspect-address']);
    } finally { view.close(); }
  });

  it('a maker with no app that peers share gets one line in place of the list', async () => {
    const host = fakeHost({ heard: [card('a', 'Ana app', ANA)] });
    const view = mount({ send: host.send });
    try {
      await settle();
      await openTile(view.root, 'a');
      // The card leaves the heard list; its page stays open.
      host.state.heard = [];
      await focusPoll();
      await click(view.root, `Made by ${shortKey(ANA)}`);
      expect(text(el(view.root, '.disc-section--tight .type-label-strong'))).toBe(`Apps from ${shortKey(ANA)}`);
      expect(view.root.querySelector('ul.disc-app-list')).toBe(null);
      expect(text(el(view.root, '.disc-section--tight p'))).toBe(MAKER_EMPTY);
      host.state.heard = [card('a', 'Ana app', ANA)];
      await focusPoll();
      expect([...view.root.querySelectorAll('li.disc-app-row')].map(row => row.getAttribute('data-key'))).toEqual(['a']);
      expect(text(view.root).includes(MAKER_EMPTY)).toBe(false);
    } finally { view.close(); }
  });

  it('the maker page lists 96 apps and adds 96 per Show more, as the grid does', async () => {
    const heard = Array.from({ length: 100 }, (_, i) => card(`ana-${i}`, `Ana app ${i}`, ANA));
    const host = fakeHost({ heard, contacts: [{ did: ANA, name: 'Ana', saved: true }] });
    const view = mount({ send: host.send });
    try {
      await settle();
      const [first, second] = /** @type {string[]} */ (tileKeys(view.root));
      await openTile(view.root, first);
      await click(view.root, 'Made by Ana, someone you know');
      expect(view.root.querySelectorAll('li.disc-app-row').length).toBe(96);
      await click(view.root, 'Show more');
      expect(view.root.querySelectorAll('li.disc-app-row').length).toBe(100);
      expect(button(view.root, 'Show more')).toBe(undefined);
      // Another visit to the page starts from the first 96 again.
      await click(view.root, `Ana app ${first.slice('ana-'.length)}`);
      await click(view.root, 'Discover');
      await openTile(view.root, second);
      await click(view.root, 'Made by Ana, someone you know');
      expect(view.root.querySelectorAll('li.disc-app-row').length).toBe(96);
      expect(host.writes().length).toBe(0);
    } finally { view.close(); }
  });

  it('search finds the saved name a tile shows, and a contact saved after mount shows on the next focus', async () => {
    const host = fakeHost({ heard: [card('a', 'Expense splitter', ANA), card('b', 'Trip planner', BOB)] });
    const view = mount({ send: host.send });
    try {
      await settle();
      expect(text(el(view.root, '[data-key="a"] .disc-tile-meta'))).toBe(`Made by ${shortKey(ANA)}`);
      // Saved in another Home tab: the next return to this tab shows it.
      host.state.contacts = [{ did: ANA, name: 'Ana', saved: true }];
      await focusPoll();
      expect(text(el(view.root, '[data-key="a"] .disc-tile-meta'))).toBe('Made by Ana, someone you know');
      search(view.root, 'ana');
      expect(tileKeys(view.root)).toEqual(['a']);
      await click(view.root, 'From people you know');
      expect(tileKeys(view.root)).toEqual(['a']);
      expect(host.writes().length).toBe(0);
    } finally { view.close(); }
  });

  it('offline, the maker page lists the Library apps of the maker with Open, and a heard app page offers no Install', async () => {
    const installed = card('a', 'Ana app', ANA);
    const host = fakeHost({
      heard: [card('a', 'Ana app', ANA, { version_id: 'a-v2', seq: 2 }), card('n', 'New Ana app', ANA), card('m', 'Other Ana app', ANA)],
      library: [local('lib-a', installed)], contacts: [{ did: ANA, name: 'Ana', saved: true }],
    }, { 'dweb/base/install': () => ({ ok: false, error: 'raw host install text' }), 'apps/open': () => ({ ok: true }) });
    const view = mount({ send: host.send });
    const rows = () => [...view.root.querySelectorAll('li.disc-app-row')].map(row => row.getAttribute('data-key'));
    try {
      await settle();
      await openTile(view.root, 'n');
      await click(view.root, 'Install and share');
      expect(button(view.root, 'Try again')?.disabled).toBe(false);
      // The heard read fails while the network is offline, so the heard cards stay in memory.
      host.state.running = false;
      host.state.heardFails = true;
      await focusPoll();
      expect(button(view.root, 'Try again')?.disabled).toBe(true);
      expect(text(panel(view.root))).toContain('New apps need the peer network.');
      await click(view.root, 'Made by Ana, someone you know');
      expect(rows()).toEqual(['a']);
      expect(text(el(view.root, '[data-key="a"] .disc-app-row-action'))).toBe('Open');
      el(view.root, '[data-key="a"] .disc-tile-action').click(); await settle();
      expect(host.writes().at(-1)).toEqual({ type: 'apps/open', appId: 'lib-a' });
      // A card heard before the network went off: its page says what it waits for.
      await click(view.root, 'New Ana app');
      await click(view.root, 'Discover');
      view.set({ openKey: 'm' }); await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('Other Ana app');
      expect(button(view.root, 'Install and share')?.disabled).toBe(true);
      expect(text(panel(view.root))).toContain('New apps need the peer network.');
      // The other offline shape: the host answers with no heard cards. The Library still names the maker's apps.
      host.state.heardFails = false;
      host.state.heard = [];
      await focusPoll();
      await click(view.root, 'Discover');
      await openTile(view.root, 'a');
      await click(view.root, 'Made by Ana, someone you know');
      expect(rows()).toEqual(['a']);
      expect(host.count('dweb/base/install')).toBe(1);
    } finally { view.close(); }
  });

  it('long peer text wraps inside maker rows, tiles and the app page at a narrow width, never under the action', async () => {
    const token = 'x'.repeat(92);
    const long = card('long', 'A'.repeat(64), ANA, { description: `${token} short tail` });
    const contact = 'B'.repeat(40);
    // A Library app with a long name too, for the Your apps row.
    const host = fakeHost({ heard: [long, card('b', 'Chess clock', BOB)], contacts: [{ did: ANA, name: contact, saved: true }],
      library: [{ id: 'lib-long', name: 'C'.repeat(80) }] });
    const links = ['/sidepanel/styles.css', '/options/options.css', '/home/home.css'].map(href => {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = href;
      return link;
    });
    const wrap = document.createElement('div');
    wrap.className = 'home-content';
    wrap.style.cssText = 'width:320px;box-sizing:border-box;overflow:auto';
    document.body.append(wrap);
    const view = mount({ send: host.send }, { parent: wrap });
    const fits = () => wrap.scrollWidth <= wrap.clientWidth;
    /** The box of the text itself, which can run past its element. @param {Element} node */
    const textRight = (node) => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().right; };
    try {
      await Promise.all(links.map(link => new Promise((resolve, reject) => { link.onload = resolve; link.onerror = reject; document.head.append(link); })));
      await settle();
      expect(view.root.querySelector('.disc-yours-item')).toBeTruthy();
      expect(fits()).toBe(true);
      await openTile(view.root, 'long');
      expect(fits()).toBe(true);
      await click(view.root, `Made by ${contact}, someone you know`);
      const row = el(view.root, '[data-key="long"]');
      const action = el(row, '.disc-app-row-action').getBoundingClientRect().left;
      for (const part of row.querySelectorAll('.disc-app-row-id > *')) expect(textRight(part) <= action).toBe(true);
      expect(fits()).toBe(true);
    } finally { view.close(); wrap.remove(); for (const link of links) link.remove(); }
  });
});

describe('home.discover keyboard focus', () => {
  const address = formatDwappUri({ did: ANA, hash: 'a'.repeat(64) });

  it('Turn on lands focus on the heading of the new root', async () => {
    const save = deferred();
    // The lease is still starting, as it is right after the choice, so the looking root stays.
    const host = fakeHost({ lease: 'starting' }, {
      'settings/update': () => save.promise,
      'state/get': () => ({ ok: true, state: { settings: { dwebChoiceMade: true, dwebEnabled: true } } }),
    });
    const view = mount({ send: host.send, enabled: false, reconcileState: async () => {} });
    try {
      await settle();
      await pressOff(view.root, 'Turn on');
      // The button is off while the choice saves, so focus fell to the body.
      expect(document.activeElement).toBe(document.body);
      save.resolve({ ok: true }); await settle();
      // home.js turns the view on once the choice is saved.
      view.set({ enabled: true }); await settle();
      const heading = el(view.root, 'h1');
      expect(document.activeElement).toBe(heading);
      expect(heading.getAttribute('tabindex')).toBe('-1');
    } finally { save.resolve({ ok: false }); view.close(); }
  });

  it('Try again lands on itself while still offline, and on Refresh once connected', async () => {
    /** @type {unknown[]} */ const starts = [{ ok: false, error: 'signaling: websocket error' }, { ok: true }];
    const host = fakeHost({ heard: [card('a', 'App', ANA)], running: false }, { 'dweb/base/start': () => starts.shift() });
    const view = mount({ send: host.send });
    try {
      await settle();
      await press(view.root, 'Try again');
      expect(document.activeElement).toBe(button(view.root, 'Try again'));
      host.state.running = true;
      await press(view.root, 'Try again');
      expect(text(el(view.root, '.disc-status-live'))).toBe('Connected to 3 people');
      expect(document.activeElement).toBe(view.root.querySelector('.disc-refresh'));
      expect(host.count('dweb/base/start')).toBe(2);
    } finally { view.close(); }
  });

  it('a failed Check link returns focus to the link; Show more lands on the first new tile; Back to a missing tile lands on the heading', async () => {
    const heard = Array.from({ length: 100 }, (_, i) => card(`app-${i}`, `App ${i}`, ANA));
    const inspect = deferred();
    const host = fakeHost({ heard }, { 'dweb/base/inspect-address': () => inspect.promise });
    const view = mount({ send: host.send });
    try {
      await settle();
      await click(view.root, 'Paste link');
      enterLink(view.root, address);
      await pressOff(view.root, 'Check link');
      // The button is off while the check runs, so focus fell to the body.
      expect(document.activeElement).toBe(document.body);
      inspect.resolve({ ok: false }); await settle();
      expect(text(el(view.root, '.disc-start-row [role="alert"]'))).toContain('peerd could not check this app.');
      expect(document.activeElement).toBe(view.root.querySelector('.disc-start-form input'));
      await press(view.root, 'Show more');
      const keys = /** @type {string[]} */ (tileKeys(view.root));
      expect(keys.length).toBe(100);
      expect(document.activeElement).toBe(view.root.querySelector(`[data-key="${keys[96]}"] .disc-tile-open`));
      // Back from the page of a card that left the heard list meanwhile.
      await openTile(view.root, keys[0]);
      host.state.heard = heard.slice(1);
      await focusPoll();
      await click(view.root, 'Discover');
      expect(document.activeElement).toBe(el(view.root, 'h1'));
      // The maker page adds rows the same way.
      await openTile(view.root, keys[1]);
      await click(view.root, `Made by ${shortKey(ANA)}`);
      await press(view.root, 'Show more');
      const rows = [...view.root.querySelectorAll('li.disc-app-row')].map(row => row.getAttribute('data-key'));
      expect(rows.length).toBe(99);
      expect(document.activeElement).toBe(view.root.querySelector(`[data-key="${rows[96]}"] .disc-tile-open`));
      expect(host.writes().map(call => call.type)).toEqual(['dweb/base/inspect-address']);
    } finally { inspect.resolve({ ok: false }); view.close(); }
  });
});

describe('home.discover entry points', () => {
  it('openKey: a heard app opens from any page; one not heard yet waits for the next read, and any navigation drops it', async () => {
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

    // Already heard: the click opens that page at once from another app's
    // page, with no extra read.
    const shown = fakeHost({ heard: both() });
    view = mountKeyed(shown);
    try {
      await settle();
      await openTile(view.root, 'a');
      const reads = shown.count('dweb/base/heard');
      view.set({ openKey: 'b' }); await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('App B');
      expect(document.activeElement).toBe(view.root.querySelector('.disc-back'));
      expect(shown.count('dweb/base/heard')).toBe(reads);
      expect(cleared).toBe(3);
    } finally { view.close(); }

    // Not heard yet while on a sub-page: the first read after the click
    // answers it there too, and it hears the app.
    const sub = fakeHost({ heard: [card('a', 'App A', ANA)] });
    view = mountKeyed(sub);
    try {
      await settle();
      await openTile(view.root, 'a');
      sub.state.heard = both();
      view.set({ openKey: 'b' }); await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('App B');
      expect(document.activeElement).toBe(view.root.querySelector('.disc-back'));
      expect(cleared).toBe(4);
    } finally { view.close(); }

    // Not heard yet on the root: the bell can name a card heard after the
    // last poll, so the request starts its own read, which answers it.
    const mounted = fakeHost({ heard: [card('a', 'App A', ANA)] });
    view = mountKeyed(mounted);
    try {
      await settle();
      const reads = mounted.count('dweb/base/heard');
      mounted.state.heard = both();
      view.set({ openKey: 'b' }); await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('App B');
      expect(mounted.count('dweb/base/heard')).toBe(reads + 1);
      expect(cleared).toBe(5);
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
      expect(cleared).toBe(6);
    } finally { early.resolve({ ok: false }); view.close(); }

    // The user opens a page before that read lands: the request is dropped
    // right then, and their page stays when the read lands.
    const held = deferred();
    let hold = false;
    const slow = fakeHost({}, { 'dweb/base/heard': () => hold ? held.promise : { ok: true, apps: [card('a', 'App A', ANA)] } });
    view = mountKeyed(slow);
    try {
      await settle();
      hold = true;
      view.set({ openKey: 'b' }); await settle();
      expect(cleared).toBe(6);
      await openTile(view.root, 'a');
      expect(cleared).toBe(7);
      held.resolve({ ok: true, apps: both() }); await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('App A');
      expect(cleared).toBe(7);
    } finally { held.resolve({ ok: false }); view.close(); }

    const off = fakeHost({ heard: [card('a', 'App A', ANA)] });
    view = mountKeyed(off, { enabled: false, openKey: 'a' });
    try {
      await settle();
      expect(view.root.querySelector('.disc-back')).toBe(null);
      expect(off.calls.length).toBe(0);
      expect(cleared).toBe(7);
    } finally { view.close(); }
  });

  it('openKey: a failed first read after the click drops the request, so a later good read opens nothing', async () => {
    let cleared = 0;
    const host = fakeHost({ heard: [card('a', 'App A', ANA)] });
    /** @type {ReturnType<typeof mount>|null} */ let view = null;
    view = mount({ send: host.send, onOpenKey: () => { cleared++; if (view) view.attrs.openKey = null; } });
    try {
      await settle();
      host.state.heardFails = true;
      view.set({ openKey: 'b' }); await settle();
      expect(cleared).toBe(1);
      expect(view.root.querySelector('.disc-back')).toBe(null);
      host.state.heardFails = false;
      host.state.heard = [card('a', 'App A', ANA), card('b', 'App B', BOB)];
      await focusPoll();
      expect(tileKeys(view.root).sort()).toEqual(['a', 'b']);
      expect(view.root.querySelector('.disc-back')).toBe(null);
      expect(cleared).toBe(1);
    } finally { view.close(); }
  });

  it('openKey: with a share-link receipt held, a heard app opens from the restored page and the receipt stays', async () => {
    const address = formatDwappUri({ did: ANA, hash: 'a'.repeat(64) });
    let cleared = 0;
    const host = fakeHost({ heard: [card('b', 'App B', BOB)] });
    sessionStorage.setItem(KEY, address);
    /** @type {ReturnType<typeof mount>|null} */ let view = null;
    view = mount({
      send: host.send, openKey: 'b', onOpenKey: () => { cleared++; if (view) view.attrs.openKey = null; },
    }, { keepReceipt: true });
    try {
      await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('App B');
      expect(document.activeElement).toBe(view.root.querySelector('.disc-back'));
      expect(cleared).toBe(1);
      expect(sessionStorage.getItem(KEY)).toBe(address);
      // Back and Check link still reach the receipt, as before.
      await click(view.root, 'Discover');
      expect(text(el(view.root, '.disc-start-row.is-open [role="status"]'))).toBe(RECEIPT_HELD);
      await click(view.root, 'Check link');
      expect(text(el(view.root, '.disc-app-title'))).toBe('Unnamed app');
      expect(text(panel(view.root))).toContain(UNKNOWN_INSTALL);
      expect(host.writes().length).toBe(0);
    } finally { view.close(); sessionStorage.removeItem(KEY); }
  });

  it('openKey: a key heard by a read in flight before the request opens nothing after the user opens a page', async () => {
    const both = () => [card('a', 'App A', ANA), card('b', 'App B', BOB)];
    let cleared = 0;
    const early = deferred();
    const late = deferred();
    /** @type {unknown[]} */ const replies = [];
    const host = fakeHost({}, { 'dweb/base/heard': () => replies.length ? replies.shift() : { ok: true, apps: [card('a', 'App A', ANA)] } });
    /** @type {ReturnType<typeof mount>|null} */ let view = null;
    view = mount({ send: host.send, onOpenKey: () => { cleared++; if (view) view.attrs.openKey = null; } });
    try {
      await settle();
      replies.push(early.promise, late.promise);
      window.dispatchEvent(new Event('focus'));
      view.set({ openKey: 'b' });
      // The read in flight hears App B, but it started before the request.
      early.resolve({ ok: true, apps: both() }); await settle();
      expect(view.root.querySelector('.disc-back')).toBe(null);
      expect(cleared).toBe(0);
      await openTile(view.root, 'a');
      expect(cleared).toBe(1);
      expect(text(el(view.root, '.disc-app-title'))).toBe('App A');
      late.resolve({ ok: true, apps: both() }); await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('App A');
    } finally { early.resolve({ ok: false }); late.resolve({ ok: false }); view.close(); }
  });

  it('openKey: a read that lands before the next redraw keeps the page the user just opened', async () => {
    const held = deferred();
    let hold = false;
    let cleared = 0;
    const first = card('a', 'App A', ANA);
    const host = fakeHost({}, {
      'dweb/base/heard': () => hold ? held.promise : { ok: true, apps: [first] },
    });
    /** @type {ReturnType<typeof mount>|null} */ let view = null;
    view = mount({ send: host.send, onOpenKey: () => { cleared++; if (view) view.attrs.openKey = null; } });
    try {
      await settle();
      hold = true;
      view.set({ openKey: 'b' }); await settle();
      expect(cleared).toBe(0);
      // No redraw between this click and the reply: settleKey must check the route.
      el(view.root, '[data-key="a"] .disc-tile-open').click();
      held.resolve({ ok: true, apps: [first, card('b', 'App B', BOB)] });
      await settle();
      expect(text(el(view.root, '.disc-app-title'))).toBe('App A');
      expect(cleared).toBe(1);
    } finally { held.resolve({ ok: false }); view.close(); }
  });

  // A UI send throws when it times out or loses its transport.
  for (const [label, reply] of /** @type {const} */ ([
    ['an unknown reply', () => ({ ok: false, outcomeKnown: false })],
    ['a thrown send', () => { throw new Error('renderer deadline'); }],
  ])) {
    it(`Commons: Add and open waits for the Library; an unknown add (${label}) keeps its fence and neutral reason across pages and a remount`, async () => {
      const library = deferred();
      let gate = true;
      const host = fakeHost({ heard: [card('a', 'App', ANA)] }, {
        'apps/list': () => gate ? library.promise : { ok: true, apps: host.state.library },
        'dweb/open-commons': reply,
      });
      const effects = createEffects();
      let view = mount({ send: host.send, effects });
      // Neutral, not red: the add may still finish.
      /** @param {ReturnType<typeof mount>} current */
      const reason = (current) => {
        const line = commonsNote(current.root);
        return line ? [line.getAttribute('role'), line.classList.contains('error')] : null;
      };
      try {
        await settle();
        await click(view.root, 'Comes with peerd');
        expect(button(view.root, 'Add and open Commons')?.disabled).toBe(true);
        gate = false;
        library.resolve({ ok: true, apps: [] }); await settle();
        expect(button(view.root, 'Add and open Commons')?.disabled).toBe(false);
        await click(view.root, 'Add and open Commons');
        await until(() => host.count('dweb/open-commons') === 1 && !!commonsNote(view.root));
        expect(reason(view)).toEqual(['status', false]);
        const add = button(view.root, 'Add and open Commons');
        expect(add?.disabled).toBe(true);
        add?.click(); await settle();
        expect(host.count('dweb/open-commons')).toBe(1);
        // A page visit clears passing alerts, not the fence's reason.
        await click(view.root, 'All');
        await openTile(view.root, 'a');
        await click(view.root, 'Discover');
        await click(view.root, 'Comes with peerd');
        expect(reason(view)).toEqual(['status', false]);
        view.close();
        view = mount({ send: host.send, effects });
        await settle();
        await click(view.root, 'Comes with peerd');
        expect(reason(view)).toEqual(['status', false]);
        expect(button(view.root, 'Add and open Commons')?.disabled).toBe(true);
        // Commons in the catalog is the receipt: the fence and its reason go.
        host.state.library = [{ id: 'app-commons', dweb: { seed: 'commons' } }];
        await focusPoll();
        expect(commonsNote(view.root)).toBe(null);
        expect(effects.commons).toBe(null);
        expect(host.count('dweb/open-commons')).toBe(1);
      } finally { library.resolve({ ok: false }); view.close(); }
    });
  }

  it('Commons: Open sends apps/open; a Commons deleted elsewhere never turns a focused Open into an add', async () => {
    let openOutcome = 'ok';
    const installed = fakeHost({ heard: [card('a', 'App', ANA)], library: [{ id: 'app-commons', dweb: { seed: 'commons' } }] }, {
      'apps/open': () => {
        if (openOutcome === 'lost') throw new Error('renderer deadline');
        return { ok: openOutcome === 'ok', outcomeKnown: openOutcome !== 'unknown' };
      },
    });
    const second = mount({ send: installed.send });
    try {
      await settle();
      await click(second.root, 'Comes with peerd');
      expect(button(second.root, 'Add and open Commons')).toBe(undefined);
      // The tile's own Open; the Your apps row above it lists Commons too.
      const tileOpen = () => el(second.root, '[data-key="commons"]');
      await click(tileOpen(), 'Open');
      expect(installed.writes()).toEqual([{ type: 'apps/open', appId: 'app-commons' }]);
      openOutcome = 'failed';
      await click(tileOpen(), 'Open');
      expect(text(el(second.root, '[data-key="commons"] .error[role="alert"]'))).toBe('peerd could not open Commons. Try again.');
      for (openOutcome of ['unknown', 'lost']) {
        await click(tileOpen(), 'Open');
        expect(text(el(second.root, '[data-key="commons"] [role="status"]'))).toBe('peerd is not sure Commons opened. Check your tabs.');
        expect(el(second.root, '[data-key="commons"]').querySelector('.error')).toBe(null);
      }
      // Commons is deleted elsewhere while Open has focus: the add is a new
      // node, so a stray key press adds nothing.
      button(tileOpen(), 'Open')?.focus();
      installed.state.library = [];
      await focusPoll();
      expect(button(second.root, 'Add and open Commons')).toBeTruthy();
      expect(document.activeElement === button(second.root, 'Add and open Commons')).toBe(false);
    } finally { second.close(); }
  });

  it('Commons: a seed-load failure lifts the fence before any add is sent', async () => {
    const original = window.fetch;
    const host = fakeHost({ heard: [card('a', 'App', ANA)] });
    const effects = createEffects();
    const view = mount({ send: host.send, effects });
    Object.defineProperty(window, 'fetch', { configurable: true, writable: true,
      value: async (/** @type {RequestInfo|URL} */ input, /** @type {RequestInit|undefined} */ init) => String(input).includes('/peerd-distributed/apps/commons/')
        ? new Response('', { status: 500 }) : original(input, init),
    });
    try {
      await settle();
      await click(view.root, 'Comes with peerd');
      await click(view.root, 'Add and open Commons');
      await until(() => !!view.root.querySelector('[role="alert"]'));
      expect(text(el(view.root, '[data-key="commons"] [role="alert"]'))).toBe('peerd could not load Commons. Reload the page, then try again.');
      expect(effects.commons).toBe(null);
      expect(commonsNote(view.root)).toBe(null);
      expect(button(view.root, 'Add and open Commons')?.disabled).toBe(false);
      expect(host.count('dweb/open-commons')).toBe(0);
    } finally { window.fetch = original; view.close(); }
  });

  it('Commons: a settled refusal lifts the fence and says why; a remount during an add shows no reason until its outcome', async () => {
    /** @type {unknown[]} */ const replies = [{ ok: false, error: 'dweb-disabled' }];
    const later = deferred();
    const host = fakeHost({ heard: [card('a', 'App', ANA)] }, {
      'dweb/open-commons': () => replies.length ? replies.shift() : later.promise,
    });
    const effects = createEffects();
    let view = mount({ send: host.send, effects });
    try {
      await settle();
      await click(view.root, 'Comes with peerd');
      await click(view.root, 'Add and open Commons');
      await until(() => host.count('dweb/open-commons') === 1 && !!view.root.querySelector('[role="alert"]'));
      expect(text(el(view.root, '[data-key="commons"] [role="alert"]'))).toBe(COMMONS_FAILED);
      expect(commonsNote(view.root)).toBe(null);
      expect(effects.commons).toBe(null);
      expect(button(view.root, 'Add and open Commons')?.disabled).toBe(false);
      // The retry is still in flight when the user leaves and comes back.
      await click(view.root, 'Add and open Commons');
      await until(() => host.count('dweb/open-commons') === 2);
      view.close();
      view = mount({ send: host.send, effects });
      await settle();
      await click(view.root, 'Comes with peerd');
      expect(button(view.root, 'Opening…')?.disabled).toBe(true);
      expect(commonsNote(view.root)).toBe(null);
      later.resolve({ ok: false, outcomeKnown: false });
      await until(() => !!commonsNote(view.root));
      expect(button(view.root, 'Add and open Commons')?.disabled).toBe(true);
      expect(host.count('dweb/open-commons')).toBe(2);
    } finally { later.resolve({ ok: false }); view.close(); }
  });

  it('Commons: the fence starts before the seed loads, so a remount meanwhile offers no second add', async () => {
    const reply = deferred();
    const host = fakeHost({ heard: [card('a', 'App', ANA)] }, { 'dweb/open-commons': () => reply.promise });
    const effects = createEffects();
    let view = mount({ send: host.send, effects });
    try {
      await settle();
      await click(view.root, 'Comes with peerd');
      // The user leaves at once, while the seed still loads and nothing is sent.
      button(view.root, 'Add and open Commons')?.click();
      view.close();
      view = mount({ send: host.send, effects });
      await settle();
      await click(view.root, 'Comes with peerd');
      const add = button(view.root, 'Opening…');
      expect(add?.disabled).toBe(true);
      add?.click();
      await until(() => host.count('dweb/open-commons') === 1);
      reply.resolve({ ok: false, error: 'dweb-disabled' });
      await until(() => button(view.root, 'Add and open Commons')?.disabled === false);
      expect(host.count('dweb/open-commons')).toBe(1);
    } finally { reply.resolve({ ok: false }); view.close(); }
  });

  // The host creates Commons before it replies ok. A Library read that starts
  // after that reply and lists no Commons means the user deleted it since.
  it('Commons: a confirmed add lifts its fence on the first later Library read, so a Commons deleted meanwhile can be added again', async () => {
    const reply = deferred();
    const host = fakeHost({ heard: [card('a', 'App', ANA)] }, { 'dweb/open-commons': () => reply.promise });
    const effects = createEffects();
    let view = mount({ send: host.send, effects });
    try {
      await settle();
      await click(view.root, 'Comes with peerd');
      await click(view.root, 'Add and open Commons');
      await until(() => host.count('dweb/open-commons') === 1);
      // The user leaves while the add runs. It is confirmed, then Commons is deleted in the Library.
      view.close();
      reply.resolve({ ok: true, appId: 'app-commons' }); await settle();
      // The closed view's read is dropped, so the fence waits for the mounted view.
      expect(effects.commons).toBe('adding');
      view = mount({ send: host.send, effects });
      await settle();
      await click(view.root, 'Comes with peerd');
      expect(effects.commons).toBe(null);
      expect(button(view.root, 'Add and open Commons')?.disabled).toBe(false);
      await click(view.root, 'Add and open Commons');
      await until(() => host.count('dweb/open-commons') === 2);
    } finally { reply.resolve({ ok: false }); view.close(); }
  });

  it('Commons: a Library read that started before the add was confirmed cannot lift the fence', async () => {
    const first = deferred();
    const second = deferred();
    /** @type {Promise<unknown>[]} */ let held = [];
    const host = fakeHost({ heard: [card('a', 'App', ANA)] }, {
      'dweb/open-commons': () => ({ ok: true, appId: 'app-commons' }),
      'apps/list': () => held.length ? held.shift() : { ok: true, apps: host.state.library },
    });
    const effects = createEffects();
    const view = mount({ send: host.send, effects });
    try {
      await settle();
      await click(view.root, 'Comes with peerd');
      // A poll's read is in flight when the add is sent and confirmed.
      held = [first.promise, second.promise];
      await focusPoll();
      await click(view.root, 'Add and open Commons');
      await until(() => host.count('dweb/open-commons') === 1);
      // It lands with the Library as it was: no Commons yet, and the fence stays.
      first.resolve({ ok: true, apps: [] }); await settle();
      expect(effects.commons).toBe('adding');
      expect(button(view.root, 'Opening…')?.disabled).toBe(true);
      // The read that started after the reply is the receipt.
      second.resolve({ ok: true, apps: [{ id: 'app-commons', dweb: { seed: 'commons' } }] }); await settle();
      expect(effects.commons).toBe(null);
      expect(button(el(view.root, '[data-key="commons"]'), 'Open')?.disabled).toBe(false);
      expect(host.count('dweb/open-commons')).toBe(1);
    } finally { first.resolve({ ok: false }); second.resolve({ ok: false }); view.close(); }
  });

  it('Commons: an add that settles after a remount keeps its fence until the mounted view reads the Library', async () => {
    const reply = deferred();
    const host = fakeHost({ heard: [card('a', 'App', ANA)] }, { 'dweb/open-commons': () => reply.promise });
    const effects = createEffects();
    let view = mount({ send: host.send, effects });
    try {
      await settle();
      await click(view.root, 'Comes with peerd');
      await click(view.root, 'Add and open Commons');
      await until(() => host.count('dweb/open-commons') === 1);
      view.close();
      view = mount({ send: host.send, effects });
      await settle();
      await click(view.root, 'Comes with peerd');
      host.state.library = [{ id: 'app-commons', dweb: { seed: 'commons' } }];
      const reads = host.count('apps/list');
      reply.resolve({ ok: true });
      // The closed view reads the Library after the add.
      await until(() => host.count('apps/list') > reads); await settle();
      expect(effects.commons).toBe('adding');
      expect(button(view.root, 'Opening…')?.disabled).toBe(true);
      await focusPoll();
      expect(effects.commons).toBe(null);
      expect(button(el(view.root, '[data-key="commons"]'), 'Open')?.disabled).toBe(false);
      expect(host.count('dweb/open-commons')).toBe(1);
    } finally { reply.resolve({ ok: false }); view.close(); }
  });
});
