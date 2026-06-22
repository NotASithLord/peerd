// @ts-check
// The Library — the home page's "front door" to the Apps the agent (or
// the user) has built. Apps persist by default (IDB catalog + OPFS
// files), so this is the human surface for seeing, opening, favoriting,
// renaming, exporting, and deleting them. The agent reaches the same
// catalog through its app_* tools.
//
// Built to stay light under default persistence: it fetches CATALOG
// METADATA only (never OPFS file bodies), and all filtering/sorting is
// client-side over that small list. Open/delete route through the SW's
// appClient so tab lifecycle + OPFS teardown match the agent's tools.
// Export reuses the existing export/artifact route (a .peerd bundle —
// the same content-addressed format the dweb transfers).
//
// Brand rule: an otherwise-monochrome surface with the sanctioned splash of
// brand color (owner direction 2026-06-22) — each app's avatar carries one of
// the five brand hues (stable per id), and the favorite star turns amber-gold
// when set. Everything else stays grayscale; error red is the lone semantic
// color, and glyphs (★/☆, ⋯) still do most of the state-carrying.

import m from '/vendor/mithril/mithril.js';

/** @typedef {import('../options/sections/reset-row.js').Send} Send */
/**
 * A catalog App row (metadata only — the SW's app registry shape). Dynamic
 * fields the dweb overlay carries are kept loose via `dweb`.
 * @typedef {object} App
 * @property {string} id
 * @property {string} name
 * @property {boolean} [favorite]
 * @property {string[]} [tags]
 * @property {number} [updatedAt]
 * @property {string} [source]
 * @property {boolean} [shared]
 * @property {any} [dweb]
 */

// p·cyan e·red e·amber r·green d·magenta — each app's avatar gets ONE brand
// hue. why deterministic (hash of id) rather than the per-session-random peer
// colors: an app sits still in the grid, so its color should be stable across
// refreshes and reloads — a quiet identity, not a flicker.
const BRAND = ['#00B7EB', '#EF4444', '#F59E0B', '#22C55E', '#D946EF'];
/** @param {string} [key] */
const colorOf = (key) => {
  let h = 0;
  for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BRAND[h % BRAND.length];
};

/** @param {number} [ms] */
const fmtWhen = (ms) => {
  if (typeof ms !== 'number') return '';
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  try { return new Date(ms).toLocaleDateString(); } catch { return ''; }
};

// Mirror of the host's slugify (offscreen/dweb-base.js) so the dialog can preview
// the SAME namespace the share will mint. Stable, lowercase, ≤64 chars.
/** @param {string} [name] */
const slugify = (name) => (String(name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'app');

// Is this app published on the dweb (so deleting also un-shares it)? True when the
// user shared it (the `shared` flag) OR it's an installed dwapp we auto-seed (a
// dweb slot). Either way our node is serving its bytes to peers — deleting stops
// that, and the confirmation should say so.
/** @param {App} [app] */
const isSeeded = (app) => !!(app?.shared || app?.dweb);

/**
 * @param {string | undefined} filename
 * @param {any} envelope
 */
const downloadEnvelope = (filename, envelope) => {
  const blob = new Blob([JSON.stringify(envelope)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'app.peerd';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export const LibrarySection = {
  /** @param {{ state: any, attrs: { send: Send, dweb?: boolean } }} vnode */
  oninit(vnode) {
    vnode.state.apps = null;        // null = loading
    vnode.state.error = null;
    vnode.state.query = '';
    vnode.state.favOnly = false;
    vnode.state.renamingId = null;
    vnode.state.renameValue = '';
    vnode.state.armedDeleteId = null;
    vnode.state.menuOpenId = null;     // the one open kebab (overflow) menu
    vnode.state.busyId = null;
    vnode.state.shareEditId = null;    // the app whose share dialog is open
    vnode.state.shareSlug = '';        // the editable namespace in that dialog
    vnode.state.updates = {};          // appId -> { uri, version_id, seq, … } when a newer version exists
    LibrarySection.refresh(vnode);
  },

  /** @param {{ state: any, attrs: { send: Send, dweb?: boolean } }} vnode */
  oncreate(vnode) {
    // ONE section-level outside-click closer for the (single) open kebab menu.
    // .closest keeps clicks inside the menu or on its trigger from closing it.
    vnode.state._onDocDown = (/** @type {MouseEvent} */ e) => {
      if (vnode.state.menuOpenId && !(/** @type {Element} */ (e.target)).closest('.library-menu, .library-kebab')) {
        vnode.state.menuOpenId = null; vnode.state.armedDeleteId = null; m.redraw();
      }
    };
    document.addEventListener('mousedown', vnode.state._onDocDown);
    // A dweb install (Discover section) creates a new app in the catalog; re-fetch
    // so it appears here at once. Decoupled page-level bus — the sections share no
    // store.
    vnode.state._onInstalled = () => LibrarySection.refresh(vnode);
    window.addEventListener('peerd:app-installed', vnode.state._onInstalled);
    // Poll for newer versions of installed dweb apps while the Library is open, so a
    // peer's reshare surfaces an "update" badge without a manual refresh. Light: one
    // cross-reference call, dweb-only, paused when the tab is hidden.
    if (vnode.attrs.dweb) {
      vnode.state._updTimer = setInterval(() => { if (!document.hidden) LibrarySection.refreshUpdates(vnode); }, 8000);
    }
    // Auto-refresh the catalog itself: it changes out from under the page —
    // the agent builds an app, a headless job finishes, another tab renames
    // one. Poll quietly so the grid stays live without a manual ↻. Paused when
    // the tab's hidden (pointless) and skipped mid-interaction (an open menu /
    // live rename / share dialog / armed delete would be clobbered by a swap).
    vnode.state._listTimer = setInterval(() => {
      const s = vnode.state;
      if (document.hidden || s.menuOpenId || s.renamingId || s.shareEditId || s.armedDeleteId || s.busyId) return;
      LibrarySection.quietRefresh(vnode);
    }, 15000);
    // Returning to the tab should feel current at once, not after the next tick.
    vnode.state._onVisible = () => { if (!document.hidden) LibrarySection.quietRefresh(vnode); };
    document.addEventListener('visibilitychange', vnode.state._onVisible);
    window.addEventListener('focus', vnode.state._onVisible);
  },
  /** @param {{ state: any }} vnode */
  onremove(vnode) {
    document.removeEventListener('mousedown', vnode.state._onDocDown);
    window.removeEventListener('peerd:app-installed', vnode.state._onInstalled);
    document.removeEventListener('visibilitychange', vnode.state._onVisible);
    window.removeEventListener('focus', vnode.state._onVisible);
    if (vnode.state._updTimer) clearInterval(vnode.state._updTimer);
    if (vnode.state._listTimer) clearInterval(vnode.state._listTimer);
  },

  /** @param {{ state: any, attrs: { send: Send, dweb?: boolean } }} vnode */
  refresh(vnode) {
    // why: clearing the error here is what lets the Refresh button (which
    // is the only control rendered on the error screen) recover the view.
    vnode.state.error = null;
    vnode.state.refreshing = true;          // drives the ↻ spin until it lands
    vnode.attrs.send({ type: 'apps/list' }).then((/** @type {any} */ r) => {
      if (r?.ok) vnode.state.apps = r.apps ?? [];
      else vnode.state.error = r?.error ?? 'failed to load apps';
    }).catch((/** @type {unknown} */ e) => { vnode.state.error = /** @type {{ message?: string }} */ (e)?.message ?? 'failed to load apps'; })
      .finally(() => { vnode.state.refreshing = false; m.redraw(); });
    LibrarySection.refreshUpdates(vnode);
  },

  // The background poll's refetch: unlike refresh(), it never blanks the grid
  // to a spinner or clears a live mutation error — it swaps in the new list on
  // success and stays SILENT on failure (the manual ↻ is the loud path). Skips
  // when a manual refresh is already in flight so the two don't stack.
  /** @param {{ state: any, attrs: { send: Send, dweb?: boolean } }} vnode */
  quietRefresh(vnode) {
    if (vnode.state.refreshing) return;
    vnode.attrs.send({ type: 'apps/list' }).then((/** @type {any} */ r) => {
      if (r?.ok && Array.isArray(r.apps)) { vnode.state.apps = r.apps; m.redraw(); }
    }).catch(() => { /* quiet — best-effort background sync */ });
    LibrarySection.refreshUpdates(vnode);
  },

  // Which installed dweb apps have a newer version announced? dweb preview only —
  // the route is inert otherwise, so skip it. Drives the per-card "update" badge.
  /** @param {{ state: any, attrs: { send: Send, dweb?: boolean } }} vnode */
  refreshUpdates(vnode) {
    if (!vnode.attrs.dweb) return;
    vnode.attrs.send({ type: 'dweb/base/updates' }).then((/** @type {any} */ r) => {
      if (r?.ok) { vnode.state.updates = r.updates ?? {}; m.redraw(); }
    }).catch(() => { /* best-effort — no badge on failure */ });
  },

  /**
   * @param {{ state: any, attrs: { send: Send } }} vnode
   * @param {App} app
   */
  async toggleFavorite(vnode, app) {
    const next = !app.favorite;
    // why: optimistic — flip the star immediately so it feels instant,
    // then revert (and surface) if the SW write fails. The SW is the
    // source of truth; this just avoids a refetch round-trip flicker.
    app.favorite = next;
    m.redraw();
    const r = await vnode.attrs.send({ type: 'apps/favorite', appId: app.id, favorite: next });
    if (!r?.ok) { app.favorite = !next; vnode.state.error = r?.error ?? 'favorite failed'; m.redraw(); }
  },

  /**
   * @param {{ state: any, attrs: { send: Send } }} vnode
   * @param {App} app
   */
  openApp(vnode, app) {
    vnode.state.error = null;
    vnode.state.busyId = app.id;
    vnode.attrs.send({ type: 'apps/open', appId: app.id }).then((/** @type {any} */ r) => {
      if (!r?.ok) vnode.state.error = r?.error ?? 'open failed';
    }).finally(() => {
      vnode.state.busyId = null;
      m.redraw();
    });
  },

  /**
   * @param {{ state: any }} vnode
   * @param {App} app
   */
  startRename(vnode, app) {
    vnode.state.renamingId = app.id;
    vnode.state.renameValue = app.name;
  },
  /**
   * @param {{ state: any, attrs: { send: Send } }} vnode
   * @param {App} app
   */
  async commitRename(vnode, app) {
    // why this guard: the input commits on BOTH Enter and blur, and an
    // Escape nulls renamingId then triggers blur. Gating on the active id
    // means only the live rename commits, exactly once — Escape cancels
    // (renamingId already null) and the Enter→blur pair fires only once.
    if (vnode.state.renamingId !== app.id) return;
    const name = vnode.state.renameValue.trim();
    vnode.state.renamingId = null;
    if (!name || name === app.name) { m.redraw(); return; }
    const r = await vnode.attrs.send({ type: 'apps/rename', appId: app.id, name });
    if (r?.ok && r.app) app.name = r.app.name;
    else vnode.state.error = r?.error ?? 'rename failed';
    m.redraw();
  },

  /**
   * @param {{ state: any, attrs: { send: Send } }} vnode
   * @param {App} app
   */
  async confirmDelete(vnode, app) {
    vnode.state.error = null;
    vnode.state.armedDeleteId = null;
    vnode.state.busyId = app.id;
    const r = await vnode.attrs.send({ type: 'apps/delete', appId: app.id });
    vnode.state.busyId = null;
    if (r?.ok) vnode.state.apps = (vnode.state.apps ?? []).filter((/** @type {App} */ a) => a.id !== app.id);
    else vnode.state.error = r?.error ?? 'delete failed';
    m.redraw();
  },

  /**
   * @param {{ state: any, attrs: { send: Send } }} vnode
   * @param {App} app
   */
  async exportApp(vnode, app) {
    vnode.state.error = null;
    vnode.state.busyId = app.id;
    const r = await vnode.attrs.send({ type: 'export/artifact', kind: 'app', id: app.id });
    vnode.state.busyId = null;
    if (r?.ok && r.envelope) downloadEnvelope(r.filename, r.envelope);
    else vnode.state.error = r?.error ?? 'export failed';
    m.redraw();
  },

  // Open the share dialog. First share: the namespace is editable (pre-filled from
  // the name). Reshare: it's LOCKED to the slug already minted (changing it would
  // fork a new app and orphan everyone who installed this one).
  /**
   * @param {{ state: any }} vnode
   * @param {App} app
   */
  openShare(vnode, app) {
    vnode.state.error = null;
    vnode.state.menuOpenId = null;
    vnode.state.shareEditId = app.id;
    vnode.state.shareSlug = app.dweb?.slug || slugify(app.name);
  },
  /** @param {{ state: any }} vnode */
  cancelShare(vnode) { vnode.state.shareEditId = null; vnode.state.shareSlug = ''; },

  // Share (or RESHARE an updated version) on the dweb: publish the signed bundle +
  // announce its card on the always-on base network. A reshape reuses the locked
  // slug → same dwapp_id → the card is AMENDED (higher seq), so peers who installed
  // it see "update available" rather than a duplicate. dweb preview only.
  /**
   * @param {{ state: any, attrs: { send: Send } }} vnode
   * @param {App} app
   */
  async shareApp(vnode, app) {
    const locked = !!app.dweb?.slug;
    const slug = locked ? app.dweb.slug : slugify(vnode.state.shareSlug);
    vnode.state.error = null;
    vnode.state.shareEditId = null;
    vnode.state.busyId = app.id;
    const r = await vnode.attrs.send({ type: 'dweb/base/share-app', appId: app.id, slug });
    vnode.state.busyId = null;
    if (r?.ok) {
      vnode.state.sharedId = app.id;
      // Reflect the minted version identity locally so the button shows "Shared ✓"
      // and the next Share opens LOCKED to this slug (no refetch round-trip).
      app.shared = true;
      app.dweb = { ...(app.dweb || {}), slug: r.slug, dwapp_id: r.dwapp_id, version_id: r.hash, seq: r.seq, publisher: r.publisher, uri: r.uri };
    } else {
      vnode.state.error = r?.error === 'dweb-disabled'
        ? 'turn the base network on (unlock + dweb enabled) to share'
        : (r?.error ?? 'share failed');
    }
    m.redraw();
  },

  // Pull a newer announced version of an installed app, overwriting it in place.
  /**
   * @param {{ state: any, attrs: { send: Send } }} vnode
   * @param {App} app
   */
  async updateApp(vnode, app) {
    const up = vnode.state.updates[app.id];
    if (!up) return;
    vnode.state.error = null;
    vnode.state.busyId = app.id;
    const r = await vnode.attrs.send({ type: 'dweb/base/update-app', appId: app.id, uri: up.uri, name: up.name, dwappId: up.dwapp_id, slug: up.slug, seq: up.seq });
    vnode.state.busyId = null;
    if (r?.ok) {
      delete vnode.state.updates[app.id];      // cleared — we're now on the new version
      if (r.app?.dweb) app.dweb = r.app.dweb;
    } else {
      vnode.state.error = r?.error ?? 'update failed';
    }
    m.redraw();
  },

  /** @param {{ state: any, attrs: { send: Send, dweb?: boolean } }} vnode */
  view(vnode) {
    const ui = vnode.state;

    const header = m('div', { style: 'display:flex; align-items:center; gap:8px; margin:0 0 12px;' }, [
      m('p.muted', { style: 'margin:0; font-size:12px;' },
        ui.apps ? `${ui.apps.length} app${ui.apps.length === 1 ? '' : 's'}` : ''),
      m('.spacer', { style: 'flex:1;' }),
      m('button.icon.library-star', {
        title: ui.favOnly ? 'Show all apps' : 'Show favorites only',
        'aria-pressed': String(ui.favOnly),
        // The glyph (filled ★ / outline ☆) carries the state; the amber-gold
        // fill when active is the sanctioned splash of brand color, not a new
        // semantic axis.
        class: ui.favOnly ? 'is-on' : '',
        onclick: () => { ui.favOnly = !ui.favOnly; },
      }, ui.favOnly ? '★' : '☆'),
      m('button.icon.library-refresh', {
        title: 'Refresh',
        class: ui.refreshing ? 'is-spinning' : '',
        onclick: () => LibrarySection.refresh(vnode),
      }, '↻'),
    ]);

    // A LOAD failure (nothing to show) gets the full error screen; a
    // transient MUTATION failure (a failed favorite/delete/export) rides
    // as an inline banner over the still-valid grid instead of blanking
    // it. Either way the next successful action clears ui.error.
    if (ui.apps === null) {
      return m('div', [header, ui.error ? m('p.error', ui.error) : m('p.muted', 'Loading…')]);
    }
    const banner = ui.error ? m('p.error', ui.error) : null;
    if (ui.apps.length === 0) {
      return m('div', [header, banner, m('p.muted',
        'No apps yet. Ask the agent to build one — it will appear here automatically.')]);
    }

    const q = ui.query.trim().toLowerCase();
    const shown = ui.apps
      .filter((/** @type {App} */ a) => (ui.favOnly ? a.favorite : true))
      .filter((/** @type {App} */ a) => {
        if (!q) return true;
        const hay = `${a.name} ${(a.tags || []).join(' ')}`.toLowerCase();
        return hay.includes(q);
      })
      // Favorites float to the top; then most-recently-touched first.
      .sort((/** @type {App} */ a, /** @type {App} */ b) => (Number(b.favorite) - Number(a.favorite))
        || ((b.updatedAt ?? 0) - (a.updatedAt ?? 0)));

    return m('div', [
      header,
      banner,
      m('input.library-search', {
        type: 'search',
        placeholder: 'Filter apps… (name, tag)',
        'aria-label': 'Filter apps',
        value: ui.query,
        oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.query = e.target.value; },
      }),
      shown.length === 0
        ? m('p.muted', ui.favOnly ? 'No favorites yet — tap a star to add one.' : 'Nothing matches.')
        : m('.library-grid', shown.map((/** @type {App} */ app) => LibrarySection.card(vnode, app))),
    ]);
  },

  /**
   * @param {{ state: any, attrs: { send: Send, dweb?: boolean } }} vnode
   * @param {App} app
   */
  card(vnode, app) {
    const ui = vnode.state;
    const busy = ui.busyId === app.id;
    const renaming = ui.renamingId === app.id;
    const armed = ui.armedDeleteId === app.id;

    const menuOpen = ui.menuOpenId === app.id;

    return m('.library-card', { key: app.id }, [
      m('.library-head', [
        m('.library-avatar', { style: `background:${colorOf(app.id || app.name)}`, 'aria-hidden': 'true' }, (app.name || '?').trim().charAt(0) || '?'),
        m('div', { style: 'flex:1; min-width:0;' }, [
          renaming
            ? m('input', {
                style: 'width:100%; font-size:14px;',
                value: ui.renameValue,
                oncreate: (/** @type {{ dom: HTMLInputElement }} */ v) => v.dom.focus(),
                oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.renameValue = e.target.value; },
                onkeydown: (/** @type {KeyboardEvent} */ e) => {
                  if (e.key === 'Enter') LibrarySection.commitRename(vnode, app);
                  if (e.key === 'Escape') { ui.renamingId = null; m.redraw(); }
                },
                onblur: () => LibrarySection.commitRename(vnode, app),
              })
            : m('.library-name', { title: app.name }, app.name),
          m('.muted.library-meta', [
            fmtWhen(app.updatedAt),
            app.source && app.source !== 'local' ? ` · ${app.source}` : '',
          ]),
        ]),
        m('button.icon.library-star', {
          title: app.favorite ? 'Unfavorite' : 'Favorite',
          'aria-pressed': String(!!app.favorite),
          class: app.favorite ? 'is-on' : '',
          onclick: () => LibrarySection.toggleFavorite(vnode, app),
        }, app.favorite ? '★' : '☆'),
      ]),
      (app.tags && app.tags.length)
        ? m('.library-tags', app.tags.slice(0, 4).map((/** @type {string} */ t) => m('span.library-tag', { key: t }, t)))
        : null,
      // A peer published a newer version of this installed app — flag it, the
      // Update button below pulls it.
      ui.updates[app.id]
        ? m('.library-update-badge', '● new version available')
        : null,
      // One primary (Open) + a kebab for the secondary actions, so Rename/Export/
      // Delete stop competing with Open for attention. The kebab is ALWAYS shown
      // (not hover-revealed) so touch + keyboard reach it.
      m('.library-actions', [
        m('button.library-open', { disabled: busy, onclick: () => LibrarySection.openApp(vnode, app) }, busy ? '…' : 'Open'),
        m('.spacer'),
        ui.updates[app.id]
          ? m('button.library-btn', {
              disabled: busy,
              title: 'Download the newer version a peer published (overwrites your copy in place)',
              onclick: () => LibrarySection.updateApp(vnode, app),
            }, busy ? '…' : 'Update')
          : null,
        vnode.attrs.dweb
          ? m('button.library-btn', {
              disabled: busy,
              title: isSeeded(app)
                ? 'Reshare: publish an updated version — peers who installed it see "update available"'
                : 'Share on the dweb, peers can discover and install it peer-to-peer',
              onclick: () => LibrarySection.openShare(vnode, app),
            }, ui.sharedId === app.id ? 'Shared ✓' : (isSeeded(app) ? 'Reshare' : 'Share'))
          : null,
        m('button.icon.library-kebab', {
          'aria-haspopup': 'menu', 'aria-expanded': String(menuOpen), title: 'More actions',
          onclick: (/** @type {Event} */ e) => { e.stopPropagation(); ui.menuOpenId = menuOpen ? null : app.id; ui.armedDeleteId = null; },
        }, '⋯'),
        menuOpen
          ? m('.library-menu', {
              role: 'menu',
              onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') { ui.menuOpenId = null; ui.armedDeleteId = null; m.redraw(); } },
            }, [
              m('button.library-menu-item', { role: 'menuitem', disabled: busy, onclick: () => { ui.menuOpenId = null; LibrarySection.startRename(vnode, app); } }, 'Rename'),
              m('button.library-menu-item', { role: 'menuitem', disabled: busy, onclick: () => { ui.menuOpenId = null; LibrarySection.exportApp(vnode, app); } }, 'Export'),
              m('.library-menu-sep'),
              // Seeded (shared / installed dwapp) apps get a "you're seeding this"
              // note above the armed Delete — deleting un-shares it (stops serving
              // its bytes to peers), and that's worth a heads-up before the click.
              armed && isSeeded(app)
                ? m('.library-menu-note.muted', { style: 'padding:4px 10px; font-size:11px; line-height:1.35;' },
                    'You’re seeding this app to peers. Deleting stops sharing it and removes your copy — peers who already installed it keep theirs.')
                : null,
              armed
                ? m('button.library-menu-item.is-danger', { role: 'menuitem', onclick: () => { ui.menuOpenId = null; LibrarySection.confirmDelete(vnode, app); } },
                    isSeeded(app) ? 'Stop sharing & delete?' : 'Delete?')
                : m('button.library-menu-item.is-danger', { role: 'menuitem', onclick: (/** @type {Event} */ e) => { e.stopPropagation(); ui.armedDeleteId = app.id; } }, 'Delete'),
            ])
          : null,
      ]),
      // The share dialog: name the app's dweb NAMESPACE. Editable on first share
      // (pre-filled from the name), LOCKED on reshare (the slug is the app's stable
      // identity — changing it forks a new app). Shows the full peerd:// handle so
      // the user sees exactly what peers will discover.
      ui.shareEditId === app.id ? LibrarySection.shareDialog(vnode, app) : null,
    ]);
  },

  /**
   * @param {{ state: any, attrs: { send: Send } }} vnode
   * @param {App} app
   */
  shareDialog(vnode, app) {
    const ui = vnode.state;
    const locked = !!app.dweb?.slug;
    const slug = locked ? app.dweb.slug : slugify(ui.shareSlug);
    const pubSuffix = app.dweb?.publisher ? `…${app.dweb.publisher.slice(-8)}` : 'you';
    return m('.library-share', { style: 'margin-top:8px; padding:8px; border:1px solid var(--border, #333); border-radius:6px;' }, [
      m('.muted', { style: 'font-size:11px; margin-bottom:4px;' },
        locked ? 'Publishing an updated version. Namespace (locked — it’s this app’s identity):' : 'Choose a namespace for this app (peers discover it by this):'),
      m('input', {
        style: 'width:100%; font-size:13px; margin-bottom:4px;',
        value: locked ? app.dweb.slug : ui.shareSlug,
        disabled: locked,
        spellcheck: 'false',
        oncreate: (/** @type {{ dom: HTMLInputElement }} */ v) => { if (!locked) v.dom.focus(); },
        oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.shareSlug = e.target.value; },
        onkeydown: (/** @type {KeyboardEvent} */ e) => {
          if (e.key === 'Enter' && slug) LibrarySection.shareApp(vnode, app);
          if (e.key === 'Escape') { LibrarySection.cancelShare(vnode); m.redraw(); }
        },
      }),
      m('.muted', { style: 'font-size:11px; font-family:monospace; word-break:break-all; margin-bottom:6px;' }, `peerd://${pubSuffix}/${slug || '…'}`),
      m('.library-actions', { style: 'gap:6px;' }, [
        m('button.library-btn', { disabled: !slug, onclick: () => LibrarySection.shareApp(vnode, app) }, locked ? 'Publish update' : 'Share'),
        m('button.library-btn', { onclick: () => { LibrarySection.cancelShare(vnode); m.redraw(); } }, 'Cancel'),
      ]),
    ]);
  },
};
