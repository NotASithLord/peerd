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
import { discoveryAddress } from './discovery-address.js';
import { exploreOrder, EXPLORE_PAGE, EXPLORE_WINDOW } from './explore-order.js';

/** @typedef {import('../options/sections/reset-row.js').Send} Send */
/** @typedef {{ dwapp_id?: string, uri?: string, name?: string, slug?: string, seq?: number, publisher?: string, from?: string, version_id?: string, description?: string, size?: number, includes_wasm?: boolean|null }} DwebApp */

/** @param {string} [did] */
const short = (did) => (typeof did === 'string' ? did.slice(-8) : '????????');

// p·cyan e·red e·amber r·green d·magenta — each shared app's avatar gets ONE
// brand hue, hashed from its dwapp_id so it's stable across re-announces. Same
// recipe as the Library (library-section.js) so the two home tabs read as one
// surface — the sanctioned splash of color on a monochrome page.
const BRAND = ['#00B7EB', '#EF4444', '#F59E0B', '#22C55E', '#D946EF'];
/** @param {string} [key] */
const colorOf = (key) => {
  let h = 0;
  for (const ch of String(key || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return BRAND[h % BRAND.length];
};

// Latest record per dwapp_id (re-announcements refresh it).
/** @param {DwebApp[]} apps */
const dedupe = (apps) => {
  /** @type {Map<string, DwebApp>} */
  const seen = new Map();
  for (const a of apps || []) if (a?.dwapp_id) seen.set(a.dwapp_id, a);
  return [...seen.values()];
};

/** The Discover section, mounted on the home page (DWEB_ENABLED only).
 * @param {{attrs?:{initialSeed?:number}}} [initialVnode] */
export const DiscoverSection = (initialVnode) => {
  /** @type {DwebApp[]} */
  let apps = [];
  let loading = true;
  /** @type {string | null} */
  let error = null;
  /** @type {ReturnType<typeof setInterval> | number} */
  let timer = 0;
  let dead = false;
  let query = '';          // client-side filter over the heard list (name / peer)
  let wasm = 'all';
  let libraryFilter = 'all';
  let localReady = false;
  let localFailed = false;
  let seed = initialVnode?.attrs?.initialSeed ?? crypto.getRandomValues(new Uint32Array(1))[0];
  let limit = EXPLORE_PAGE;
  let offset = 0;
  /** @type {string[]} */ let orderedIds = [];
  /** @type {{id:string,address:string,status:'pending'|'copied'|'failed'}|null} */
  let copyState = null;
  let refreshing = false;  // drives the manual ↻ spin (the 4s poll stays silent)
  /** @type {(() => void) | null} */
  let onVisible = null;    // focus/visibility re-sync handler (removed on teardown)
  /** @type {Record<string, string>} */
  const busy = {};         // dwapp_id -> 'installing' | 'installed' | <error string>
  /** @type {Record<string, string>} */
  const notices = {};      // committed success warnings that still need user attention
  /** @type {Map<string, {action:'install'|'update', versionId:string|null, seq:number|null, uri:string|null}>} */
  const unconfirmed = new Map(); // exact Class-E targets awaiting catalog reconciliation
  /** @type {Record<string, string | null>} */
  const installedId = {};  // dwapp_id -> the local app id created by THIS session's install
  /** @type {string | null} */
  let myDid = null;        // our own publisher did — cards we published are "by you"
  /** @type {Map<string, string>} */
  let installedByUri = new Map(); // peerd:// uri -> local app id, for apps already in the Library
  /** @type {Map<string, { appId: string, version_id: string | null, seq: number }>} */
  let installedByDwappId = new Map(); // dwapp_id -> { appId, version_id, seq } — for version compare
  /** @type {Promise<boolean> | null} */
  let localInFlight = null;
  /** @type {Promise<boolean> | null} */
  let refreshInFlight = null;
  let refreshEpoch = 0;
  let appliedRefreshEpoch = 0;

  // Cross-reference the local side so Discover doesn't offer to "install" what's
  // already here (or what WE published) AND can tell an installed app apart from a
  // newer announce of it. did is fetched once; the installed maps are cheap
  // metadata, refreshed alongside the heard list. Best-effort — a failure just
  // falls back to the old "everything installable" view.
  /** @param {Send} send */
  const loadLocal = (send) => {
    if (localInFlight) return localInFlight;
    localInFlight = (async () => {
      try {
      if (!myDid) { const s = await send({ type: 'dweb/base/status' }); if (s?.did) myDid = s.did; }
      const list = await send({ type: 'apps/list' });
      if (!list?.ok || !Array.isArray(list.apps)) throw new Error('app-catalog-unavailable');
      /** @type {Map<string, string>} */
      const byUri = new Map();
      /** @type {Map<string, { appId: string, version_id: string | null, seq: number }>} */
      const byId = new Map();
      for (const a of list.apps) {
        if (a?.dweb?.uri) byUri.set(a.dweb.uri, a.id);
        if (a?.dweb?.dwapp_id) byId.set(a.dweb.dwapp_id, { appId: a.id, version_id: a.dweb.version_id ?? null, seq: a.dweb.seq ?? 0 });
      }
      installedByUri = byUri;
      installedByDwappId = byId;
      localReady = true;
      localFailed = false;
      for (const [id, target] of unconfirmed) {
        const local = byId.get(id);
        const identityMatches = !!local
          && (target.versionId === null || local.version_id === target.versionId)
          && (target.seq === null || local.seq >= target.seq);
        const uriOnlyMatches = target.action === 'install' && target.versionId === null
          && target.seq === null && !!target.uri && !!byUri.get(target.uri);
        if (identityMatches || uriOnlyMatches) {
          installedId[id] = local?.appId ?? /** @type {string} */ (byUri.get(/** @type {string} */ (target.uri)));
          busy[id] = 'installed';
          unconfirmed.delete(id);
        }
        // Absence is not a causal receipt: the original install/update send
        // may still be alive after the UI deadline and can commit later. Keep
        // the effect fenced until the exact App identity appears. Re-enabling
        // on an empty poll can mint duplicate installs with fresh App ids.
      }
      return true;
      } catch { localFailed = true; return false; /* retain the last confirmed Library */ }
      finally { localInFlight = null; if (!dead) m.redraw(); }
    })();
    return localInFlight;
  };

  /** @param {string} id @param {'install'|'update'} action @param {DwebApp} app */
  const markUnknown = (id, action, app) => {
    unconfirmed.set(id, {
      action,
      versionId: typeof app.version_id === 'string' ? app.version_id : null,
      seq: Number.isSafeInteger(app.seq) && /** @type {number} */ (app.seq) >= 0
        ? /** @type {number} */ (app.seq) : null,
      uri: typeof app.uri === 'string' ? app.uri : null,
    });
    busy[id] = `Peerd could not confirm whether the ${action} finished. Refresh to reconcile before trying again.`;
  };

  /** @param {string} id @param {'install'|'update'} action @param {DwebApp} app @param {unknown} result */
  const markFailure = (id, action, app, result) => {
    if (/** @type {{outcomeKnown?:boolean}} */ (result)?.outcomeKnown === false) {
      markUnknown(id, action, app);
      return;
    }
    unconfirmed.delete(id);
    busy[id] = `Peerd could not ${action} this App. Try again.`;
  };

  /** @param {Send} send */
  const refresh = (send) => {
    if (refreshInFlight) return refreshInFlight;
    const epoch = ++refreshEpoch;
    refreshInFlight = (async () => {
      try {
        const r = await send({ type: 'dweb/base/heard' });
        if (r?.ok === false || !Array.isArray(r?.apps)) throw new Error('discover-unavailable');
        if (epoch >= appliedRefreshEpoch) {
          appliedRefreshEpoch = epoch;
          const next = dedupe(r.apps);
          const present = new Set(next.map(app => app.dwapp_id));
          // A refresh is not an effect receipt. Retain the exact pending card,
          // including its version, until the mutation can be reconciled.
          const pending = new Map(apps.filter(app => app.dwapp_id
            && (unconfirmed.has(app.dwapp_id) || ['installing', 'updating'].includes(busy[app.dwapp_id])))
            .map(app => [app.dwapp_id, app]));
          apps = [...next.map(app => pending.get(app.dwapp_id) ?? app),
            ...[...pending.values()].filter(app => !present.has(app.dwapp_id))];
          error = null;
        }
        return true;
      } catch (cause) {
        if (epoch >= appliedRefreshEpoch) {
          error = 'Peerd could not refresh peer apps. Retry when the network is available.';
        }
        void cause;
        return false;
      } finally {
        loading = false;
        refreshInFlight = null;
        if (!dead) m.redraw();
      }
    })();
    return refreshInFlight;
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
    delete notices[id];
    if (!dead) m.redraw();
    try {
      // Pass the card's version identity so the installed record can later be
      // matched against newer announces ("update available").
      const r = await send({ type: 'dweb/base/install', uri: app.uri, name: app.name, dwappId: id, slug: app.slug, seq: app.seq, publisher: app.publisher });
      if (r?.ok) {
        busy[id] = 'installed';
        if (r.warning === 'audit-write-failed') {
          notices[id] = 'Installed, but the security audit entry could not be written.';
        }
        installedId[id] = r.app?.id ?? r.appId ?? null;
        // Tell the Library (sibling section) to re-fetch so the freshly installed
        // app shows up there immediately — no shared store between sections, so a
        // page-level CustomEvent is the decoupled bus.
        try { window.dispatchEvent(new CustomEvent('peerd:app-installed', { detail: { appId: installedId[id] } })); } catch { /* no-op */ }
        loadLocal(send); // refresh the installed maps so this card flips to "Open"
      } else {
        markFailure(id, 'install', app, r);
      }
    } catch (cause) { markUnknown(id, 'install', app); void cause; }
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
    delete notices[id];
    if (!dead) m.redraw();
    try {
      const r = await send({ type: 'dweb/base/update-app', appId, uri: app.uri, name: app.name, dwappId: id, slug: app.slug, seq: app.seq, publisher: app.publisher });
      if (r?.ok) {
        busy[id] = 'installed';
        const warnings = new Set(Array.isArray(r.warnings) ? r.warnings : []);
        if (r.warning) warnings.add(r.warning);
        const warningMessages = [];
        if (warnings.has('audit-write-failed')) {
          warningMessages.push('Updated, but the security audit entry could not be written.');
        } else if (warnings.has('previous-version-cleanup-pending')) {
          warningMessages.push('Updated.');
        }
        if (warnings.has('previous-version-cleanup-pending')) {
          warningMessages.push('Older shared bytes will be cleaned up on the next update or delete.');
        }
        if (warningMessages.length) notices[id] = warningMessages.join(' ');
        try { window.dispatchEvent(new CustomEvent('peerd:app-installed', { detail: { appId } })); } catch { /* no-op */ }
        loadLocal(send); // pick up the new version_id so the "update" state clears
      } else {
        markFailure(id, 'update', app, r);
      }
    } catch (cause) { markUnknown(id, 'update', app); void cause; }
    if (!dead) m.redraw();
  };

  /**
   * @param {Send} send
   * @param {string | null} appId
   * @param {string} discoveryId
   */
  const open = async (send, appId, discoveryId) => {
    if (!appId) return;
    try {
      const result = await send({ type: 'apps/open', appId });
      if (!result?.ok) busy[discoveryId] = result?.error || 'App could not be opened';
    } catch (e) {
      busy[discoveryId] = /** @type {{ message?: string }} */ (e)?.message || 'App could not be opened';
    }
    if (!dead) m.redraw();
  };

  // The manual ↻: spin while a one-shot re-sync runs. The background 4s poll
  // stays silent (it would flicker the spinner every tick), so only this path
  // toggles `refreshing`.
  /** @param {Send} send */
  const manualRefresh = async (send) => {
    if (refreshing) return;
    refreshing = true; if (!dead) m.redraw();
    await Promise.allSettled([loadLocal(send), refresh(send)]);
    refreshing = false; if (!dead) m.redraw();
  };

  /** @param {DwebApp} app */
  const copyAddress = async app => {
    if (dead || copyState?.status === 'pending' || !app.dwapp_id) return;
    const address = discoveryAddress(app);
    if (!address) return;
    const attempt = { id: app.dwapp_id, address, status: /** @type {'pending'|'copied'|'failed'} */ ('pending') };
    copyState = attempt;
    try {
      await navigator.clipboard.writeText(address);
      if (!dead && copyState === attempt) attempt.status = 'copied';
    } catch {
      if (!dead && copyState === attempt) attempt.status = 'failed';
    } finally { if (!dead) m.redraw(); }
  };

  // One heard app as a card — same chrome as a Library card (avatar + name +
  // meta + explicit actions), so Discover and the Library read as one
  // surface. All the install/update/open/mine logic is unchanged from the old
  // row; only the layout moved into a card.
  /**
   * @param {Send} send
   * @param {DwebApp} app
   */
  const card = (send, app) => {
    const id = app.dwapp_id;
    if (!id) return null;
    const state = busy[id];
    const mine = !!myDid && (app.publisher === myDid || app.from === myDid);
    const tracked = installedByDwappId.get(id);
    const localId = installedId[id] || (app.uri ? installedByUri.get(app.uri) : null) || tracked?.appId || null;
    const installed = state === 'installed' || !!localId;
    const updatable = !!tracked && !!app.version_id
      && app.version_id !== tracked.version_id && (app.seq ?? 0) > (tracked.seq ?? 0);
    const failed = typeof state === 'string' && !['installing', 'installed', 'updating'].includes(state);
    const uncertain = unconfirmed.has(id);
    const label = app.name || id.slice(0, 12);
    const address = discoveryAddress(app);
    const copy = copyState?.id === id && copyState.address === address ? copyState : null;

    // the single trailing action (mirrors the prior row's branch ladder)
    let action;
    if (mine && installed) action = m('span.peerd-disc-done', 'in your Library');
    else if (installed && updatable) action = m('button.disc-open', {
      disabled: state === 'updating' || uncertain,
      onclick: () => update(send, app, /** @type {string} */ (localId)),
    }, state === 'updating' ? 'Updating…' : uncertain ? 'Refresh to reconcile' : failed ? 'Retry update' : 'Update');
    else if (installed) action = localId
      ? m('button.disc-open', { onclick: () => open(send, localId, id) }, 'Open ↗')
      : m('span.peerd-disc-done', 'installed ✓');
    else action = m('button.disc-open', {
      disabled: state === 'installing' || uncertain || !app.uri,
      onclick: () => install(send, app),
    }, state === 'installing' ? 'Installing…' : uncertain ? 'Refresh to reconcile' : failed ? 'Retry' : 'Install');

    return m('.disc-card', { key: id }, [
      m('.disc-head', [
        m('.disc-avatar', { style: `background:${colorOf(id)}`, 'aria-hidden': 'true' }, label.trim().charAt(0) || '?'),
        m('div', { style: 'flex:1; min-width:0;' }, [
          m('.disc-name', { title: label }, label),
          m('details.disc-publisher', [
            m('summary.disc-meta', mine ? 'by you' : `from …${short(app.publisher || app.from)}`),
            m('span.disc-meta', app.publisher || app.from || 'Publisher not specified'),
          ]),
        ]),
      ]),
      app.description ? m('p.disc-description', app.description) : null,
      m('p.disc-meta', [
        app.includes_wasm === true ? 'Includes WebAssembly' : app.includes_wasm === false ? 'No detected WebAssembly files' : 'WebAssembly not specified',
        Number.isSafeInteger(app.size) && /** @type {number} */ (app.size) >= 0 ? ` · ${new Intl.NumberFormat().format(/** @type {number} */ (app.size))} bundle bytes` : '',
      ]),
      updatable && !failed ? m('.disc-update-badge', { title: 'A newer version is available' }, '● update available') : null,
      failed ? m('p.peerd-disc-err', { style: 'margin:0;' }, state) : null,
      notices[id] ? m('p.muted', {
        style: 'margin:0;', role: 'status', 'aria-live': 'polite',
      }, notices[id]) : null,
      copy && copy.status !== 'pending' ? m('div', { role: 'status', 'aria-live': 'polite' }, [
        m('p.muted', copy.status === 'copied' ? 'Copied this exact revision. Paste it into Peerd Discover.' : 'Could not copy. Select this address and paste it into Peerd Discover.'),
        m('code', { style: 'overflow-wrap:anywhere;' }, copy.address),
      ]) : null,
      m('.disc-actions', { style: 'flex-wrap:wrap;' }, [action,
        m('button.disc-open.disc-copy-address', {
          disabled: !address || copyState?.status === 'pending',
          title: address ? 'Copy this exact revision for pasting into Peerd Discover.'
            : 'A matching publisher and immutable revision are required.',
          onclick: () => copyAddress(app),
        }, copy?.status === 'pending' ? 'Copying…' : 'Copy immutable address'),
      ]),
    ]);
  };

  return {
    /** @param {{ attrs: { send: Send } }} vnode */
    oninit(vnode) { loadLocal(vnode.attrs.send); refresh(vnode.attrs.send); },
    /** @param {{ attrs: { send: Send } }} vnode */
    oncreate(vnode) {
      timer = setInterval(() => { if (!document.hidden) { loadLocal(vnode.attrs.send); refresh(vnode.attrs.send); } }, 4000);
      // Returning to the tab should re-sync at once, not after the next 4s tick.
      onVisible = () => { if (!document.hidden) { loadLocal(vnode.attrs.send); refresh(vnode.attrs.send); } };
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('focus', onVisible);
    },
    onremove() {
      dead = true;
      if (timer) clearInterval(timer);
      if (onVisible) { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); }
    },
    /** @param {{ attrs: { send: Send } }} vnode */
    view(vnode) {
      const send = vnode.attrs.send;

      // Header mirrors the Library: a live count + a manual ↻ (spins while a
      // re-sync runs). The list also auto-polls every 4s underneath.
      const header = m('div', { style: 'display:flex; align-items:center; gap:8px; margin:0 0 12px;' }, [
        m('p.muted', { style: 'margin:0; font-size:12px;' },
          apps.length ? `${apps.length} shared by peers` : 'Discover'),
        m('.spacer', { style: 'flex:1;' }),
        m('button.icon.disc-refresh', {
          title: 'Refresh',
          class: refreshing ? 'is-spinning' : '',
          disabled: refreshing,
          onclick: () => manualRefresh(send),
        }, '↻'),
      ]);

      if (loading && !apps.length) {
        return m('.peerd-disc', [header, m('.peerd-net-empty', 'Looking for Apps shared by your peers…')]);
      }
      const errorBanner = error
        ? m('p.peerd-disc-err', { role: 'alert', 'aria-live': 'assertive' }, error)
        : null;
      if (!apps.length) {
        return m('.peerd-disc', [header, errorBanner, error ? null : m('.peerd-net-empty',
          'No peer Apps discovered yet. Try an included starter above, inspect an App address, or share an App from your Library. Peer results appear when signed announcements arrive.')]);
      }

      // why: a pending mutation must remain visible until its receipt resolves,
      // even if polling already finds it in the Library. Unknown is not absent.
      const candidates = libraryFilter === 'all' ? apps : apps.filter(app => {
        const id = app.dwapp_id;
        if (id && (unconfirmed.has(id) || notices[id] || ['installing', 'updating'].includes(busy[id]))) return true;
        return !(id && installedByDwappId.has(id))
          && !(app.uri && installedByUri.has(app.uri));
      });
      const balanced = exploreOrder(candidates, { query, wasm, seed });
      const byId = new Map(balanced.map(app => [app.dwapp_id, app]));
      orderedIds = orderedIds.filter(id => byId.has(id));
      const known = new Set(orderedIds);
      for (const app of balanced) if (app.dwapp_id && !known.has(app.dwapp_id)) orderedIds.push(app.dwapp_id);
      const ordered = orderedIds.map(id => /** @type {DwebApp} */ (byId.get(id)));
      if (offset >= ordered.length) offset = 0;
      const shown = ordered.slice(offset, offset + limit);
      return m('.peerd-disc', [
        header,
        errorBanner,
        m('input.disc-search', {
          type: 'search',
          placeholder: 'Filter shared apps… (name, peer)',
          'aria-label': 'Filter shared apps',
          value: query,
          oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { query = e.target.value; limit = EXPLORE_PAGE; offset = 0; orderedIds = []; },
        }),
        m('.disc-controls', [
          m('select', { 'aria-label': 'WebAssembly content', value: wasm,
            onchange: (/** @type {{target: HTMLSelectElement}} */ e) => { wasm = e.target.value; limit = EXPLORE_PAGE; offset = 0; orderedIds = []; },
          }, [m('option', {value:'all'}, 'All Apps'), m('option', {value:'yes'}, 'Includes WebAssembly'),
            m('option', {value:'no'}, 'No detected WebAssembly files'), m('option', {value:'unknown'}, 'Not specified')]),
          m('select', { 'aria-label': 'Library filter', value: libraryFilter, disabled: !localReady,
            onchange: (/** @type {{target: HTMLSelectElement}} */ e) => {
              libraryFilter = e.target.value; limit = EXPLORE_PAGE; offset = 0; orderedIds = [];
            },
          }, [m('option', {value:'all'}, 'All Apps'), m('option', {value:'uninstalled'}, 'Not in my Library')]),
          m('button.secondary', { onclick: () => { seed = crypto.getRandomValues(new Uint32Array(1))[0]; limit = EXPLORE_PAGE; offset = 0; orderedIds = []; } }, 'Shuffle'),
        ]),
        !localReady || localFailed && libraryFilter !== 'all' ? m('p.muted', {role:'status'},
          !localFailed ? 'Checking your Library…' : localReady
            ? 'Could not refresh your Library. Filtering uses the last confirmed Library. Refresh to try again.'
            : 'Could not read your Library. Refresh to enable the Library filter.') : null,
        m('p.muted', 'WebAssembly hints are publisher-signed, not a safety or compatibility guarantee.'),
        m('p.muted', {role:'status', 'aria-live':'polite'}, ordered.length ? `Showing ${offset + 1}–${offset + shown.length} of ${ordered.length} Apps` : 'No matching Apps. Change your search or filters.'),
        !ordered.length ? m('button.secondary', { onclick: () => { query = ''; wasm = 'all'; libraryFilter = 'all'; orderedIds = []; offset = 0; } }, 'Clear filters') : null,
        shown.length ? m('.disc-grid', shown.map((app) => card(send, app))) : null,
        m('.disc-controls', [
          offset ? m('button.secondary', {onclick: () => { offset = Math.max(0, offset - EXPLORE_WINDOW); limit = EXPLORE_WINDOW; }}, 'Previous Apps') : null,
          offset + shown.length < ordered.length ? m('button.secondary', {onclick: () => {
            if (limit < EXPLORE_WINDOW) limit += EXPLORE_PAGE;
            else { offset += EXPLORE_WINDOW; limit = EXPLORE_PAGE; }
          }}, limit < EXPLORE_WINDOW ? 'Show more' : 'Next Apps') : null,
        ]),
      ]);
    },
  };
};
