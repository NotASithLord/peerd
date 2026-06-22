// @ts-check
// home/discover-section.js — the dweb app store (discover, dweb preview only).
//
// Apps peers SHARE on the always-on base network show up here: their record
// (name + publisher + content uri) rides gossip (re-announced so late joiners
// hear it) and is durable in the DHT. One click fetches the signed bundle over
// the base mesh, verifies it, and installs it into your Library — peer-to-peer,
// no server. A pure CLIENT (SW routes only; never imports the dweb module), so
// the store build prunes nothing here but it never mounts (DWEB_ENABLED gate).

import m from '/vendor/mithril/mithril.js';

/** @typedef {import('../options/sections/reset-row.js').Send} Send */
/** @typedef {{ dwapp_id?: string, uri?: string, name?: string, slug?: string, seq?: number, publisher?: string, from?: string, version_id?: string }} DwebApp */

/** @param {string} [did] */
const short = (did) => (typeof did === 'string' ? did.slice(-8) : '????????');

// Latest record per dwapp_id (re-announcements refresh it).
/** @param {DwebApp[]} apps */
const dedupe = (apps) => {
  /** @type {Map<string, DwebApp>} */
  const seen = new Map();
  for (const a of apps || []) if (a?.dwapp_id) seen.set(a.dwapp_id, a);
  return [...seen.values()];
};

/** The Discover section, mounted on the home page (DWEB_ENABLED only). attrs: { send } */
export const DiscoverSection = () => {
  /** @type {DwebApp[]} */
  let apps = [];
  let loading = true;
  /** @type {string | null} */
  let error = null;
  /** @type {ReturnType<typeof setInterval> | number} */
  let timer = 0;
  let dead = false;
  /** @type {Record<string, string>} */
  const busy = {};         // dwapp_id -> 'installing' | 'installed' | <error string>
  /** @type {Record<string, string | null>} */
  const installedId = {};  // dwapp_id -> the local app id created by THIS session's install
  /** @type {string | null} */
  let myDid = null;        // our own publisher did — cards we published are "by you"
  /** @type {Map<string, string>} */
  let installedByUri = new Map(); // peerd:// uri -> local app id, for apps already in the Library
  /** @type {Map<string, { appId: string, version_id: string | null, seq: number }>} */
  let installedByDwappId = new Map(); // dwapp_id -> { appId, version_id, seq } — for version compare

  // Cross-reference the local side so Discover doesn't offer to "install" what's
  // already here (or what WE published) AND can tell an installed app apart from a
  // newer announce of it. did is fetched once; the installed maps are cheap
  // metadata, refreshed alongside the heard list. Best-effort — a failure just
  // falls back to the old "everything installable" view.
  /** @param {Send} send */
  const loadLocal = async (send) => {
    try {
      if (!myDid) { const s = await send({ type: 'dweb/base/status' }); if (s?.did) myDid = s.did; }
      const list = await send({ type: 'apps/list' });
      /** @type {Map<string, string>} */
      const byUri = new Map();
      /** @type {Map<string, { appId: string, version_id: string | null, seq: number }>} */
      const byId = new Map();
      for (const a of (list?.apps ?? [])) {
        if (a?.dweb?.uri) byUri.set(a.dweb.uri, a.id);
        if (a?.dweb?.dwapp_id) byId.set(a.dweb.dwapp_id, { appId: a.id, version_id: a.dweb.version_id ?? null, seq: a.dweb.seq ?? 0 });
      }
      installedByUri = byUri;
      installedByDwappId = byId;
    } catch { /* best-effort — leave prior values */ }
  };

  /** @param {Send} send */
  const refresh = async (send) => {
    try {
      const r = await send({ type: 'dweb/base/heard' });
      if (r && r.ok === false) { error = r.error || 'unavailable'; }
      else { apps = dedupe(r?.apps); error = null; }
    } catch (e) { error = /** @type {{ message?: string }} */ (e)?.message || String(e); }
    loading = false;
    if (!dead) m.redraw();
  };

  /**
   * @param {Send} send
   * @param {DwebApp} app
   */
  const install = async (send, app) => {
    // why the guard: install is only ever wired to cards that carry a
    // dwapp_id (it keys every record + the busy/installed maps); the guard
    // makes that invariant explicit without changing behavior.
    const id = app.dwapp_id;
    if (!id) return;
    busy[id] = 'installing';
    if (!dead) m.redraw();
    try {
      // Pass the card's version identity so the installed record can later be
      // matched against newer announces ("update available").
      const r = await send({ type: 'dweb/base/install', uri: app.uri, name: app.name, dwappId: id, slug: app.slug, seq: app.seq });
      if (r?.ok) {
        busy[id] = 'installed';
        installedId[id] = r.app?.id ?? r.appId ?? null;
        // Tell the Library (sibling section) to re-fetch so the freshly installed
        // app shows up there immediately — no shared store between sections, so a
        // page-level CustomEvent is the decoupled bus.
        try { window.dispatchEvent(new CustomEvent('peerd:app-installed', { detail: { appId: installedId[id] } })); } catch { /* no-op */ }
        loadLocal(send); // refresh the installed maps so this card flips to "Open"
      } else {
        busy[id] = r?.error || 'install failed';
      }
    } catch (e) { busy[id] = /** @type {{ message?: string }} */ (e)?.message || 'install failed'; }
    if (!dead) m.redraw();
  };

  // Update an already-installed app in place to this newer announced version.
  /**
   * @param {Send} send
   * @param {DwebApp} app
   * @param {string} appId
   */
  const update = async (send, app, appId) => {
    // why the guard: same invariant as install — an update card always has a
    // dwapp_id keying the busy map.
    const id = app.dwapp_id;
    if (!id) return;
    busy[id] = 'updating';
    if (!dead) m.redraw();
    try {
      const r = await send({ type: 'dweb/base/update-app', appId, uri: app.uri, name: app.name, dwappId: id, slug: app.slug, seq: app.seq });
      if (r?.ok) {
        busy[id] = 'installed';
        try { window.dispatchEvent(new CustomEvent('peerd:app-installed', { detail: { appId } })); } catch { /* no-op */ }
        loadLocal(send); // pick up the new version_id so the "update" state clears
      } else {
        busy[id] = r?.error || 'update failed';
      }
    } catch (e) { busy[id] = /** @type {{ message?: string }} */ (e)?.message || 'update failed'; }
    if (!dead) m.redraw();
  };

  /**
   * @param {Send} send
   * @param {string | null} appId
   */
  const open = async (send, appId) => {
    if (!appId) return;
    try { await send({ type: 'apps/open', appId }); } catch { /* surfaced elsewhere */ }
  };

  return {
    /** @param {{ attrs: { send: Send } }} vnode */
    oninit(vnode) { loadLocal(vnode.attrs.send); refresh(vnode.attrs.send); },
    /** @param {{ attrs: { send: Send } }} vnode */
    oncreate(vnode) {
      timer = setInterval(() => { if (!document.hidden) { loadLocal(vnode.attrs.send); refresh(vnode.attrs.send); } }, 4000);
    },
    onremove() { dead = true; if (timer) clearInterval(timer); },
    /** @param {{ attrs: { send: Send } }} vnode */
    view(vnode) {
      const send = vnode.attrs.send;
      if (loading && !apps.length) return m('.peerd-disc', m('.peerd-net-empty', 'Listening for apps your peers are running…'));
      if (!apps.length) {
        return m('.peerd-disc', m('.peerd-net-empty',
          'Nothing shared yet. Share an app from your Library, or ask the agent to build and '
          + 'share one, and it spreads to your peers. Or wait for one of theirs to arrive.'));
      }
      return m('ul.peerd-disc-list', apps.map((app) => {
        // dedupe guarantees every heard app carries a dwapp_id; this keeps that
        // invariant explicit (it keys the maps + the row) without behavior change.
        const id = app.dwapp_id;
        if (!id) return null;
        const state = busy[id];
        // mine = WE published it (it's already in our Library, above) — never offer
        // to install your own app, and credit it to "you", not your did suffix.
        const mine = !!myDid && (app.publisher === myDid || app.from === myDid);
        // localId: the Library app this card maps to — this session's install, or
        // a prior install matched by content uri (survives a hard refresh).
        const tracked = installedByDwappId.get(id);
        const localId = installedId[id] || (app.uri ? installedByUri.get(app.uri) : null) || tracked?.appId || null;
        const installed = state === 'installed' || !!localId;
        // An update is a newer announce of an app we already installed: a higher seq
        // pointing at a different version_id than the copy we hold.
        const updatable = !!tracked && !!app.version_id
          && app.version_id !== tracked.version_id && (app.seq ?? 0) > (tracked.seq ?? 0);
        const failed = typeof state === 'string' && !['installing', 'installed', 'updating'].includes(state);
        return m('li.peerd-disc-row', { key: id }, [
          m('.peerd-disc-meta', [
            m('span.peerd-disc-name', app.name || id.slice(0, 12)),
            m('span.peerd-disc-pub', mine ? 'by you' : `from …${short(app.publisher || app.from)}`),
            updatable && !failed ? m('span.peerd-disc-badge', { title: 'A newer version is available' }, 'update available') : null,
            failed ? m('span.peerd-disc-err', state) : null,
          ]),
          mine
            ? m('span.peerd-disc-done', 'in your Library')
            : installed && updatable
              ? m('button.peerd-net-btn', {
                disabled: state === 'updating',
                // localId is non-null in this branch (updatable ⇒ tracked ⇒ tracked.appId).
                onclick: () => update(send, app, /** @type {string} */ (localId)),
              }, state === 'updating' ? 'Updating…' : failed ? 'Retry update' : 'Update')
              : installed
                ? (localId
                  ? m('button.peerd-net-btn', { onclick: () => open(send, localId) }, 'Open ↗')
                  : m('span.peerd-disc-done', 'installed ✓ — in your Library'))
                : m('button.peerd-net-btn', {
                  disabled: state === 'installing' || !app.uri,
                  onclick: () => install(send, app),
                }, state === 'installing' ? 'Installing…' : failed ? 'Retry' : 'Install'),
        ]);
      }));
    },
  };
};
