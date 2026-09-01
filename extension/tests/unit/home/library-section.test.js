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

// why: the view moves focus from inside its OWN requestAnimationFrame
// (focusLibraryAction), so awaiting a single frame races it - under CI load the
// test's frame can run first and read the pre-move element. Poll to a deadline
// instead. A genuine focus regression still fails the assertion that follows,
// just one budget later.
/**
 * @param {() => boolean} landed
 * @param {number} [budgetMs]
 */
const focusSettles = async (landed, budgetMs = 2000) => {
  const deadline = performance.now() + budgetMs;
  while (!landed() && performance.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 16); });
  }
};

/** @param {string} action */
const focusedAction = (action) => () =>
  document.activeElement?.getAttribute('data-library-action') === action;

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

  it('imports a GitHub App from a discoverable Library form', async () => {
    const send = makeSend({
      'apps/import-git': (msg) => ({
        ok: true,
        record: { id: 'git-app', name: msg.name || 'Git App', entryFile: 'index.html' },
      }),
      'apps/open': () => ({ ok: true }),
    });
    const { root, unmount } = await mountView(send);
    try {
      clickText(root, 'button', 'Import Git');
      await flush();
      const url = need(root, 'input[aria-label="Git repository URL"]', HTMLInputElement);
      const ref = need(root, 'input[aria-label="Git branch or tag"]', HTMLInputElement);
      const name = need(root, 'input[aria-label="Imported App display name"]', HTMLInputElement);
      url.value = 'https://github.com/example/notes';
      ref.value = 'release';
      name.value = 'Shared Notes';
      url.dispatchEvent(new Event('input'));
      ref.dispatchEvent(new Event('input'));
      name.dispatchEvent(new Event('input'));
      await flush();
      clickText(root, 'button', 'Clone App');
      await flush();
      expect(send.calls.find((call) => call.type === 'apps/import-git')).toEqual({
        type: 'apps/import-git',
        url: 'https://github.com/example/notes',
        ref: 'release',
        name: 'Shared Notes',
      });
      expect(root.textContent).toContain('opened it with its bound actor');
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

  it('moves focus through the actions menu and returns it on Escape', async () => {
    const { root, unmount } = await mountView(makeSend());
    try {
      const trigger = need(root, '.library-kebab', HTMLButtonElement);
      trigger.focus();
      trigger.click();
      await flush();
      expect(document.activeElement?.textContent).toBe('Rename');
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(document.activeElement?.textContent).toBe('History & Git');
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await flush();
      await focusSettles(() => document.activeElement === trigger);
      expect(root.querySelector('.library-menu')).toBeFalsy();
      expect(document.activeElement).toBe(trigger);
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
      const confirm = /** @type {HTMLElement} */ (byText(root, '.library-menu-item', 'Delete?'));
      confirm.focus();
      confirm.click();                                  // confirms
      await flush();
      await focusSettles(focusedAction('open'));
      expect(send.calls.some((c) => c.type === 'apps/delete')).toBe(true);
      expect(document.activeElement?.getAttribute('data-library-action')).toBe('open');
      expect(document.activeElement?.closest('.library-card')?.textContent).toContain('Calculator');
    } finally { unmount(); }
  });

  it('announces a failed delete and restores focus to the surviving card menu', async () => {
    const send = makeSend({
      'apps/delete': () => ({
        ok: false,
        error: 'Could not stop sharing, so your local App was kept. Try again when the dweb is available.',
      }),
    });
    const { root, unmount } = await mountView(send);
    try {
      need(root, '.library-kebab').click();
      await flush();
      clickText(root, '.library-menu-item', 'Delete');
      await flush();
      const confirm = /** @type {HTMLElement} */ (byText(root, '.library-menu-item', 'Delete?'));
      confirm.focus();
      confirm.click();
      await flush();
      await focusSettles(focusedAction('more'));
      expect(root.querySelector('[role="alert"]')?.textContent).toContain('local App was kept');
      expect(document.activeElement?.getAttribute('data-library-action')).toBe('more');
      expect(document.activeElement?.closest('.library-card')?.textContent).toContain('Snake Game');
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
      expect(root.textContent).toContain('including data/*.json');
      const input = need(root, '.library-share input', HTMLInputElement);
      expect(input).toBeTruthy();
      expect(input.disabled).toBe(false);        // editable on first share
      input.value = 'My Cool App!';
      input.dispatchEvent(new Event('input'));
      await flush();
      clickText(root, '.library-share button', 'Share');
      await flush();
      await focusSettles(focusedAction('share'));
      const call = send.calls.find((c) => c.type === 'dweb/base/share-app');
      expect(call?.slug).toBe('my-cool-app');    // slugified
      expect(document.activeElement?.getAttribute('data-library-action')).toBe('share');
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
      await focusSettles(focusedAction('open'));
      const call = send.calls.find((c) => c.type === 'dweb/base/update-app');
      expect(call?.appId).toBe('app-7');
      expect(call?.uri).toBe('peerd://x/v2');
      expect(document.activeElement?.getAttribute('data-library-action')).toBe('open');
    } finally { unmount(); }
  });

  it('reports a committed update cleanup warning without calling the update failed', async () => {
    const installed = [{ id: 'app-7', name: 'Notes', tags: [], entryFile: 'index.html',
      favorite: false, source: 'dweb', thumbnail: null, updatedAt: 4000,
      dweb: { dwapp_id: 'D', version_id: 'v1', seq: 1, uri: 'peerd://x/v1' } }];
    const send = makeSend({
      'apps/list': () => ({ ok: true, apps: structuredClone(installed) }),
      'dweb/base/updates': () => ({ ok: true, updates: { 'app-7': { uri: 'peerd://x/v2', version_id: 'v2', seq: 2, name: 'Notes', slug: 'notes', dwapp_id: 'D' } } }),
      'dweb/base/update-app': () => ({
        ok: true,
        app: { ...installed[0], dweb: { ...installed[0].dweb, version_id: 'v2', seq: 2 } },
        warning: 'previous-version-cleanup-pending',
        cleanupPending: true,
      }),
    });
    const { root, unmount } = await mountView(send, { dweb: true });
    try {
      await flush();
      clickText(root, 'button', 'Update');
      await flush();
      expect(root.textContent).toContain('The update was installed. Older shared bytes will be cleaned up');
      expect(root.textContent.includes('update failed')).toBe(false);
    } finally { unmount(); }
  });

  it('reports both audit and cleanup warnings after a committed update', async () => {
    const installed = [{ id: 'app-7', name: 'Notes', tags: [], entryFile: 'index.html',
      favorite: false, source: 'dweb', thumbnail: null, updatedAt: 4000,
      dweb: { dwapp_id: 'D', version_id: 'v1', seq: 1, uri: 'peerd://x/v1' } }];
    const send = makeSend({
      'apps/list': () => ({ ok: true, apps: structuredClone(installed) }),
      'dweb/base/updates': () => ({ ok: true, updates: { 'app-7': { uri: 'peerd://x/v2', version_id: 'v2', seq: 2, name: 'Notes', slug: 'notes', dwapp_id: 'D' } } }),
      'dweb/base/update-app': () => ({
        ok: true,
        app: { ...installed[0], dweb: { ...installed[0].dweb, version_id: 'v2', seq: 2 } },
        warning: 'audit-write-failed',
        warnings: ['audit-write-failed', 'previous-version-cleanup-pending'],
        cleanupPending: true,
      }),
    });
    const { root, unmount } = await mountView(send, { dweb: true });
    try {
      await flush();
      clickText(root, 'button', 'Update');
      await flush();
      expect(root.textContent).toContain('security audit entry could not be written');
      expect(root.textContent).toContain('Older shared bytes will be cleaned up');
    } finally { unmount(); }
  });

  it('an update never overwrites local work without a fork-or-replace choice', async () => {
    const installed = [{ id: 'app-7', name: 'Notes', tags: [], entryFile: 'index.html',
      favorite: false, source: 'dweb', thumbnail: null, updatedAt: 4000,
      dweb: { dwapp_id: 'D', version_id: 'v1', seq: 1, uri: 'peerd://x/v1' } }];
    const send = makeSend({
      'apps/list': () => ({ ok: true, apps: structuredClone(installed) }),
      'dweb/base/updates': () => ({ ok: true, updates: { 'app-7': { uri: 'peerd://x/v2', version_id: 'v2', seq: 2, name: 'Notes', slug: 'notes', dwapp_id: 'D', changelog: 'Improve sync' } } }),
      'dweb/base/update-app': (msg) => msg.strategy === 'fork'
        ? { ok: true, app: { dweb: { version_id: 'v2' } }, fork: { id: 'fork-1', name: 'Notes: local fork' } }
        : { ok: false, error: 'local-changes', conflictToken: 7 },
    });
    const { root, unmount } = await mountView(send, { dweb: true });
    try {
      await flush();
      expect(root.textContent).toContain('Improve sync');
      clickText(root, 'button', 'Update');
      await flush();
      expect(root.textContent).toContain('will not overwrite');
      window.dispatchEvent(new Event('focus'));
      await flush();
      clickText(root, 'button', 'Keep a fork & update');
      await flush();
      const calls = send.calls.filter((c) => c.type === 'dweb/base/update-app');
      expect(calls.at(-1)?.strategy).toBe('fork');
      expect(calls.at(-1)?.conflictToken).toBe(7);
      expect(root.textContent).toContain('Kept your local work');
    } finally { unmount(); }
  });

  it('History & Git shows status/log and restore requires a second click', async () => {
    const send = makeSend({
      'apps/repository/status': () => ({ ok: true, status: { oid: 'abcdef123456', branch: 'main', dirty: true, changed: [{ path: 'index.html', status: 'modified' }] }, remote: { url: 'https://github.com/me/app.git', host: 'github.com' } }),
      'apps/repository/history': () => ({ ok: true, commits: [{ oid: 'abcdef123456', message: 'checkpoint', timestamp: Date.now() - 1000 }] }),
      'apps/repository/diff': () => ({ ok: true, diff: { files: [{ path: 'index.html', status: 'modified' }], patch: '--- a/index.html\n+++ b/index.html', truncated: false } }),
      'apps/repository/restore': () => ({ ok: true, result: { oid: 'restored', restored: true } }),
    });
    const { root, unmount } = await mountView(send);
    try {
      const trigger = need(root, '.library-kebab', HTMLButtonElement);
      trigger.click();
      await flush();
      clickText(root, '.library-menu-item', 'History & Git');
      await flush();
      expect(need(root, '.library-card').classList.contains('is-expanded')).toBe(true);
      expect(need(root, '.library-repository', HTMLElement).getAttribute('role')).toBe('region');
      // why the RE-QUERY inside the poll (the #405 follow-up that finally
      // killed this flake): the panel claims focus from its own oncreate, which
      // only runs once the repository send has resolved and Mithril has
      // committed that redraw - and a LATER redraw can REPLACE the panel node.
      // Capturing the element once and comparing identity races that
      // replacement: focus lands on the live node while the captured one is
      // detached, and the assertion fails as two distinct objects with the
      // uninformative `actual: {} / expected: {}` signature that kept turning
      // Gecko shard 5/8 red. Poll for "the CURRENT panel is focused", then
      // assert against a fresh query.
      const panelFocused = () => {
        const live = root.querySelector('.library-repository');
        return !!live && document.activeElement === live;
      };
      // why a diagnosis string instead of toBe(true): this assertion has now
      // flaked in Chrome AND Gecko across three different focus-claim
      // implementations (the original one-shot oncreate, #412's claim-on-update,
      // and its corrected retry), so the claim logic is not the whole story and
      // `actual: false` tells us nothing. When it next fails, the actual value
      // names WHERE focus went and whether the panel was even in the DOM, which
      // is the evidence a real fix needs. Green runs are byte-identical to the
      // old assertion.
      const focusDiagnosis = () => {
        if (panelFocused()) return 'panel-focused';
        const active = document.activeElement;
        const name = !active || active === document.body
          ? 'body'
          : `${active.tagName.toLowerCase()}`
            + `${active.className ? `.${String(active.className).trim().split(/\s+/).join('.')}` : ''}`
            + `${active.getAttribute('data-library-action') ? `[action=${active.getAttribute('data-library-action')}]` : ''}`;
        return `focus-on:${name} panel-in-dom:${!!root.querySelector('.library-repository')}`;
      };
      await focusSettles(panelFocused);
      expect(focusDiagnosis()).toBe('panel-focused');
      expect(root.textContent).toContain('1 uncommitted change');
      expect(root.textContent).toContain('checkpoint');
      clickText(root, '.library-commit button', 'Diff');
      await flush();
      expect(root.textContent).toContain('--- a/index.html');
      clickText(root, '.library-commit button', 'Restore');
      await flush();
      expect(send.calls.some((c) => c.type === 'apps/repository/restore')).toBe(false);
      clickText(root, '.library-commit button', 'Restore?');
      await flush();
      expect(send.calls.some((c) => c.type === 'apps/repository/restore' && c.to === 'abcdef123456')).toBe(true);
      need(root, 'button[title="Close history"]').click();
      await flush();
      // Same re-query-inside-the-poll shape as the panel-focus assertion
      // above: the collapse redraw can replace the kebab node, so identity
      // against the early capture would race it.
      const kebabFocused = () => {
        const live = root.querySelector('.library-kebab');
        return !!live && document.activeElement === live;
      };
      await focusSettles(kebabFocused);
      expect(kebabFocused()).toBe(true);
    } finally { unmount(); }
  });

  it('invalidates a cached commit diff when repository state refreshes', async () => {
    let diffRead = 0;
    const send = makeSend({
      'apps/repository/status': () => ({ ok: true, status: { oid: 'abcdef123456', branch: 'main', dirty: true, changed: [{ path: 'index.html', status: 'modified' }] }, remote: null }),
      'apps/repository/history': () => ({ ok: true, commits: [{ oid: 'abcdef123456', message: 'checkpoint', timestamp: Date.now() - 1000 }] }),
      'apps/repository/diff': () => ({ ok: true, diff: { files: [], patch: `working-tree-${++diffRead}`, truncated: false } }),
      'apps/repository/commit': () => ({ ok: true, result: { oid: 'new-checkpoint', created: true } }),
    });
    const { root, unmount } = await mountView(send);
    try {
      need(root, '.library-kebab').click();
      await flush();
      clickText(root, '.library-menu-item', 'History & Git');
      await flush();
      clickText(root, '.library-commit button', 'Diff');
      await flush();
      expect(root.textContent).toContain('working-tree-1');

      clickText(root, '.library-repository-dirty button', 'Checkpoint');
      await flush();
      await flush();
      clickText(root, '.library-commit button', 'Diff');
      await flush();
      expect(root.textContent).toContain('working-tree-2');
      expect(send.calls.filter((call) => call.type === 'apps/repository/diff').length).toBe(2);
    } finally { unmount(); }
  });

  it('uses a developer-supplied checkpoint message', async () => {
    const send = makeSend({
      'apps/repository/status': () => ({ ok: true, status: { oid: 'abcdef123456', branch: 'main', dirty: true, changed: [{ path: 'script.js', status: 'modified' }] }, remote: null }),
      'apps/repository/history': () => ({ ok: true, commits: [] }),
      'apps/repository/commit': () => ({ ok: true, result: { oid: 'new', created: true } }),
    });
    const { root, unmount } = await mountView(send);
    try {
      need(root, '.library-kebab').click();
      await flush();
      clickText(root, '.library-menu-item', 'History & Git');
      await flush();
      const input = need(root, '.library-repository-dirty input', HTMLInputElement);
      input.value = 'Explain the renderer fix';
      input.dispatchEvent(new Event('input'));
      clickText(root, '.library-repository-dirty button', 'Checkpoint');
      await flush();
      expect(send.calls.some((c) => c.type === 'apps/repository/commit' && c.message === 'Explain the renderer fix')).toBe(true);
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
