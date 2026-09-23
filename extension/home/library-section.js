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
// hue. why hash a DURABLE identity (seed key / content hash / name, never
// the per-install instance id): an app's color is a quiet identity, so it
// must survive reinstalls and agree with Discover (which hashes the
// content-stable dwapp_id). Hashing the instance id rerolled the hue on
// every install — the same app wore a different color per profile and per
// home tab, and the seeded commons app flickered the home-fulltab visual
// baseline in CI.
const BRAND = ['#00B7EB', '#EF4444', '#F59E0B', '#22C55E', '#D946EF'];
/** @param {string} [key] */
const colorOf = (key) => {
  let h = 0;
  for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BRAND[h % BRAND.length];
};
/** @param {App} app — the durable color key; see the why on BRAND above */
const colorKeyOf = (app) => app.dweb?.seed || app.dweb?.hash || app.name || app.id;

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
const isSeeded = (app) => !!(app?.shared || app?.dweb?.version_id || app?.dweb?.seed);

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

/** @param {string} appId */
const appCardSelector = (appId) => `.library-card[data-app-id="${CSS.escape(appId)}"]`;

// why: restore intents can outlive their moment. requestAnimationFrame is
// throttled in background documents, so a callback may land long after the
// interaction that scheduled it. The token lets the newest intent supersede
// older ones no matter which callback fires first, and lastRestoredTarget
// distinguishes "our own previous restore parked focus here" (fine to move)
// from a claim some OTHER surface made, like the History & Git panel's
// oncreate focus. A stale restore must never steal that claim; that theft
// was the race behind the flaky repository-focus test.
let libraryRestoreToken = 0;
/** @type {Element | null} */
let lastRestoredTarget = null;

/**
 * Move focus after Mithril has committed a mutation result. The fallback keeps
 * keyboard users inside the Library when the original card no longer exists.
 * @param {string | null} appId
 * @param {string} action
 */
const focusLibraryAction = (appId, action) => {
  const token = ++libraryRestoreToken;
  requestAnimationFrame(() => {
    if (token !== libraryRestoreToken) return;   // a newer restore superseded this one
    const active = document.activeElement;
    const foreignClaim = active && active !== document.body
      && active !== document.documentElement && active !== lastRestoredTarget;
    if (foreignClaim) return;
    const card = appId ? document.querySelector(appCardSelector(appId)) : null;
    const target = card?.querySelector(`[data-library-action="${action}"]`)
      ?? document.querySelector('.library-search')
      ?? document.querySelector('.library-refresh');
    if (target instanceof HTMLElement) {
      lastRestoredTarget = target;
      target.focus({ preventScroll: true });
    }
  });
};

export const LibrarySection = {
  /** @param {{ state: any, attrs: { send: Send, dweb?: boolean } }} vnode */
  oninit(vnode) {
    vnode.state.apps = null;        // null = loading
    vnode.state.error = null;
    vnode.state.warning = null;
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
    vnode.state.repositoryOpenId = null;
    vnode.state.repositories = {};     // appId -> { status, remote, commits }
    vnode.state.remoteInput = '';
    vnode.state.repositoryMessage = '';
    vnode.state.repositoryBranch = '';
    vnode.state.repositoryCheckout = '';
    vnode.state.repositoryDiffs = {};   // `${appId}:${oid}` -> bounded diff result
    vnode.state.repositoryDiffKey = null;
    vnode.state.repositoryFocusId = null;
    vnode.state.armedRestore = null;    // { appId, oid, expiresAt }: never arms another App
    vnode.state.updateConflictId = null;
    vnode.state.gitImportOpen = false;
    vnode.state.gitImportUrl = '';
    vnode.state.gitImportName = '';
    vnode.state.gitImportRef = '';
    vnode.state.gitImportBusy = false;
    vnode.state.notice = null;
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
      if (document.hidden || s.menuOpenId || s.renamingId || s.shareEditId || s.armedDeleteId
          || s.busyId || s.gitImportOpen || s.gitImportBusy) return;
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
    if (vnode.state._restoreTimer) clearTimeout(vnode.state._restoreTimer);
  },

  /** @param {{ state: any, attrs: { send: Send, dweb?: boolean } }} vnode */
  refresh(vnode) {
    // why: clearing the error here is what lets the Refresh button (which
    // is the only control rendered on the error screen) recover the view.
    vnode.state.error = null;
    vnode.state.warning = null;
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
      if (r?.ok) {
        const updates = r.updates ?? {};
        const id = vnode.state.updateConflictId;
        const current = vnode.state.updates[id];
        const fresh = updates[id];
        if (current && fresh && current.version_id === fresh.version_id && Number.isSafeInteger(current.conflictToken)) {
          fresh.conflictToken = current.conflictToken;
        }
        vnode.state.updates = updates;
        m.redraw();
      }
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
    const currentCard = document.querySelector(appCardSelector(app.id));
    const adjacentCard = currentCard?.nextElementSibling ?? currentCard?.previousElementSibling;
    const adjacentAppId = adjacentCard instanceof HTMLElement
      ? adjacentCard.dataset.appId ?? null
      : null;
    vnode.state.error = null;
    vnode.state.armedDeleteId = null;
    vnode.state.busyId = app.id;
    const r = await vnode.attrs.send({ type: 'apps/delete', appId: app.id });
    vnode.state.busyId = null;
    if (r?.ok) vnode.state.apps = (vnode.state.apps ?? []).filter((/** @type {App} */ a) => a.id !== app.id);
    else vnode.state.error = r?.error ?? 'delete failed';
    m.redraw();
    focusLibraryAction(r?.ok ? adjacentAppId : app.id, r?.ok ? 'open' : 'more');
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

  /** Clone a conforming App or dwapp repository through browser-native Git.
   * @param {{ state: any, attrs: { send: Send } }} vnode */
  async importGitApp(vnode) {
    const ui = vnode.state;
    const url = ui.gitImportUrl.trim();
    if (!url || ui.gitImportBusy) return;
    ui.error = null;
    ui.notice = null;
    ui.gitImportBusy = true;
    m.redraw();
    try {
      const reply = await vnode.attrs.send({
        type: 'apps/import-git',
        url,
        ...(ui.gitImportName.trim() ? { name: ui.gitImportName.trim() } : {}),
        ...(ui.gitImportRef.trim() ? { ref: ui.gitImportRef.trim() } : {}),
      });
      if (!reply?.ok) {
        ui.error = reply?.error ?? 'Git import failed';
        return;
      }
      const opened = await vnode.attrs.send({ type: 'apps/open', appId: reply.record.id });
      ui.gitImportOpen = false;
      ui.gitImportUrl = '';
      ui.gitImportName = '';
      ui.gitImportRef = '';
      ui.notice = opened?.ok
        ? `Imported ${reply.record?.name ?? 'App'} from Git and opened it with its bound actor.`
        : `Imported ${reply.record?.name ?? 'App'} from Git. Open it from Library to attach its actor. ${opened?.error ?? ''}`.trim();
      LibrarySection.refresh(vnode);
    } catch (error) {
      ui.error = /** @type {{message?:string}} */ (error)?.message ?? 'Git import failed';
    } finally {
      ui.gitImportBusy = false;
      m.redraw();
    }
  },

  /** Open/refresh the developer history panel without loading file bodies.
   * @param {{ state: any, attrs: { send: Send } }} vnode @param {App} app */
  async openRepository(vnode, app, refresh = false) {
    const ui = vnode.state;
    ui.menuOpenId = null;
    ui.error = null;
    if (!refresh) ui.notice = null;
    if (ui.repositoryOpenId === app.id && !refresh) {
      ui.repositoryOpenId = null;
      ui.armedRestore = null;
      ui.repositoryDiffKey = null;
      ui.repositoryFocusId = null;
      m.redraw();
      focusLibraryAction(app.id, 'more');
      return;
    }
    ui.repositoryOpenId = app.id;
    ui.repositoryFocusId = refresh ? null : app.id;
    // A cached diff compares the selected commit to a mutable working tree.
    // Opening or refreshing Git is the synchronization boundary for edits made
    // in the App tab and for every repository mutation below, so no prior
    // commit-to-tree preview remains truthful past this point.
    for (const key of Object.keys(ui.repositoryDiffs)) {
      if (key.startsWith(`${app.id}:`)) delete ui.repositoryDiffs[key];
    }
    if (ui.repositoryDiffKey?.startsWith(`${app.id}:`)) ui.repositoryDiffKey = null;
    ui.busyId = app.id;
    try {
      const [statusReply, historyReply] = await Promise.all([
        vnode.attrs.send({ type: 'apps/repository/status', appId: app.id }),
        vnode.attrs.send({ type: 'apps/repository/history', appId: app.id, depth: 20 }),
      ]);
      if (statusReply?.ok && historyReply?.ok) {
        ui.repositories[app.id] = {
          status: statusReply.status, remote: statusReply.remote ?? null,
          branches: statusReply.branches ?? [], commits: historyReply.commits ?? [],
        };
        ui.remoteInput = statusReply.remote?.url ?? '';
        // why: this field creates a new branch; echoing the current branch into
        // it makes a disabled action look pre-filled and invites accidental
        // edits. Existing-branch state belongs in the adjacent selector.
        if (!refresh) ui.repositoryBranch = '';
        ui.repositoryCheckout = statusReply.status?.branch ?? '';
      } else ui.error = statusReply?.error ?? historyReply?.error ?? 'repository history failed';
    } catch (error) {
      ui.error = /** @type {{message?:string}} */ (error)?.message ?? 'repository history failed';
    } finally {
      ui.busyId = null;
      m.redraw();
    }
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode @param {App} app @param {string} [message] */
  async checkpointRepository(vnode, app, message = 'manual checkpoint') {
    const ui = vnode.state;
    ui.error = null; ui.busyId = app.id;
    try {
      const r = await vnode.attrs.send({ type: 'apps/repository/commit', appId: app.id, message });
      if (!r?.ok) { ui.error = r?.error ?? 'checkpoint failed'; return; }
      ui.notice = r.result?.created ? 'Checkpoint saved.' : 'No changes to checkpoint.';
      if (r.result?.created) ui.repositoryMessage = '';
      await LibrarySection.openRepository(vnode, app, true);
    } catch (error) {
      ui.error = /** @type {{message?:string}} */ (error)?.message ?? 'checkpoint failed';
    } finally {
      ui.busyId = null;
      m.redraw();
    }
  },

  /** Load a bounded, text-only diff from a commit to the current working tree.
   * @param {{ state: any, attrs: { send: Send } }} vnode @param {App} app @param {string} oid */
  async repositoryDiff(vnode, app, oid) {
    const ui = vnode.state;
    const key = `${app.id}:${oid}`;
    if (ui.repositoryDiffKey === key) { ui.repositoryDiffKey = null; m.redraw(); return; }
    ui.repositoryDiffKey = key;
    if (ui.repositoryDiffs[key]) { m.redraw(); return; }
    ui.error = null; ui.busyId = app.id;
    try {
      const r = await vnode.attrs.send({ type: 'apps/repository/diff', appId: app.id, from: oid, to: null });
      if (!r?.ok) ui.error = r?.error ?? 'diff failed';
      else ui.repositoryDiffs[key] = r.diff;
    } catch (error) {
      ui.error = /** @type {{message?:string}} */ (error)?.message ?? 'diff failed';
    } finally {
      ui.busyId = null;
      m.redraw();
    }
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode @param {App} app */
  async repositoryCreateBranch(vnode, app) {
    const ui = vnode.state;
    const name = ui.repositoryBranch.trim();
    if (!name) return;
    ui.error = null; ui.busyId = app.id;
    try {
      const r = await vnode.attrs.send({ type: 'apps/repository/branch', appId: app.id, name, checkout: true });
      if (!r?.ok) ui.error = r?.error ?? 'branch failed';
      else {
        ui.notice = `Created and checked out ${name}.`;
        ui.repositoryBranch = '';
        await LibrarySection.openRepository(vnode, app, true);
      }
    } catch (error) {
      ui.error = /** @type {{message?:string}} */ (error)?.message ?? 'branch failed';
    } finally {
      ui.busyId = null;
      m.redraw();
    }
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode @param {App} app */
  async repositoryCheckoutBranch(vnode, app) {
    const ui = vnode.state;
    const name = ui.repositoryCheckout;
    if (!name || name === ui.repositories[app.id]?.status?.branch) return;
    ui.error = null; ui.busyId = app.id;
    try {
      const r = await vnode.attrs.send({ type: 'apps/repository/checkout', appId: app.id, name });
      if (!r?.ok) ui.error = r?.error ?? 'checkout failed';
      else {
        ui.notice = `Checked out ${name}.`;
        await LibrarySection.openRepository(vnode, app, true);
      }
    } catch (error) {
      ui.error = /** @type {{message?:string}} */ (error)?.message ?? 'checkout failed';
    } finally {
      ui.busyId = null;
      m.redraw();
    }
  },

  /** Link/fetch/push stays an explicit user gesture; secrets never return here.
   * @param {{ state: any, attrs: { send: Send } }} vnode @param {App} app
   * @param {'link'|'fetch'|'push'} op */
  async repositoryRemote(vnode, app, op) {
    const ui = vnode.state;
    ui.error = null; ui.notice = null; ui.busyId = app.id;
    try {
      const type = `apps/repository/${op}`;
      const r = await vnode.attrs.send({ type, appId: app.id, ...(op === 'link' ? { url: ui.remoteInput.trim() } : {}) });
      if (!r?.ok) ui.error = r?.error ?? `${op} failed`;
      else {
        ui.notice = op === 'push' ? 'Pushed without force.' : op === 'fetch'
          ? 'Fetched remote history. Your working branch was not merged or changed.' : 'Remote linked.';
        await LibrarySection.openRepository(vnode, app, true);
      }
    } catch (error) {
      ui.error = /** @type {{message?:string}} */ (error)?.message ?? `${op} failed`;
    } finally {
      ui.busyId = null;
      m.redraw();
    }
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode @param {App} app @param {string} oid */
  async restoreRepository(vnode, app, oid) {
    const ui = vnode.state;
    const now = Date.now();
    const armed = ui.armedRestore;
    if (!armed || armed.appId !== app.id || armed.oid !== oid || armed.expiresAt < now) {
      ui.armedRestore = { appId: app.id, oid, expiresAt: now + 10000 };
      if (ui._restoreTimer) clearTimeout(ui._restoreTimer);
      ui._restoreTimer = setTimeout(() => {
        if (ui.armedRestore?.appId === app.id && ui.armedRestore?.oid === oid) {
          ui.armedRestore = null; m.redraw();
        }
      }, 10000);
      m.redraw();
      return;
    }
    ui.armedRestore = null; ui.error = null; ui.busyId = app.id;
    try {
      const r = await vnode.attrs.send({ type: 'apps/repository/restore', appId: app.id, to: oid });
      if (!r?.ok) ui.error = r?.error ?? 'restore failed';
      else if (r.result?.restored) ui.notice = r.result?.checkpointOid
        ? `Restored as a new commit. Your previous working tree is preserved in safety checkpoint ${String(r.result.checkpointOid).slice(0, 10)}.`
        : 'Restored as a new commit; the prior history is still available.';
      else if (r.result?.checkpointOid) ui.notice = `The target already matched this branch. Your previous working tree is preserved in safety checkpoint ${String(r.result.checkpointOid).slice(0, 10)}.`;
      else ui.notice = 'Already at that version.';
      if (r?.ok) await LibrarySection.openRepository(vnode, app, true);
    } catch (error) {
      ui.error = /** @type {{message?:string}} */ (error)?.message ?? 'restore failed';
    } finally {
      ui.busyId = null;
      m.redraw();
    }
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
    try {
      const r = await vnode.attrs.send({ type: 'dweb/base/share-app', appId: app.id, slug });
      if (r?.ok) {
        vnode.state.sharedId = app.id;
        // Reflect the minted version identity locally so the button shows "Shared ✓"
        // and the next Share opens LOCKED to this slug (no refetch round-trip).
        app.shared = true;
        app.dweb = { ...(app.dweb || {}), slug: r.slug, dwapp_id: r.dwapp_id, version_id: r.hash, seq: r.seq, publisher: r.publisher, uri: r.uri };
        if (r.warning === 'previous-version-cleanup-pending') {
          vnode.state.warning = 'The update was shared. Older shared bytes will be cleaned up on the next share or delete.';
        }
      } else {
        vnode.state.error = r?.error === 'dweb-disabled'
          ? 'turn the base network on (unlock + dweb enabled) to share'
          : (r?.error ?? 'share failed');
      }
    } catch (error) {
      vnode.state.error = /** @type {{message?:string}} */ (error)?.message ?? 'share failed';
    } finally {
      vnode.state.busyId = null;
      m.redraw();
      focusLibraryAction(app.id, 'share');
    }
  },

  // Pull a newer announced version of an installed app, overwriting it in place.
  /**
   * @param {{ state: any, attrs: { send: Send } }} vnode
   * @param {App} app
   * @param {'fork'|'replace'} [strategy]
   */
  async updateApp(vnode, app, strategy) {
    const up = vnode.state.updates[app.id];
    if (!up) return;
    vnode.state.error = null;
    vnode.state.warning = null;
    vnode.state.busyId = app.id;
    let succeeded = false;
    try {
      const r = await vnode.attrs.send({ type: 'dweb/base/update-app', appId: app.id, uri: up.uri, name: up.name, dwappId: up.dwapp_id, slug: up.slug, seq: up.seq, publisher: up.publisher, ...(strategy ? { strategy, conflictToken: up.conflictToken } : {}) });
      if (r?.ok) {
        succeeded = true;
        delete vnode.state.updates[app.id];      // cleared: we're now on the new version
        if (r.app?.dweb) app.dweb = r.app.dweb;
        vnode.state.updateConflictId = null;
        vnode.state.notice = r.fork
          ? `Kept your local work as “${r.fork.name}” and updated this app.`
          : 'Updated to the verified peer release.';
        if (r.fork) LibrarySection.quietRefresh(vnode);
        const warnings = new Set(Array.isArray(r.warnings) ? r.warnings : []);
        if (r.warning) warnings.add(r.warning);
        const notices = [];
        if (warnings.has('audit-write-failed')) {
          notices.push('The update was installed, but its security audit entry could not be written.');
        } else if (warnings.has('previous-version-cleanup-pending')) {
          notices.push('The update was installed.');
        }
        if (warnings.has('previous-version-cleanup-pending')) {
          notices.push('Older shared bytes will be cleaned up on the next update or delete.');
        }
        vnode.state.warning = notices.join(' ') || null;
      } else if (r?.error === 'local-changes' && Number.isSafeInteger(r.conflictToken)) {
        up.conflictToken = r.conflictToken;
        vnode.state.updateConflictId = app.id;
      } else {
        vnode.state.error = r?.error ?? 'update failed';
      }
    } catch (error) {
      vnode.state.error = /** @type {{message?:string}} */ (error)?.message ?? 'update failed';
    } finally {
      vnode.state.busyId = null;
      m.redraw();
      focusLibraryAction(app.id, succeeded ? 'open' : 'update');
    }
  },

  /** @param {{ state: any, attrs: { send: Send, dweb?: boolean } }} vnode */
  view(vnode) {
    const ui = vnode.state;

    const header = m('div', { style: 'display:flex; align-items:center; gap:8px; margin:0 0 12px;' }, [
      m('p.muted', { style: 'margin:0; font-size:12px;' },
        ui.apps ? `${ui.apps.length} app${ui.apps.length === 1 ? '' : 's'}` : ''),
      m('.spacer', { style: 'flex:1;' }),
      m('button.library-btn', {
        type: 'button',
        'aria-expanded': String(ui.gitImportOpen),
        onclick: () => { ui.gitImportOpen = !ui.gitImportOpen; ui.error = null; },
      }, ui.gitImportOpen ? 'Cancel import' : 'Import Git'),
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
      return m('div', [
        header,
        ui.error ? m('p.error', { role: 'alert', 'aria-live': 'assertive' }, ui.error) : m('p.muted', 'Loading…'),
        ui.warning ? m('p.muted', { role: 'status', 'aria-live': 'polite' }, ui.warning) : null,
      ]);
    }
    const banners = [
      ui.error ? m('p.error', { role: 'alert', 'aria-live': 'assertive' }, ui.error) : null,
      ui.notice ? m('p.library-notice', { role: 'status', 'aria-live': 'polite' }, ui.notice) : null,
      ui.warning ? m('p.muted', { role: 'status', 'aria-live': 'polite' }, ui.warning) : null,
    ];
    const gitImport = ui.gitImportOpen ? m('form.library-git-import', {
      onsubmit: (/** @type {SubmitEvent} */ event) => {
        event.preventDefault();
        LibrarySection.importGitApp(vnode);
      },
    }, [
      m('strong', 'Import an App from Git'),
      m('p.muted', 'Clone an HTTPS repository containing peerd.json or index.html. A conforming dwapp keeps its dweb capability and actor role.'),
      m('div.library-git-import-row', [
        m('input', {
          type: 'url', required: true, spellcheck: false,
          placeholder: 'https://github.com/you/my-app',
          'aria-label': 'Git repository URL',
          value: ui.gitImportUrl,
          disabled: ui.gitImportBusy,
          oninput: (/** @type {{target:HTMLInputElement}} */ event) => { ui.gitImportUrl = event.target.value; },
        }),
        m('input', {
          type: 'text', spellcheck: false, placeholder: 'Branch or tag (optional)',
          'aria-label': 'Git branch or tag',
          value: ui.gitImportRef,
          disabled: ui.gitImportBusy,
          oninput: (/** @type {{target:HTMLInputElement}} */ event) => { ui.gitImportRef = event.target.value; },
        }),
        m('input', {
          type: 'text', maxlength: 80, placeholder: 'Display name (optional)',
          'aria-label': 'Imported App display name',
          value: ui.gitImportName,
          disabled: ui.gitImportBusy,
          oninput: (/** @type {{target:HTMLInputElement}} */ event) => { ui.gitImportName = event.target.value; },
        }),
        m('button.library-open', { type: 'submit', disabled: ui.gitImportBusy || !ui.gitImportUrl.trim() },
          ui.gitImportBusy ? 'Cloning…' : 'Clone App'),
      ]),
      m('p.muted.library-repository-help', 'Private repositories use the token for their Git host from Settings. Credentials never enter the App or its actor.'),
    ]) : null;
    if (ui.apps.length === 0) {
      return m('div', [header, ...banners, gitImport, m('p.muted',
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
      // Built-in seed apps pin to the top; then favorites; then most-recently-touched.
      .sort((/** @type {App} */ a, /** @type {App} */ b) => (Number(!!b.dweb?.seed) - Number(!!a.dweb?.seed))
        || (Number(b.favorite) - Number(a.favorite))
        || ((b.updatedAt ?? 0) - (a.updatedAt ?? 0)));

    return m('div', [
      header,
      ...banners,
      gitImport,
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
    const expanded = ui.repositoryOpenId === app.id || ui.updateConflictId === app.id;

    return m('.library-card', { key: app.id, class: expanded ? 'is-expanded' : '', 'data-app-id': app.id }, [
      m('.library-head', [
        m('.library-avatar', { style: `background:${colorOf(colorKeyOf(app))}`, 'aria-hidden': 'true' }, (app.name || '?').trim().charAt(0) || '?'),
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
            : m('.library-name', { title: app.name }, [
                app.name,
                // Built-in marker — a durable, monochrome chip driven off the
                // immutable dweb.seed field (no new record field needed).
                app.dweb?.seed
                  ? m('span', {
                      title: 'A built-in app, shipped with peerd',
                      style: 'margin-left:6px; padding:0 5px; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; border:1px solid currentColor; border-radius:4px; opacity:.5; vertical-align:middle;',
                    }, 'Built-in')
                  : null,
              ]),
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
        ? m('.library-update-badge', [
            '● new version available',
            ui.updates[app.id].changelog
              ? m('.library-changelog', ui.updates[app.id].changelog)
              : null,
          ])
        : null,
      // One primary (Open) + a kebab for the secondary actions, so Rename/Export/
      // Delete stop competing with Open for attention. The kebab is ALWAYS shown
      // (not hover-revealed) so touch + keyboard reach it.
      m('.library-actions', [
        m('button.library-open', {
          disabled: busy,
          'data-library-action': 'open',
          onclick: () => LibrarySection.openApp(vnode, app),
        }, busy ? '…' : 'Open'),
        m('.spacer'),
        ui.updates[app.id]
          ? m('button.library-btn', {
              disabled: busy,
              'data-library-action': 'update',
              title: 'Download the newer version a peer published (overwrites your copy in place)',
              onclick: () => LibrarySection.updateApp(vnode, app),
            }, busy ? '…' : 'Update')
          : null,
        vnode.attrs.dweb
          ? m('button.library-btn', {
              disabled: busy,
              'data-library-action': 'share',
              title: isSeeded(app)
                ? 'Reshare: publish an updated version — peers who installed it see "update available"'
                : 'Share on the dweb, peers can discover and install it peer-to-peer',
              onclick: () => LibrarySection.openShare(vnode, app),
            }, ui.sharedId === app.id ? 'Shared ✓' : (isSeeded(app) ? 'Reshare' : 'Share'))
          : null,
        m('button.icon.library-kebab', {
          'aria-haspopup': 'menu', 'aria-expanded': String(menuOpen), title: 'More actions',
          'data-library-action': 'more',
          onclick: (/** @type {Event} */ e) => { e.stopPropagation(); ui.menuOpenId = menuOpen ? null : app.id; ui.armedDeleteId = null; },
        }, '⋯'),
        menuOpen
          ? m('.library-menu', {
              role: 'menu',
              oncreate: (/** @type {{dom:HTMLElement}} */ v) => {
                const first = v.dom.querySelector('[role="menuitem"]:not(:disabled)');
                if (first instanceof HTMLElement) first.focus({ preventScroll: true });
              },
              onkeydown: (/** @type {KeyboardEvent} */ e) => {
                const menu = /** @type {HTMLElement} */ (e.currentTarget);
                const items = Array.from(menu.querySelectorAll('[role="menuitem"]:not(:disabled)'));
                const active = document.activeElement;
                const index = active ? items.indexOf(active) : -1;
                let target = null;
                if (e.key === 'ArrowDown') target = items[(index + 1 + items.length) % items.length];
                else if (e.key === 'ArrowUp') target = items[(index - 1 + items.length) % items.length];
                else if (e.key === 'Home') target = items[0];
                else if (e.key === 'End') target = items.at(-1);
                else if (e.key === 'Escape') {
                  ui.menuOpenId = null;
                  ui.armedDeleteId = null;
                  m.redraw();
                  focusLibraryAction(app.id, 'more');
                } else return;
                e.preventDefault();
                if (target instanceof HTMLElement) target.focus({ preventScroll: true });
              },
            }, [
              m('button.library-menu-item', { role: 'menuitem', disabled: busy, onclick: () => { ui.menuOpenId = null; LibrarySection.startRename(vnode, app); } }, 'Rename'),
              m('button.library-menu-item', { role: 'menuitem', disabled: busy, onclick: () => LibrarySection.openRepository(vnode, app) }, 'History & Git'),
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
      ui.repositoryOpenId === app.id ? LibrarySection.repositoryPanel(vnode, app) : null,
      ui.updateConflictId === app.id ? LibrarySection.updateConflict(vnode, app) : null,
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
        'aria-label': locked ? `Dweb namespace for ${app.name} (locked)` : `Dweb namespace for ${app.name}`,
        oncreate: (/** @type {{ dom: HTMLInputElement }} */ v) => { if (!locked) v.dom.focus(); },
        oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.shareSlug = e.target.value; },
        onkeydown: (/** @type {KeyboardEvent} */ e) => {
          if (e.key === 'Enter' && slug) LibrarySection.shareApp(vnode, app);
          if (e.key === 'Escape') { LibrarySection.cancelShare(vnode); m.redraw(); }
        },
      }),
      m('.muted', { style: 'font-size:11px; font-family:monospace; word-break:break-all; margin-bottom:6px;' }, `peerd://${pubSuffix}/${slug || '…'}`),
      m('.muted', { style: 'font-size:11px; margin-bottom:6px;' },
        'Sharing publishes every working-tree file, including data/*.json. Remove private data before continuing.'),
      m('.library-actions', { style: 'gap:6px;' }, [
        m('button.library-btn', { disabled: !slug, onclick: () => LibrarySection.shareApp(vnode, app) }, locked ? 'Publish update' : 'Share'),
        m('button.library-btn', { onclick: () => { LibrarySection.cancelShare(vnode); m.redraw(); } }, 'Cancel'),
      ]),
    ]);
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode @param {App} app */
  repositoryPanel(vnode, app) {
    const ui = vnode.state;
    const repo = ui.repositories[app.id];
    const panelAttrs = {
      role: 'region', 'aria-label': `History and Git for ${app.name}`, tabindex: '-1',
      'data-library-repository-id': app.id,
      oncreate: (/** @type {{dom:HTMLElement}} */ v) => {
        if (ui.repositoryFocusId !== app.id) return;
        ui.repositoryFocusId = null;
        v.dom.focus({ preventScroll: true });
      },
    };
    if (!repo) return m('.library-repository', panelAttrs, m('p.muted', 'Loading repository…'));
    const changed = repo.status?.changed ?? [];
    const isArmed = (/** @type {string} */ oid) => ui.armedRestore?.appId === app.id
      && ui.armedRestore?.oid === oid && ui.armedRestore?.expiresAt >= Date.now();
    return m('.library-repository', panelAttrs, [
      m('.library-repository-head', [
        m('strong', 'History & Git'),
        m('span.muted', `${repo.status?.branch ?? 'detached'} · ${String(repo.status?.oid ?? '').slice(0, 10) || 'empty'}`),
        m('button.icon', {
          title: 'Close history', 'aria-label': `Close Git history for ${app.name}`,
          onclick: () => {
            ui.repositoryOpenId = null; ui.armedRestore = null; ui.repositoryDiffKey = null;
            ui.repositoryFocusId = null;
            focusLibraryAction(app.id, 'more');
          },
        }, '×'),
      ]),
      changed.length
        ? m('.library-repository-dirty', [
            m('span', `${changed.length} uncommitted change${changed.length === 1 ? '' : 's'}`),
            m('input', {
              type: 'text', value: ui.repositoryMessage, maxlength: 160,
              placeholder: 'What changed? (no secrets)',
              'aria-label': `Checkpoint message for ${app.name}`,
              disabled: ui.busyId === app.id,
              oninput: (/** @type {{target:HTMLInputElement}} */ e) => { ui.repositoryMessage = e.target.value; },
              onkeydown: (/** @type {KeyboardEvent} */ e) => {
                if (e.key === 'Enter') LibrarySection.checkpointRepository(vnode, app, ui.repositoryMessage.trim() || 'manual checkpoint');
              },
            }),
            m('button.library-btn', {
              disabled: ui.busyId === app.id,
              onclick: () => LibrarySection.checkpointRepository(vnode, app, ui.repositoryMessage.trim() || 'manual checkpoint'),
            }, 'Checkpoint'),
          ])
        : m('p.muted.library-repository-clean', 'Working tree clean.'),
      changed.length ? m('.library-change-list', changed.slice(0, 8).map((/** @type {any} */ row) => m('code', `${row.status}  ${row.path}`))) : null,
      m('.library-branch-row', [
        repo.branches?.length > 1 ? m('select', {
          value: ui.repositoryCheckout,
          'aria-label': `Existing Git branch for ${app.name}`,
          disabled: ui.busyId === app.id || repo.status?.dirty,
          onchange: (/** @type {{target:HTMLSelectElement}} */ e) => { ui.repositoryCheckout = e.target.value; },
        }, repo.branches.map((/** @type {string} */ name) => m('option', { value: name }, name))) : null,
        repo.branches?.length > 1 ? m('button.library-btn', {
          disabled: !ui.repositoryCheckout || ui.repositoryCheckout === repo.status?.branch || repo.status?.dirty || ui.busyId === app.id,
          onclick: () => LibrarySection.repositoryCheckoutBranch(vnode, app),
        }, 'Switch') : null,
        m('input', {
          type: 'text', spellcheck: false, value: ui.repositoryBranch,
          placeholder: 'feature/my-change', 'aria-label': `New branch name for ${app.name}`,
          disabled: ui.busyId === app.id,
          oninput: (/** @type {{target:HTMLInputElement}} */ e) => { ui.repositoryBranch = e.target.value; },
        }),
        m('button.library-btn', {
          disabled: !ui.repositoryBranch.trim() || ui.repositoryBranch.trim() === repo.status?.branch || ui.busyId === app.id,
          onclick: () => LibrarySection.repositoryCreateBranch(vnode, app),
        }, 'New branch'),
      ]),
      m('.library-remote-row', [
        m('input', {
          type: 'url', spellcheck: false, placeholder: 'https://github.com/you/repo',
          'aria-label': `Git remote URL for ${app.name}`,
          value: ui.remoteInput,
          oninput: (/** @type {{target:HTMLInputElement}} */ e) => { ui.remoteInput = e.target.value; },
        }),
        m('button.library-btn', { disabled: !ui.remoteInput.trim() || ui.busyId === app.id, onclick: () => LibrarySection.repositoryRemote(vnode, app, 'link') }, repo.remote ? 'Relink' : 'Link'),
      ]),
      repo.remote ? m('.library-remote-actions', [
        m('span.muted', repo.remote.url),
        m('button.library-btn', { disabled: ui.busyId === app.id, onclick: () => LibrarySection.repositoryRemote(vnode, app, 'fetch') }, 'Fetch'),
        m('button.library-btn', { disabled: ui.busyId === app.id, onclick: () => LibrarySection.repositoryRemote(vnode, app, 'push') }, 'Push'),
      ]) : m('p.muted.library-repository-clean', 'Link a new, empty HTTPS remote for backup. Add a host token under Settings → API integrations for private repositories.'),
      m('p.muted.library-repository-help', [
        'Fetch downloads remote history but never merges or overwrites this App. Push checkpoints and sends every working-tree file, including data/*.json. Use Import Git for an existing App repository; repositories needing LFS, submodules, symlinks, or a large history belong in a WebVM.',
      ]),
      m('.library-commit-list', repo.commits.map((/** @type {any} */ commit) => {
        const key = `${app.id}:${commit.oid}`;
        const diff = ui.repositoryDiffs[key];
        const open = ui.repositoryDiffKey === key;
        return m('.library-commit-block', { key: commit.oid }, [
          m('.library-commit', [
            m('code', commit.oid.slice(0, 10)),
            m('span.library-commit-message', [commit.safety ? m('span', { title: 'Private recovery checkpoint' }, 'safety · ') : null, commit.message || '(no message)']),
            m('span.muted', fmtWhen(commit.timestamp)),
            commit.safety ? null : m('button.library-btn', {
              disabled: ui.busyId === app.id,
              'aria-expanded': String(open),
              'aria-label': `${open ? 'Hide' : 'Show'} changes since ${commit.message || commit.oid.slice(0, 10)}`,
              onclick: () => LibrarySection.repositoryDiff(vnode, app, commit.oid),
            }, open ? 'Hide diff' : 'Diff'),
            m('button.library-btn', {
              class: isArmed(commit.oid) ? 'is-armed' : '',
              disabled: ui.busyId === app.id,
              'aria-label': `${isArmed(commit.oid) ? 'Confirm restore' : 'Restore'} ${app.name} to ${commit.message || commit.oid.slice(0, 10)}`,
              onclick: () => LibrarySection.restoreRepository(vnode, app, commit.oid),
            }, isArmed(commit.oid) ? 'Restore?' : 'Restore'),
          ]),
          open ? m('.library-diff', { 'aria-live': 'polite' }, [
            diff
              ? [m('.muted.library-diff-summary', `${diff.files?.length ?? 0} changed file${diff.files?.length === 1 ? '' : 's'}${diff.truncated ? ' · preview truncated' : ''}`),
                  m('pre', diff.patch || (diff.files?.length ? 'Binary or large-file changes cannot be previewed.' : 'No changes.'))]
              : m('p.muted', 'Loading diff…'),
          ]) : null,
        ]);
      })),
    ]);
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode @param {App} app */
  updateConflict(vnode, app) {
    const ui = vnode.state;
    return m('.library-update-conflict', { role: 'group', 'aria-live': 'assertive', 'aria-label': `Resolve update conflict for ${app.name}` }, [
      m('strong', 'You changed this app locally.'),
      m('p', 'The peer update will not overwrite those changes silently. Keep a local fork, or explicitly replace this copy with the verified release.'),
      m('.library-actions', [
        m('button.library-open', { disabled: ui.busyId === app.id, onclick: () => LibrarySection.updateApp(vnode, app, 'fork') }, 'Keep a fork & update'),
        m('button.library-btn', { disabled: ui.busyId === app.id, onclick: () => LibrarySection.updateApp(vnode, app, 'replace') }, 'Replace local copy'),
        m('button.library-btn', { onclick: () => { ui.updateConflictId = null; } }, 'Cancel'),
      ]),
    ]);
  },
};
