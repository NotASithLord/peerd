// @ts-check
import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { LibrarySection } from '/home/library-section.js';

// Two apps, one favorited, distinct updatedAt so sort order is stable.
const FIXTURE = [
  { id: 'app-1', name: 'Calculator', tags: ['math'], entryFile: 'index.html',
    favorite: false, source: 'local', thumbnail: null, updatedAt: 2000 },
  { id: 'app-2', name: 'Snake Game', tags: ['game'], entryFile: 'index.html',
    favorite: true, source: 'local', thumbnail: null, updatedAt: 1000 },
];

/** @typedef {{ type: string } & Record<string, any>} Msg */
/** @typedef {Record<string, (msg: Msg) => any>} Overrides */
/** @typedef {((msg: Msg) => Promise<any>) & { calls: Msg[] }} FakeSend */

// Fake one-shot send(): records calls, answers apps/list with a CLONED
// fixture, lets a test override any route. Mirrors the denylist-view test.
/** @param {Overrides} [overrides] */
const makeSend = (overrides = {}) => {
  /** @type {Msg[]} */
  const calls = [];
  /** @type {FakeSend} */
  const send = Object.assign(
    /** @param {Msg} msg */
    async (msg) => {
      calls.push(msg);
      const override = overrides[msg.type];
      if (override) return override(msg);
      if (msg.type === 'apps/list') return { ok: true, apps: structuredClone(FIXTURE) };
      if (msg.type === 'apps/favorite') return { ok: true, app: { ...FIXTURE[0], favorite: msg.favorite } };
      if (msg.type === 'apps/rename') return { ok: true, app: { id: msg.appId, name: msg.name } };
      return { ok: true };
    },
    { calls },
  );
  return send;
};

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  m.redraw.sync();
};

/**
 * @param {FakeSend} send
 * @param {{ dweb?: boolean }} [attrs]
 */
const mountView = async (send, attrs = {}) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(LibrarySection, { send, ...attrs }) });
  await flush();
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

/** @param {ParentNode} root */
const names = (root) => [...root.querySelectorAll('.library-name')].map((n) => n.textContent);

// Find the first matching element whose text equals `text` — may be
// undefined (callers assert presence/absence).
/**
 * @param {ParentNode} root
 * @param {string} sel
 * @param {string} text
 * @returns {HTMLElement | undefined}
 */
const byText = (root, sel, text) =>
  /** @type {HTMLElement[]} */ ([...root.querySelectorAll(sel)]).find((b) => b.textContent === text);

// Query that asserts presence — a null here is a real test failure (same
// TypeError as the old direct .click()/.value access on a missing node).
/**
 * @template {HTMLElement} [T=HTMLElement]
 * @param {ParentNode} root
 * @param {string} sel
 * @param {new () => T} [_ctor]
 * @returns {T}
 */
const need = (root, sel, _ctor) => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return /** @type {T} */ (el);
};

// byText + click, asserting presence — mirrors the old `.find(...).click()`.
/**
 * @param {ParentNode} root
 * @param {string} sel
 * @param {string} text
 */
const clickText = (root, sel, text) => {
  const el = byText(root, sel, text);
  if (!el) throw new Error(`missing ${sel} with text: ${text}`);
  el.click();
};

describe('home.library', () => {
  it('renders saved apps, favorites first', async () => {
    const { root, unmount } = await mountView(makeSend());
    try {
      // Snake Game is favorited → sorts above the more-recently-updated Calculator.
      expect(names(root)).toEqual(['Snake Game', 'Calculator']);
    } finally { unmount(); }
  });

  it('favorites-only filter hides non-favorites', async () => {
    const { root, unmount } = await mountView(makeSend());
    try {
      need(root, 'button[title="Show favorites only"]').click();
      await flush();
      expect(names(root)).toEqual(['Snake Game']);
    } finally { unmount(); }
  });

  it('tapping a star dispatches apps/favorite', async () => {
    const send = makeSend();
    const { root, unmount } = await mountView(send);
    try {
      // Calculator is not a favorite → its card star is titled "Favorite".
      need(root, 'button[title="Favorite"]').click();
      await flush();
      expect(send.calls.find((c) => c.type === 'apps/favorite'))
        .toEqual({ type: 'apps/favorite', appId: 'app-1', favorite: true });
    } finally { unmount(); }
  });

  it('delete arms then confirms before dispatching apps/delete', async () => {
    const send = makeSend();
    const { root, unmount } = await mountView(send);
    try {
      // Secondary actions live behind the kebab now; Delete arms in-menu.
      need(root, '.library-kebab').click();
      await flush();
      clickText(root, '.library-menu-item', 'Delete');   // arms
      await flush();
      expect(send.calls.some((c) => c.type === 'apps/delete')).toBe(false);
      clickText(root, '.library-menu-item', 'Delete?');  // confirms
      await flush();
      expect(send.calls.some((c) => c.type === 'apps/delete')).toBe(true);
    } finally { unmount(); }
  });

  it('a seeded (shared/dwapp) app warns about seeding in the delete confirm', async () => {
    const seeded = [{ id: 'app-9', name: 'Ping Pong', tags: ['dweb'], entryFile: 'index.html',
      favorite: false, source: 'local', thumbnail: null, updatedAt: 3000, shared: true }];
    const send = makeSend({ 'apps/list': () => ({ ok: true, apps: structuredClone(seeded) }) });
    const { root, unmount } = await mountView(send);
    try {
      need(root, '.library-kebab').click();
      await flush();
      clickText(root, '.library-menu-item', 'Delete');   // arms
      await flush();
      // The confirm names the seeding consequence and the armed label changes.
      expect(root.textContent).toContain('seeding this app to peers');
      expect(byText(root, '.library-menu-item', 'Stop sharing & delete?')).toBeTruthy();
      expect(byText(root, '.library-menu-item', 'Delete?')).toBeFalsy();
      clickText(root, '.library-menu-item', 'Stop sharing & delete?');
      await flush();
      expect(send.calls.some((c) => c.type === 'apps/delete' && c.appId === 'app-9')).toBe(true);
    } finally { unmount(); }
  });

  it('Share opens the namespace dialog and shares with the chosen slug', async () => {
    const send = makeSend();
    const { root, unmount } = await mountView(send, { dweb: true });
    try {
      clickText(root, 'button', 'Share');   // opens the dialog (no dispatch yet)
      await flush();
      expect(send.calls.some((c) => c.type === 'dweb/base/share-app')).toBe(false);
      const input = need(root, '.library-share input', HTMLInputElement);
      expect(input).toBeTruthy();
      expect(input.disabled).toBe(false);        // editable on first share
      input.value = 'My Cool App!';
      input.dispatchEvent(new Event('input'));
      await flush();
      clickText(root, '.library-share button', 'Share');
      await flush();
      const call = send.calls.find((c) => c.type === 'dweb/base/share-app');
      expect(call?.slug).toBe('my-cool-app');    // slugified
    } finally { unmount(); }
  });

  it('reshare locks the namespace and publishes an update', async () => {
    const seeded = [{ id: 'app-9', name: 'Ping Pong', tags: ['dweb'], entryFile: 'index.html',
      favorite: false, source: 'local', thumbnail: null, updatedAt: 3000, shared: true,
      dweb: { slug: 'ping-pong', publisher: 'did:key:zABCDEFGH', version_id: 'v1', dwapp_id: 'D', seq: 1, local: true } }];
    const send = makeSend({ 'apps/list': () => ({ ok: true, apps: structuredClone(seeded) }) });
    const { root, unmount } = await mountView(send, { dweb: true });
    try {
      clickText(root, 'button', 'Reshare');   // shared app → "Reshare", not "Share"
      await flush();
      const input = need(root, '.library-share input', HTMLInputElement);
      expect(input.disabled).toBe(true);           // locked on reshare
      expect(input.value).toBe('ping-pong');
      clickText(root, '.library-share button', 'Publish update');
      await flush();
      const call = send.calls.find((c) => c.type === 'dweb/base/share-app');
      expect(call?.slug).toBe('ping-pong');
    } finally { unmount(); }
  });

  it('an available update shows a badge and Update pulls the new version', async () => {
    const installed = [{ id: 'app-7', name: 'Notes', tags: [], entryFile: 'index.html',
      favorite: false, source: 'dweb', thumbnail: null, updatedAt: 4000,
      dweb: { dwapp_id: 'D', version_id: 'v1', seq: 1, uri: 'peerd://x/v1' } }];
    const send = makeSend({
      'apps/list': () => ({ ok: true, apps: structuredClone(installed) }),
      'dweb/base/updates': () => ({ ok: true, updates: { 'app-7': { uri: 'peerd://x/v2', version_id: 'v2', seq: 2, name: 'Notes', slug: 'notes', dwapp_id: 'D' } } }),
    });
    const { root, unmount } = await mountView(send, { dweb: true });
    try {
      await flush();                               // let refreshUpdates resolve
      expect(root.textContent).toContain('new version available');
      clickText(root, 'button', 'Update');
      await flush();
      const call = send.calls.find((c) => c.type === 'dweb/base/update-app');
      expect(call?.appId).toBe('app-7');
      expect(call?.uri).toBe('peerd://x/v2');
    } finally { unmount(); }
  });

  it('Open dispatches apps/open with the app id', async () => {
    const send = makeSend();
    const { root, unmount } = await mountView(send);
    try {
      clickText(root, 'button', 'Open');
      await flush();
      expect(send.calls.some((c) => c.type === 'apps/open' && typeof c.appId === 'string')).toBe(true);
    } finally { unmount(); }
  });

  it('empty catalog shows the build-one hint', async () => {
    const { root, unmount } = await mountView(makeSend({ 'apps/list': () => ({ ok: true, apps: [] }) }));
    try {
      expect(root.textContent).toContain('No apps yet');
    } finally { unmount(); }
  });

  it('rename: Enter commits apps/rename and updates the name', async () => {
    const send = makeSend();
    const { root, unmount } = await mountView(send);
    try {
      // Snake Game (favorite) sorts first. Rename lives behind the kebab now.
      need(root, '.library-kebab').click();
      await flush();
      clickText(root, '.library-menu-item', 'Rename');
      await flush();
      const input = need(root, '.library-card input', HTMLInputElement);
      input.value = 'Renamed';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await flush();
      expect(send.calls.find((c) => c.type === 'apps/rename'))
        .toEqual({ type: 'apps/rename', appId: 'app-2', name: 'Renamed' });
      expect(names(root)).toContain('Renamed');
    } finally { unmount(); }
  });

  it('rename: Escape cancels without dispatching (the commit guard)', async () => {
    const send = makeSend();
    const { root, unmount } = await mountView(send);
    try {
      need(root, '.library-kebab').click();
      await flush();
      clickText(root, '.library-menu-item', 'Rename');
      await flush();
      const input = need(root, '.library-card input', HTMLInputElement);
      input.value = 'ShouldNotStick';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await flush();
      expect(send.calls.some((c) => c.type === 'apps/rename')).toBe(false);
      expect(names(root)).toContain('Snake Game');
    } finally { unmount(); }
  });

  it('delete: dismissing the menu disarms without dispatching', async () => {
    const send = makeSend();
    const { root, unmount } = await mountView(send);
    try {
      need(root, '.library-kebab').click();
      await flush();
      clickText(root, '.library-menu-item', 'Delete');   // arms
      await flush();
      // Dismiss via an outside mousedown — the section-level closer disarms.
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await flush();
      expect(send.calls.some((c) => c.type === 'apps/delete')).toBe(false);
      // Re-open: Delete is disarmed again ('Delete', not 'Delete?').
      need(root, '.library-kebab').click();
      await flush();
      expect(byText(root, '.library-menu-item', 'Delete?')).toBeFalsy();
      expect(byText(root, '.library-menu-item', 'Delete')).toBeTruthy();
    } finally { unmount(); }
  });

  it('favorite failure reverts the star and shows an inline error (grid stays)', async () => {
    const send = makeSend({ 'apps/favorite': () => ({ ok: false, error: 'nope' }) });
    const { root, unmount } = await mountView(send);
    try {
      need(root, 'button[title="Favorite"]').click();   // Calculator (not fav)
      await flush();
      // Grid still rendered (inline banner, not a full error screen) and
      // the optimistic star reverted to outline (title back to 'Favorite').
      expect(root.querySelector('button[title="Favorite"]')).toBeTruthy();
      expect(names(root).length).toBe(2);
      expect(root.textContent).toContain('nope');
    } finally { unmount(); }
  });

  it('export dispatches export/artifact for the app', async () => {
    const send = makeSend({ 'export/artifact': () => ({ ok: true, filename: 'x.peerd', envelope: { v: 1 } }) });
    const { root, unmount } = await mountView(send);
    try {
      need(root, '.library-kebab').click();
      await flush();
      clickText(root, '.library-menu-item', 'Export');
      await flush();
      expect(send.calls.find((c) => c.type === 'export/artifact'))
        .toEqual({ type: 'export/artifact', kind: 'app', id: 'app-2' });
    } finally { unmount(); }
  });

  it('a load failure shows an error screen that Refresh recovers', async () => {
    let firstCall = true;
    const send = makeSend({
      'apps/list': () => {
        if (firstCall) { firstCall = false; return { ok: false, error: 'boom' }; }
        return { ok: true, apps: structuredClone(FIXTURE) };
      },
    });
    const { root, unmount } = await mountView(send);
    try {
      expect(root.textContent).toContain('boom');
      need(root, 'button[title="Refresh"]').click();
      await flush();
      // Recovered: grid shows and the error cleared (refresh resets it).
      expect(names(root)).toEqual(['Snake Game', 'Calculator']);
      expect(root.textContent.includes('boom')).toBe(false);
    } finally { unmount(); }
  });
});
