// @ts-check
// home/discover-section.js - the Discover view (dweb preview only).
//
// Apps peers SHARE on the always-on base network show up here: their record
// (name + publisher + content uri) rides gossip (re-announced so late joiners
// hear it) and is durable in the DHT. Installing fetches the signed bundle
// over the base mesh, verifies it, and adds it to your Library, peer to peer,
// with no server. A pure CLIENT (SW routes only; never imports the dweb
// module), so the store build prunes nothing here but it never mounts
// (DWEB_ENABLED gate).
//
// One component, four pages: the root (start list while the peer network is
// off; looking, empty, tile grid or offline grid while it is on), an app
// page, a share-link page and a maker page. Pure rules live in
// discover-model.js and view pieces in discover-pages.js.

import m from '/vendor/mithril/mithril.js';
import { immutableAppRoot } from '/shared/address/immutable-app-root.js';
import { loadDweb } from '/shared/dweb-loader.js';
import { openOptions } from '/shared/open-options.js';
import { packagedStarter, starterKeys } from '/shared/starter-catalog.js';
import { discoveryAddress } from './discovery-address.js';
import { exploreOrder, EXPLORE_WINDOW, nextSuggestion, suggestionKey } from './explore-order.js';
import {
  bytesLabel, createEffects, kbLabel, letterOf, libraryPeerApps, libraryStatus, matchQuery, networkState, pageState,
  pillFilter, appCountLabel, peerCountLabel, rootView, savedContactNames, shortKey, tileAction, toneOf, wasmLabel,
} from './discover-model.js';
import {
  actionView, appHead, appRow, backLink, cantRunPanel, conflictPanel, emptyState, installPanel, makerHead,
  makerMeta, pills, refreshButton, safetyLines, searchInput, secondaryButton, shareRow, startRow, statusRow,
  techDetails, tile, tileButton,
} from './discover-pages.js';

/** @typedef {import('../options/sections/reset-row.js').Send} Send */
/** @typedef {import('./discover-model.js').DwebApp} DwebApp */
/** @typedef {import('./discover-model.js').DiscoverEffects} DiscoverEffects */
/** @typedef {import('./discover-model.js').NetworkState} NetworkState */
/** @typedef {import('./discover-model.js').Pill} Pill */
/** @typedef {import('./discover-pages.js').Fact} Fact */
/** @typedef {import('./discover-pages.js').ButtonProps} ButtonProps */
/** @typedef {{page:'root'}|{page:'app', key:string}|{page:'link'}|{page:'maker', did:string}} Route */
/** @typedef {ReturnType<typeof immutableAppRoot>} LinkTarget */
/** @typedef {LinkTarget & {name:string|null, decodedBytes?:number, containsWasm?:boolean, runtimeCompatibility?:{status:string,message:string}}} LinkSummary */
/** @typedef {{id:string, name?:string, dweb?:{uri?:string, dwapp_id?:string, version_id?:string|null, seq?:number, seed?:string, hash?:string, publisher?:string}}} LibraryRecord */
/**
 * @typedef {{
 *   send: Send,
 *   enabled: boolean,
 *   reconcileState?: () => Promise<unknown>,
 *   openKey?: string|null,
 *   onOpenKey?: () => void,
 *   onLibrary?: () => void,
 *   initialSeed?: number,
 *   effects?: DiscoverEffects,
 * }} Attrs
 */

const PENDING_KEY = 'peerd.manual-app-install.pending';
const RUNTIME_CODES = Object.freeze(['app-runtime-invalid', 'app-runtime-unsupported', 'app-runtime-mismatch']);
const POLL_MS = 4000;
const COPIED_MS = 2000;
const TECH_ID = 'disc-tech-facts';
const COMMONS_NAME = 'Peerd-to-Peerd Commons';
const CHOICE_ERROR = 'Your network choice could not be confirmed. Refresh status before choosing again.';
const RECEIPT_HELD = 'peerd could not confirm whether the install finished. It may still finish, so another install stays blocked.';
// why: a heard card carries the maker's own WebAssembly claim. A share link
// shows what peerd found in the files instead.
const WASM_HINT = 'The WebAssembly hint comes from the maker. peerd does not check it.';
// The start row names one packaged starter; the others follow it.
const FEATURED_STARTER = 'csv-lab';
const FEATURED = packagedStarter(FEATURED_STARTER);

// why module scope: the app page says "You can leave this page. The install
// keeps going." A rail switch unmounts this view, and dweb/base/install has no
// dedupe, so the busy/unknown fences must outlive the component or a second
// click can mint a duplicate install. A reload still drops them; the share
// link keeps its sessionStorage receipt for that.
const sharedEffects = createEffects();

/** The Discover view, mounted on the home page (DWEB_ENABLED only).
 * @param {{attrs: Attrs}} initialVnode */
export const DiscoverSection = (initialVnode) => {
  let attrs = initialVnode.attrs;
  const { busy, notices, unconfirmed, installedId, conflicts } = attrs.effects ?? sharedEffects;
  let dead = false;
  /** @type {Element|null} */ let rootDom = null;
  let viewEnabled = attrs.enabled;

  /** @type {DwebApp[]} */ let apps = [];
  /** @type {Map<string, DwebApp>} */ const heardCache = new Map();
  let loading = true;
  let heardFailed = false;
  let localReady = false;
  let localFailed = false;
  /** @type {LibraryRecord[]} */ let records = [];
  /** @type {Map<string, string>} */ let installedByUri = new Map();
  /** @type {Map<string, {appId:string, version_id:string|null, seq:number}>} */ let installedByDwappId = new Map();
  /** @type {string|null} */ let commonsId = null;
  /** @type {Map<string, string>} */ let contactNames = new Map();
  /** @type {string|null} */ let myDid = null;
  /** @type {NetworkState|null} */ let net = null;
  let retrying = false;

  let choiceBusy = false;
  let choiceRefreshing = false;
  let choiceAttempt = 0;
  /** @type {string|null} */ let choiceError = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let choiceTimer = null;

  /** @type {Route} */ let route = { page: 'root' };
  /** @type {DwebApp|null} */ let pageApp = null;
  /** @type {{key:string, scroll:number}|null} */ let origin = null;
  /** @type {{key:string, epoch:number, route:Route, answered:boolean}|null} */ let keyAsk = null;
  /** @type {{selector:string|null, scroll:number|null, fallback?:string, ifLost?:boolean}|null} */ let pendingFocus = null;
  /** @type {Pill} */ let pill = 'all';
  let query = '';
  let seed = attrs.initialSeed ?? crypto.getRandomValues(new Uint32Array(1))[0];
  let limit = EXPLORE_WINDOW;
  /** @type {string[]} */ let orderedIds = [];
  /** @type {Set<string>} */ const suggested = new Set();
  /** @type {string|null} */ let lastPublisher = null;
  let refreshing = false;  // drives the manual Refresh spin (the 4s poll stays silent)
  let techOpen = false;
  /** @type {{field:string, value:string, status:'pending'|'copied'|'failed'}|null} */ let copyState = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let copyTimer = null;
  /** @type {{key:string, text:string}|null} */ let alertLine = null;

  let shareOpen = false;
  let linkInput = '';
  let linkEpoch = 0;
  /** @type {''|'inspect'|'install'|'reconcile'|'open'|'receipt'} */ let linkBusy = '';
  let linkError = '';
  let linkFailure = '';
  let linkNotice = '';
  /** @type {LinkSummary|null} */ let linkPreview = null;
  /** @type {LinkTarget|null} */ let linkPending = null;
  /** @type {string|null} */ let linkAppId = null;

  let commonsBusy = false;
  let commonsUnknown = false;

  /** @type {ReturnType<typeof setInterval>|null} */ let timer = null;
  /** @type {(() => void)|null} */ let onVisible = null;
  /** @type {Promise<boolean>|null} */ let localInFlight = null;
  /** @type {Promise<boolean>|null} */ let refreshInFlight = null;
  let refreshEpoch = 0;
  let appliedRefreshEpoch = 0;
  let statusInFlight = false;
  let contactsInFlight = false;

  const redraw = () => { if (!dead) m.redraw(); };
  const scrollHost = () => rootDom?.closest('.home-content') ?? document.scrollingElement;

  // Cross-reference the Library so Discover doesn't offer to "install" what's
  // already here AND can tell an installed app apart from a newer announce of
  // it. Best-effort: a failure keeps the last confirmed Library.
  const loadLocal = () => {
    if (localInFlight) return localInFlight;
    localInFlight = (async () => {
      try {
        const list = await attrs.send({ type: 'apps/list' });
        if (!list?.ok || !Array.isArray(list.apps)) throw new Error('app-catalog-unavailable');
        /** @type {LibraryRecord[]} */ const rows = list.apps;
        /** @type {Map<string, string>} */ const byUri = new Map();
        /** @type {Map<string, {appId:string, version_id:string|null, seq:number}>} */ const byId = new Map();
        for (const a of rows) {
          if (a?.dweb?.uri) byUri.set(a.dweb.uri, a.id);
          if (a?.dweb?.dwapp_id) byId.set(a.dweb.dwapp_id, { appId: a.id, version_id: a.dweb.version_id ?? null, seq: a.dweb.seq ?? 0 });
        }
        records = rows;
        installedByUri = byUri;
        installedByDwappId = byId;
        commonsId = rows.find(a => a?.dweb?.seed === 'commons')?.id ?? null;
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
        pruneConflicts();
        return true;
      } catch { localFailed = true; return false; /* retain the last confirmed Library */ }
      finally { localInFlight = null; redraw(); }
    })();
    return localInFlight;
  };

  /** @param {string} id @param {'install'|'update'} action @param {DwebApp} app */
  const markUnknown = (id, action, app) => {
    conflicts.delete(id);
    unconfirmed.set(id, {
      action,
      versionId: typeof app.version_id === 'string' ? app.version_id : null,
      seq: Number.isSafeInteger(app.seq) && /** @type {number} */ (app.seq) >= 0
        ? /** @type {number} */ (app.seq) : null,
      uri: typeof app.uri === 'string' ? app.uri : null,
    });
    busy[id] = `peerd could not confirm whether the ${action} finished. Refresh to check before trying again.`;
  };

  /** @param {string} id @param {'install'|'update'} action @param {DwebApp} app @param {unknown} result */
  const markFailure = (id, action, app, result) => {
    if (/** @type {{outcomeKnown?:boolean}} */ (result)?.outcomeKnown === false) {
      markUnknown(id, action, app);
      return;
    }
    unconfirmed.delete(id);
    conflicts.delete(id);
    const failure = /** @type {{code?:string,error?:string}} */ (result);
    busy[id] = RUNTIME_CODES.includes(failure?.code ?? '') && typeof failure?.error === 'string' ? failure.error
      : `peerd could not ${action} this app. Try again.`;
  };

  const refresh = () => {
    if (refreshInFlight) return refreshInFlight;
    const epoch = ++refreshEpoch;
    refreshInFlight = (async () => {
      try {
        const r = await attrs.send({ type: 'dweb/base/heard' });
        if (r?.ok === false || !Array.isArray(r?.apps)) throw new Error('discover-unavailable');
        if (epoch >= appliedRefreshEpoch) {
          appliedRefreshEpoch = epoch;
          /** @type {Map<string, DwebApp>} */ const seen = new Map();
          for (const a of /** @type {DwebApp[]} */ (r.apps)) if (a?.dwapp_id) seen.set(a.dwapp_id, a);
          const next = [...seen.values()];
          // A refresh is not an effect receipt. Retain the exact pending card,
          // including its version, until the mutation can be reconciled.
          const retained = new Map(apps.filter(app => app.dwapp_id
            && (unconfirmed.has(app.dwapp_id) || ['installing', 'updating'].includes(busy[app.dwapp_id])))
            .map(app => [app.dwapp_id, app]));
          apps = [...next.map(app => retained.get(app.dwapp_id) ?? app),
            ...[...retained.values()].filter(app => !seen.has(/** @type {string} */ (app.dwapp_id)))];
          for (const app of next) heardCache.set(/** @type {string} */ (app.dwapp_id), app);
          heardFailed = false;
          pruneConflicts();
        }
        return true;
      } catch {
        if (epoch >= appliedRefreshEpoch) heardFailed = true;
        return false;
      } finally {
        loading = false;
        refreshInFlight = null;
        redraw();
      }
    })();
    return refreshInFlight;
  };

  // Read only: checking connection status never grants participation. The
  // lease decides first, so a stopped host is never started by this read.
  const readStatus = async () => {
    if (statusInFlight) return;
    statusInFlight = true;
    try {
      const ready = await attrs.send({ type: 'bootstrap/ready' });
      const lease = ready?.ok ? ready.featureLeases?.leases?.dweb?.status : null;
      const info = lease === 'active' ? await attrs.send({ type: 'dweb/distributed/info' }) : null;
      net = networkState(ready, info) ?? net;
      if (typeof info?.did === 'string') myDid = info.did;
    } catch { /* keep the last known state */ }
    finally { statusInFlight = false; redraw(); }
  };

  const loadContacts = async () => {
    if (contactsInFlight) return;
    contactsInFlight = true;
    try {
      const reply = await attrs.send({ type: 'contacts/list' });
      if (reply?.ok) contactNames = savedContactNames(reply.contacts);
    } catch { /* "Made by" falls back to the short key */ }
    finally { contactsInFlight = false; redraw(); }
  };

  const poll = () => { void loadLocal(); void refresh(); void readStatus(); };
  // why only while enabled: with the peer network off Discover sends nothing.
  // Some dweb reads start the host, and the user has not chosen to join.
  const startPolling = () => {
    if (timer) return;
    poll();
    void loadContacts();
    timer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
    // Returning to the tab should re-sync at once, not after the next 4s tick.
    onVisible = () => { if (!document.hidden) poll(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
  };
  const stopPolling = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (onVisible) {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      onVisible = null;
    }
  };

  // The shipped network choice, enable only: "Not now" and "Turn off" live
  // in Settings and the Network view.
  const enableNetwork = () => {
    if (choiceBusy || choiceRefreshing || choiceError || dead) return;
    const token = ++choiceAttempt;
    choiceBusy = true;
    let finished = false;
    const current = () => !dead && token === choiceAttempt;
    /** @param {string|null} error */
    const settle = (error) => {
      if (!current() || finished) return;
      finished = true;
      choiceBusy = false;
      choiceError = error;
      if (choiceTimer) clearTimeout(choiceTimer);
      void attrs.reconcileState?.()?.catch(() => {});
      redraw();
    };
    // Startup can outlive the settings RPC. Confirm only the persisted
    // authority view, then let the user continue while transport connects.
    const confirm = async () => {
      try {
        const reply = await attrs.send({ type: 'state/get' });
        if (reply?.ok && reply.state?.settings?.dwebChoiceMade === true
            && reply.state.settings.dwebEnabled === true) settle(null);
      } catch { /* the mutation reply can still confirm persistence */ }
      if (current() && !finished) choiceTimer = setTimeout(confirm, 750);
    };
    attrs.send({ type: 'settings/update', patch: { dwebEnabled: true } })
      .then(reply => settle(reply?.ok ? null : CHOICE_ERROR), () => settle(CHOICE_ERROR));
    choiceTimer = setTimeout(confirm, 250);
    redraw();
  };

  const refreshChoice = async () => {
    if (choiceRefreshing) return;
    choiceRefreshing = true;
    const token = ++choiceAttempt;
    redraw();
    try {
      const reply = await attrs.send({ type: 'state/get' });
      if (dead || token !== choiceAttempt || !reply?.ok || !reply.state?.settings) return;
      choiceError = null;
      void attrs.reconcileState?.()?.catch(() => {});
    } catch { /* keep the unconfirmed outcome visible */ }
    finally {
      if (!dead && token === choiceAttempt) { choiceRefreshing = false; redraw(); }
    }
  };

  const retryConnection = async () => {
    if (retrying) return;
    retrying = true;
    redraw();
    try { await attrs.send({ type: 'dweb/base/start' }); }
    catch { /* show the read-back result rather than replaying a mutation */ }
    finally { retrying = false; await readStatus(); }
  };

  /** @param {string} appId */
  const announceInstalled = (appId) => {
    // Tell the Library (sibling section) to re-fetch. No shared store between
    // sections, so a page-level CustomEvent is the decoupled bus.
    try { window.dispatchEvent(new CustomEvent('peerd:app-installed', { detail: { appId } })); } catch { /* no-op */ }
  };

  /** @param {DwebApp} app */
  const install = async (app) => {
    // why the guard: install is only ever wired to cards that carry a
    // dwapp_id (it keys every record + the busy/installed maps), and an
    // in-flight or unknown install must never be sent twice. Until one
    // Library read lands, an installed app looks new, so wait for it.
    const id = app.dwapp_id;
    if (!id || !localReady || app.runtimeCompatibility?.status === 'unsupported' || unconfirmed.has(id)
        || ['installing', 'updating'].includes(busy[id])) return;
    busy[id] = 'installing';
    delete notices[id];
    alertLine = null;
    redraw();
    try {
      // Pass the card's version identity so the installed record can later be
      // matched against newer announces ("Update ready").
      const r = await attrs.send({ type: 'dweb/base/install', uri: app.uri, name: app.name, dwappId: id, slug: app.slug, seq: app.seq, publisher: app.publisher });
      if (r?.ok) {
        busy[id] = 'installed';
        if (r.warning === 'audit-write-failed') notices[id] = 'Installed, but the security audit entry could not be written.';
        installedId[id] = r.app?.id ?? r.appId ?? null;
        announceInstalled(/** @type {string} */ (installedId[id]));
        if (route.page === 'app' && route.key === id) pendingFocus = { selector: '.disc-panel .disc-primary', scroll: null, ifLost: true };
        void loadLocal();
      } else {
        markFailure(id, 'install', app, r);
      }
    } catch { markUnknown(id, 'install', app); }
    // why no dead guard: the custody maps outlive this mount, so a remounted
    // view must see the settled state now, not on the next poll.
    m.redraw();
  };

  // Update an installed app in place to this newer announced version. With
  // local edits the host answers 'local-changes' and a token; the resend
  // carries the user's explicit strategy, as the Library does.
  /** @param {DwebApp} app @param {string} appId @param {'fork'|'replace'} [strategy] */
  const update = async (app, appId, strategy) => {
    const id = app.dwapp_id;
    if (!id || app.runtimeCompatibility?.status === 'unsupported' || unconfirmed.has(id)
        || ['installing', 'updating'].includes(busy[id])) return;
    const conflictToken = strategy ? liveConflict(app) : undefined;
    if (strategy && conflictToken === undefined) return;
    busy[id] = 'updating';
    delete notices[id];
    alertLine = null;
    redraw();
    try {
      const r = await attrs.send({
        type: 'dweb/base/update-app', appId, uri: app.uri, name: app.name, dwappId: id, slug: app.slug, seq: app.seq,
        publisher: app.publisher, ...(strategy ? { strategy, conflictToken } : {}),
      });
      if (r?.ok) {
        busy[id] = 'installed';
        conflicts.delete(id);
        const warnings = new Set(Array.isArray(r.warnings) ? r.warnings : []);
        if (r.warning) warnings.add(r.warning);
        const warningMessages = [];
        if (r.fork?.name) warningMessages.push(`Kept your local work as “${r.fork.name}” and updated this app.`);
        if (warnings.has('audit-write-failed')) {
          warningMessages.push('Updated, but the security audit entry could not be written.');
        } else if (warnings.has('previous-version-cleanup-pending') && !r.fork?.name) {
          warningMessages.push('Updated.');
        }
        if (warnings.has('previous-version-cleanup-pending')) {
          warningMessages.push('Older shared bytes will be cleaned up on the next update or delete.');
        }
        if (warningMessages.length) notices[id] = warningMessages.join(' ');
        announceInstalled(appId);
        void loadLocal();
      } else if (r?.error === 'local-changes' && Number.isSafeInteger(r.conflictToken)) {
        conflicts.set(id, { token: r.conflictToken, versionId: app.version_id ?? null });
        delete busy[id];
      } else {
        markFailure(id, 'update', app, r);
      }
    } catch { markUnknown(id, 'update', app); }
    m.redraw();
  };

  /** @param {string|null} appId @param {string} key */
  const openApp = async (appId, key) => {
    if (!appId) return;
    alertLine = null;
    try {
      const result = await attrs.send({ type: 'apps/open', appId });
      if (!result?.ok) alertLine = { key, text: 'peerd could not open this app. Try again.' };
    } catch { alertLine = { key, text: 'peerd could not confirm whether the app opened. Check your tabs.' }; }
    redraw();
  };

  // The manual Refresh: spin while a one-shot re-sync runs. The background
  // 4s poll stays silent (it would flicker the spinner every tick).
  const manualRefresh = async () => {
    if (refreshing) return;
    refreshing = true;
    redraw();
    await Promise.allSettled([loadLocal(), refresh(), readStatus(), loadContacts()]);
    refreshing = false;
    redraw();
  };

  /** @param {string} field @param {string} value */
  const copy = async (field, value) => {
    if (dead || copyState?.status === 'pending') return;
    const attempt = { field, value, status: /** @type {'pending'|'copied'|'failed'} */ ('pending') };
    copyState = attempt;
    if (copyTimer) clearTimeout(copyTimer);
    redraw();
    try {
      await navigator.clipboard.writeText(value);
      if (!dead && copyState === attempt) attempt.status = 'copied';
    } catch {
      if (!dead && copyState === attempt) attempt.status = 'failed';
    } finally {
      if (!dead && copyState === attempt && attempt.status === 'copied') {
        copyTimer = setTimeout(() => { if (copyState === attempt) { copyState = null; redraw(); } }, COPIED_MS);
      }
      redraw();
    }
  };
  // why match the value too: a write that started before the facts changed
  // copied the old value, so it must never label the new one as copied.
  /** @param {string} field @param {string} value @returns {ButtonProps} */
  const copyButton = (field, value) => ({
    label: copyState?.field === field && copyState.value === value && copyState.status === 'copied' ? 'Copied' : 'Copy',
    disabled: copyState?.status === 'pending',
    onclick: () => { void copy(field, value); },
  });
  const copyNote = () => copyState?.status === 'failed' ? 'Could not copy.' : null;

  const forgetPending = () => { sessionStorage.removeItem(PENDING_KEY); linkPending = null; };

  // why: a share link must pin its signer and entire app revision, and the
  // summary must echo exactly what was parsed before anything is shown.
  const inspectLink = async () => {
    if (!attrs.enabled || linkBusy) return;
    if (linkPending) { openPage({ page: 'link' }, 'paste'); return; }
    linkError = ''; linkPreview = null; linkAppId = null; linkFailure = ''; linkNotice = '';
    let target;
    try { target = immutableAppRoot(linkInput); }
    catch (cause) { linkError = /** @type {Error} */ (cause).message; return; }
    const requestEpoch = ++linkEpoch;
    linkBusy = 'inspect';
    redraw();
    try {
      const reply = await attrs.send({ type: 'dweb/base/inspect-address', address: target.address });
      if (dead || !attrs.enabled || requestEpoch !== linkEpoch) return;
      if (reply?.ok && reply.summary?.address === target.address
          && reply.summary?.uri === target.uri && reply.summary?.publisher === target.publisher
          && reply.summary?.hash === target.hash) {
        const catalog = await attrs.send({ type: 'apps/list' });
        if (dead || !attrs.enabled || requestEpoch !== linkEpoch) return;
        if (!catalog?.ok || !Array.isArray(catalog.apps)) throw new Error('catalog-unavailable');
        linkPreview = reply.summary;
        linkAppId = /** @type {LibraryRecord[]} */ (catalog.apps).find(app => app.dweb?.uri === target.uri
          && app.dweb?.hash === target.hash && app.dweb?.publisher === target.publisher)?.id ?? null;
        openPage({ page: 'link' }, 'paste');
      } else {
        linkError = RUNTIME_CODES.includes(reply?.code) ? reply.error
          : 'Could not verify this app. Check the link and your peer network connection, then try again.';
      }
    } catch {
      if (requestEpoch === linkEpoch) linkError = 'Could not check this app. Try again when the peer network is available.';
    } finally { linkBusy = ''; redraw(); }
  };

  // why: an uncertain install may commit after the renderer deadline or a
  // reload. Absence from a catalog read is not a receipt for another install.
  const installLink = async () => {
    if (!attrs.enabled || linkBusy || linkPending || !linkPreview) return;
    const target = immutableAppRoot(linkInput);
    if (target.address !== linkPreview.address) return;
    linkPending = target;
    // Persist BEFORE sending so reload keeps its UI receipt; the host owns cross-tab deduplication.
    try { sessionStorage.setItem(PENDING_KEY, target.address); }
    catch { linkPending = null; linkFailure = 'Could not retain the install receipt. Try again after reloading.'; return; }
    linkBusy = 'install'; linkFailure = ''; linkNotice = '';
    redraw();
    try {
      const reply = await attrs.send({ type: 'dweb/base/install-address', address: target.address });
      if (reply?.ok && typeof reply.app?.id === 'string') {
        linkAppId = reply.app.id;
        forgetPending();
        linkNotice = reply.warning === 'audit-write-failed' ? 'Installed, but the security audit entry could not be written.' : '';
        announceInstalled(reply.app.id);
        if (route.page === 'link') pendingFocus = { selector: '.disc-panel .disc-primary', scroll: null, ifLost: true };
      } else if (reply?.ok === false && reply?.outcomeKnown !== false && reply?.performed !== true
          && !['effect-completed', 'host-lost', 'transport-lost'].includes(reply?.outcomeKind)) {
        forgetPending();
        linkFailure = RUNTIME_CODES.includes(reply?.code) ? reply.error : 'peerd could not install this app. Try again.';
      }
    } catch { /* no receipt: keep the exact pending address fenced */ }
    finally { linkBusy = ''; redraw(); }
  };

  const reconcileLink = async () => {
    if (!linkPending || linkBusy) return;
    const pending = linkPending;
    linkBusy = 'reconcile'; linkNotice = '';
    redraw();
    try {
      const result = await attrs.send({ type: 'apps/list' });
      const match = result?.ok && Array.isArray(result.apps) && /** @type {LibraryRecord[]} */ (result.apps).find(app =>
        app.dweb?.uri === pending.uri && app.dweb?.hash === pending.hash
        && app.dweb?.publisher === pending.publisher);
      // why keep the target: after a reload the receipt is all the page
      // knows about this app, and the page must stay to offer Open.
      if (match && typeof match.id === 'string') { linkPreview ??= { ...pending, name: null }; linkAppId = match.id; forgetPending(); }
      else linkNotice = 'No completed install receipt yet. The original request may still finish; another install remains blocked.';
    } catch { linkNotice = 'Could not read the Library. Refresh to check again.'; }
    finally { linkBusy = ''; redraw(); }
  };

  const openLinkApp = async () => {
    if (!linkAppId || linkBusy) return;
    linkBusy = 'open'; alertLine = null;
    redraw();
    try {
      if (!(await attrs.send({ type: 'apps/open', appId: linkAppId }))?.ok) alertLine = { key: 'link', text: 'Could not open the installed app.' };
    } catch { alertLine = { key: 'link', text: 'Could not confirm whether the app opened. Check your tabs.' }; }
    finally { linkBusy = ''; redraw(); }
  };

  const addCommons = async () => {
    if (commonsBusy || commonsUnknown || !localReady || commonsId) return;
    commonsBusy = true; alertLine = null;
    redraw();
    try {
      const client = await loadDweb();
      if (!client.loadSeedApp) throw new Error('Commons is unavailable in this build.');
      const commonsSeed = await client.loadSeedApp({ fetchText: async (/** @type {string} */ path) => {
        // The seed loader selects only our own packaged extension asset.
        // eslint-disable-next-line no-restricted-globals
        const response = await fetch(path);
        if (!response.ok) throw new Error('Could not load packaged Commons.');
        return response.text();
      } });
      commonsUnknown = true;
      const reply = await attrs.send({ type: 'dweb/open-commons', seed: commonsSeed });
      if (reply?.ok) { commonsUnknown = false; await loadLocal(); }
      else alertLine = { key: 'commons', text: 'Could not confirm whether Commons was added or opened. Check your Library and tabs before trying again.' };
    } catch (cause) {
      alertLine = { key: 'commons', text: commonsUnknown
        ? 'Could not confirm whether Commons was added or opened. Check your Library and tabs before trying again.'
        : /** @type {Error} */ (cause).message };
    } finally { commonsBusy = false; redraw(); }
  };

  const openCommons = async () => {
    if (!commonsId || commonsBusy) return;
    commonsBusy = true; alertLine = null;
    try { if (!(await attrs.send({ type: 'apps/open', appId: commonsId }))?.ok) alertLine = { key: 'commons', text: 'Could not open Commons.' }; }
    catch { alertLine = { key: 'commons', text: 'Could not confirm whether Commons opened. Check your tabs.' }; }
    finally { commonsBusy = false; redraw(); }
  };

  // why in-component routes: no shell, hash or history change. Leaving the
  // root keeps its scroll and the tile that opened the page, so Back can
  // return both.
  /** @param {Route} next @param {string} originKey */
  const openPage = (next, originKey) => {
    if (route.page === 'root') origin = { key: originKey, scroll: scrollHost()?.scrollTop ?? 0 };
    route = next;
    techOpen = false;
    copyState = null;
    alertLine = null;
    pendingFocus = { selector: '.disc-back', scroll: 0 };
  };
  /** @param {DwebApp} app */
  const openAppPage = (app) => {
    if (!app.dwapp_id) return;
    pageApp = app;
    openPage({ page: 'app', key: app.dwapp_id }, app.dwapp_id);
  };
  /** @param {string} did */
  const openMaker = (did) => { openPage({ page: 'maker', did }, did); void loadContacts(); };
  const goBack = () => {
    if (route.page === 'link' && !linkPending) shareOpen = false;
    const key = origin?.key ?? null;
    route = { page: 'root' };
    techOpen = false;
    copyState = null;
    alertLine = null;
    pendingFocus = {
      selector: key === 'paste' ? (shareOpen ? '.disc-start-form button' : '[data-paste-link]')
        : key ? `[data-key="${CSS.escape(key)}"] .disc-tile-open` : null,
      scroll: origin?.scroll ?? 0,
    };
    origin = null;
  };
  const openShare = () => { shareOpen = true; pendingFocus = { selector: '.disc-start-form input', scroll: null }; };
  // A "New app to install" notification names its dwapp_id, and the bell can
  // be clicked before the next poll hears that card. So only a heard read
  // that starts after the request answers it, once: it opens that page from
  // any page, unless the user moved on meanwhile, then clears the request.
  /** @param {string|null|undefined} key */
  const answerKey = (key) => {
    if (!attrs.enabled || !key) { keyAsk = null; return; }
    if (keyAsk?.key !== key) {
      const ask = { key, epoch: refreshEpoch, route, answered: false };
      keyAsk = ask;
      // why after the read in flight: it started before the request.
      void (refreshInFlight ?? Promise.resolve()).then(() => { if (!dead && attrs.enabled && keyAsk === ask) void refresh(); });
      return;
    }
    if (keyAsk.answered || appliedRefreshEpoch <= keyAsk.epoch) return;
    keyAsk.answered = true;
    const target = route === keyAsk.route ? apps.find(app => app.dwapp_id === key) : null;
    if (target) openAppPage(target);
    attrs.onOpenKey?.();
  };
  /** @param {boolean} included */
  const rootOf = (included) => rootView({
    enabled: attrs.enabled, net, heardCount: apps.length, loading, failed: heardFailed, included,
  });
  // why the pill focus: Included can swap the looking or empty root for the
  // grid and back. Focus follows to the pressed pill, or, on a root with no
  // pills, to the button that shows the included apps again.
  const pillFocus = '.disc-pill[aria-pressed="true"], [data-included]';
  /** @param {Pill} next */
  const selectPill = (next) => {
    if (rootOf(pill === 'included') !== rootOf(next === 'included')) pendingFocus = { selector: pillFocus, scroll: null };
    pill = next; limit = EXPLORE_WINDOW; orderedIds = [];
  };
  /** @param {string} value */
  const setQuery = (value) => { query = value; limit = EXPLORE_WINDOW; orderedIds = []; };
  const clearFilters = () => {
    query = ''; pill = 'all'; limit = EXPLORE_WINDOW; orderedIds = [];
    pendingFocus = { selector: '.disc-search', fallback: pillFocus, scroll: null };
  };

  /** @param {DwebApp} app */
  const facts = (app) => {
    const id = app.dwapp_id ?? '';
    const tracked = installedByDwappId.get(id);
    const localId = installedId[id] || (app.uri ? installedByUri.get(app.uri) : null) || tracked?.appId || null;
    return {
      id, localId,
      updatable: !!tracked && !!app.version_id
        && app.version_id !== tracked.version_id && (app.seq ?? 0) > (tracked.seq ?? 0),
      uncertain: unconfirmed.has(id),
      incompatible: app.runtimeCompatibility?.status === 'unsupported',
      mine: !!myDid && (app.publisher === myDid || app.from === myDid),
      state: busy[id],
    };
  };
  // why bound to the version: the token answers one update offer, as in the
  // Library. Once the Library holds that version, or peers announce another
  // one, the offer is gone and so is its token.
  /** @param {DwebApp} app @returns {number|undefined} */
  const liveConflict = (app) => {
    const entry = conflicts.get(app.dwapp_id ?? '');
    return entry && entry.versionId === (app.version_id ?? null) && facts(app).updatable ? entry.token : undefined;
  };
  const pruneConflicts = () => {
    for (const id of conflicts.keys()) {
      const app = apps.find(a => a.dwapp_id === id);
      if (!app || liveConflict(app) === undefined) conflicts.delete(id);
    }
  };
  // why: a pending mutation must remain visible until its receipt resolves,
  // even if polling already finds it in the Library. Unknown is not absent.
  /** @param {DwebApp} app */
  const pending = (app) => {
    const id = app.dwapp_id;
    return !!id && (unconfirmed.has(id) || !!notices[id] || liveConflict(app) !== undefined
      || ['installing', 'updating'].includes(busy[id]));
  };
  /** @param {string|undefined} did */
  const makerOf = (did) => typeof did === 'string' ? { name: contactNames.get(did) ?? null, key: shortKey(did) } : null;
  /** @param {DwebApp} app */
  const nameOf = (app) => app.name || (app.dwapp_id ?? '').slice(0, 12);

  /** @param {DwebApp} app @param {boolean} offline */
  const appTileProps = (app, offline) => {
    const f = facts(app);
    const action = offline ? /** @type {const} */ ({ kind: 'open' }) : tileAction({
      incompatible: f.incompatible, busy: f.state, uncertain: f.uncertain,
      installed: !!f.localId, updatable: f.updatable, mine: f.mine,
    });
    const name = nameOf(app);
    return {
      key: f.id, name, letter: letterOf(name), tone: toneOf(f.id),
      meta: makerMeta(makerOf(app.publisher), kbLabel(app.size)), description: app.description,
      updateReady: action.kind === 'update',
      action: actionView(action, {
        onOpen: () => { void openApp(f.localId, f.id); },
        onReview: () => openAppPage(app),
        onUpdate: () => { openAppPage(app); if (f.localId) void update(app, f.localId); },
      }),
      onOpen: () => openAppPage(app),
    };
  };

  const offlineApps = () => libraryPeerApps(records, heardCache);

  /** @param {DwebApp[]} list @param {boolean} offline */
  const ordered = (list, offline) => {
    const candidates = pillFilter(list, pill, {
      updatable: app => { const f = facts(app); return !offline && !!f.localId && f.updatable && !f.mine; },
      pending, contacts: contactNames,
    });
    const balanced = exploreOrder(candidates, { query, seed });
    const byId = new Map(balanced.map(app => [app.dwapp_id, app]));
    orderedIds = orderedIds.filter(id => byId.has(id));
    const known = new Set(orderedIds);
    for (const app of balanced) if (app.dwapp_id && !known.has(app.dwapp_id)) orderedIds.push(app.dwapp_id);
    return orderedIds.map(id => /** @type {DwebApp} */ (byId.get(id)));
  };

  // Surprise me only picks from what is already on screen. It never fetches
  // or installs: it opens the chosen app's page.
  /** @param {DwebApp[]} list */
  const surpriseCandidates = (list) => list.filter(app => {
    const id = app.dwapp_id;
    return !!id && !installedId[id] && !installedByDwappId.has(id)
      && !(app.uri && installedByUri.has(app.uri)) && !busy[id] && !unconfirmed.has(id);
  });
  /** @param {DwebApp[]} candidates */
  const surprise = (candidates) => {
    if (!localReady || localFailed) return;
    let chosen = nextSuggestion(candidates, suggested, lastPublisher);
    // why clear and pick again: the history only prevents repeats within one
    // pass; once every candidate was shown, the next pass starts fresh.
    if (!chosen && suggested.size) {
      suggested.clear();
      lastPublisher = null;
      chosen = nextSuggestion(candidates, suggested, lastPublisher);
    }
    if (!chosen) return;
    suggested.add(suggestionKey(chosen));
    lastPublisher = chosen.publisher ?? null;
    openAppPage(chosen);
  };

  const reviewStarter = () => FEATURED
    ? secondaryButton({ label: 'Review starter', onclick: () => openOptions(`transfer?starter=${FEATURED_STARTER}`) }) : null;
  // why: with the peer network off there is no Included pill, so the start
  // row names the other packaged starters too.
  const alsoIncluded = () => {
    const links = starterKeys.filter(key => key !== FEATURED_STARTER).flatMap(key => {
      const starter = packagedStarter(key);
      return starter ? [m('button.linklike', {
        type: 'button', 'aria-label': `Review ${starter.name}`, onclick: () => openOptions(`transfer?starter=${key}`),
      }, starter.name)] : [];
    });
    return links.length ? [' Also included: ', ...links.flatMap((link, i) => i ? [', ', link] : [link]), '.'] : null;
  };
  const libraryButton = () => secondaryButton({ label: 'Go to Library', onclick: () => attrs.onLibrary?.() });
  /** @param {boolean} inStatus */
  const pasteButton = (inStatus) => inStatus
    ? m('button.secondary', { type: 'button', 'data-paste-link': '', onclick: openShare }, 'Paste link')
    : secondaryButton({ label: 'Paste link', onclick: openShare, attrs: { 'data-paste-link': '' } });
  const openShareRow = () => shareRow({
    value: linkInput,
    inputDisabled: !!linkPending || linkBusy === 'receipt',
    checkDisabled: !attrs.enabled || !!linkBusy || (!linkPending && !linkInput),
    status: linkPending ? RECEIPT_HELD : null,
    note: attrs.enabled ? null : 'Join the peer network first.',
    error: linkError,
    oninput: (value) => {
      linkInput = value; linkEpoch++; linkPreview = null; linkAppId = null;
      linkError = ''; linkFailure = ''; linkNotice = '';
    },
    onCheck: () => { void inspectLink(); },
  });
  const heardError = () => heardFailed
    ? m('p.error', { role: 'alert', 'aria-live': 'assertive' }, 'peerd could not refresh peer apps. Retry when the network is available.')
    : null;
  const rootAlert = () => alertLine ? m('p.error', { role: 'alert' }, alertLine.text) : null;
  const libraryLine = () => {
    const note = libraryStatus({ ready: localReady, failed: localFailed });
    return note ? m('p.type-small.disc-footnote', { role: 'status' }, note) : null;
  };
  // why: the looking and empty roots draw no pills, but Included lists the
  // starters and Commons, which need no peer, so they stay one click away.
  const includedButton = () => secondaryButton({
    label: 'Show included apps', onclick: () => selectPill('included'), attrs: { 'data-included': '' },
  });

  const startView = () => m('.disc-home.disc-view.disc-start-view', { key: 'start' }, [
    m('header.disc-intro', [
      m('h1.type-hero', 'Discover'),
      m('p.type-body', 'Small apps people share with each other. Pick a way to start.'),
    ]),
    m('ul.disc-start-list', [
      FEATURED ? startRow({
        icon: 'cube', title: 'Try an included app',
        text: [`${FEATURED.name} comes with peerd and works on this device.`, alsoIncluded()], action: reviewStarter(),
      }) : null,
      startRow({
        icon: 'globe', title: 'Join the peer network',
        text: 'See apps your peers share. Uses some bandwidth and storage, and peers can see your network address. Your private apps, files, chats and keys stay private.',
        action: secondaryButton({
          label: 'Enable peer network', onclick: enableNetwork, disabled: choiceBusy || !!choiceError,
          attrs: { 'data-network-choice': 'enable' },
        }),
        extra: choiceError ? [
          m('p.error', { role: 'alert' }, choiceError),
          secondaryButton({ label: choiceRefreshing ? 'Checking status…' : 'Refresh status', onclick: () => { void refreshChoice(); }, disabled: choiceRefreshing }),
        ] : null,
      }),
      shareOpen ? openShareRow() : startRow({
        icon: 'ext', title: 'Open a share link',
        text: 'Someone sent you a link to an app? Paste it to check it.', action: pasteButton(false),
      }),
    ]),
    m('p.type-small.disc-footnote', 'Share links need the peer network.'),
  ]);

  const lookingView = () => m('.disc-home.disc-view', { key: 'looking' }, [
    m('.disc-head-block', [
      m('h1.type-page-title', 'Discover'),
      m('span.type-body-sm', { role: 'status' }, [m('span.peerd-spinner.peerd-spinner--sm', { 'aria-hidden': 'true' }), 'Looking for peers…']),
    ]),
    heardError(),
    emptyState({
      title: 'Apps show up as peers share them',
      text: 'While you wait, try an included app or share one of yours from the Library.',
      actions: [reviewStarter(), libraryButton(), shareOpen ? null : pasteButton(false), includedButton()],
    }),
    shareOpen ? m('ul.disc-start-list', openShareRow()) : null,
  ]);

  /** @param {'connected'|'offline'} kind @param {DwebApp[]} candidates */
  const statusFor = (kind, candidates) => {
    if (kind === 'offline') {
      return statusRow({ text: 'Peer network is offline', count: null, buttons: [
        m('button.secondary', { type: 'button', disabled: retrying, onclick: () => { void retryConnection(); } }, retrying ? 'Reconnecting…' : 'Retry connection'),
      ] });
    }
    return statusRow({
      text: net?.kind === 'connected' ? peerCountLabel(net.linked) : 'Looking for peers…',
      count: apps.length ? appCountLabel(apps.length) : null,
      buttons: [
        shareOpen ? null : pasteButton(true),
        apps.length ? m('button.secondary', {
          type: 'button', disabled: !localReady || localFailed, onclick: () => surprise(candidates),
        }, 'Surprise me') : null,
        apps.length ? m('button.secondary', { type: 'button', onclick: () => {
          seed = crypto.getRandomValues(new Uint32Array(1))[0]; limit = EXPLORE_WINDOW; orderedIds = [];
        } }, 'Shuffle') : null,
        refreshButton({ spinning: refreshing, onclick: () => { void manualRefresh(); } }),
      ],
    });
  };

  const emptyView = () => m('.disc-home.disc-view', { key: 'empty' }, [
    m('h1.type-page-title', 'Discover'),
    statusFor('connected', []),
    rootAlert(),
    shareOpen ? m('ul.disc-start-list', openShareRow()) : null,
    emptyState({
      title: 'No apps shared yet',
      text: 'Apps appear here when your peers share them. You can share one of yours from the Library.',
      actions: [libraryButton(), includedButton()],
    }),
  ]);

  const includedTiles = () => {
    const starters = starterKeys.flatMap(key => {
      const starter = packagedStarter(key);
      return starter ? [{ key: `starter:${key}`, tone: key, name: starter.name, description: starter.description,
        action: tileButton({ label: 'Review', onclick: () => openOptions(`transfer?starter=${key}`) }) }] : [];
    });
    const commons = {
      key: 'commons', tone: 'commons', name: COMMONS_NAME,
      description: 'Packaged peer chat. Joining a room is a separate action inside the app.',
      action: commonsId
        ? tileButton({ label: 'Open', open: true, disabled: commonsBusy, onclick: () => { void openCommons(); } })
        : tileButton({ label: commonsBusy ? 'Opening…' : 'Add and open Commons', disabled: commonsBusy || commonsUnknown || !localReady,
          onclick: () => { void addCommons(); } }),
    };
    return matchQuery([...starters, commons], query).map(item => tile({
      key: item.key, name: item.name, letter: letterOf(item.name), tone: toneOf(item.tone),
      meta: 'Comes with peerd', description: item.description, action: item.action,
    }));
  };

  /** @param {boolean} offline */
  const gridView = (offline) => {
    const list = offline ? offlineApps() : apps;
    const shownApps = pill === 'included' ? [] : ordered(list, offline);
    const tiles = pill === 'included' ? includedTiles()
      : shownApps.slice(0, limit).map(app => tile(appTileProps(app, offline)));
    const browse = !offline || list.length > 0 || pill !== 'all' || !!query;
    return m('.disc-home.disc-view', { key: offline ? 'offline' : 'grid' }, [
      m('h1.type-page-title', 'Discover'),
      statusFor(offline ? 'offline' : 'connected', surpriseCandidates(shownApps)),
      offline ? null : heardError(),
      libraryLine(),
      rootAlert(),
      shareOpen && !offline ? m('ul.disc-start-list', openShareRow()) : null,
      pills({ value: pill, onSelect: selectPill }),
      browse ? searchInput({ value: query, oninput: setQuery }) : null,
      !browse ? null : tiles.length ? m('.disc-grid', tiles) : emptyState({
        title: 'No matching apps', text: 'Change your search or filters.', boxed: true, status: true,
        actions: [secondaryButton({ label: 'Clear filters', onclick: clearFilters })],
      }),
      pill !== 'included' && shownApps.length > limit
        ? secondaryButton({ label: 'Show more', onclick: () => { limit += EXPLORE_WINDOW; }, attrs: { class: 'disc-more' } }) : null,
    ]);
  };

  /** @param {Fact[]} list @param {string|null} [footnote] */
  const techView = (list, footnote = null) => techDetails({
    id: TECH_ID, open: techOpen, onToggle: () => { techOpen = !techOpen; }, facts: list, footnote, note: copyNote(),
  });

  /** @param {DwebApp} app */
  const appFacts = (app) => {
    const id = app.dwapp_id ?? '';
    const address = discoveryAddress(app);
    const bytes = bytesLabel(app.size);
    /** @type {Fact[]} */ const list = [];
    if (app.publisher) list.push({ label: 'Made by', value: app.publisher, code: true, copy: copyButton(`${id}:did`, app.publisher) });
    if (typeof app.version_id === 'string') list.push({ label: 'Version', value: app.version_id, code: true });
    if (address) list.push({ label: 'Share link', value: address, code: true, copy: copyButton(`${id}:link`, address) });
    if (bytes) list.push({ label: 'Size', value: bytes });
    list.push({ label: 'WebAssembly', value: wasmLabel(app.includes_wasm) });
    list.push({ label: 'Runtime', value: app.runtimeCompatibility?.message ?? 'Runtime requirements not specified.' });
    return list;
  };

  /** @param {string} key */
  const appPage = (key) => {
    const app = apps.find(a => a.dwapp_id === key) ?? offlineApps().find(a => a.dwapp_id === key)
      ?? (pageApp?.dwapp_id === key ? pageApp : null);
    if (!app) { route = { page: 'root' }; return null; }
    const f = facts(app);
    const state = pageState({
      incompatible: f.incompatible, conflict: liveConflict(app) !== undefined, busy: f.state, uncertain: f.uncertain,
      installed: !!f.localId,
    });
    const name = nameOf(app);
    const effectBusy = ['installing', 'updating'].includes(f.state ?? '') || f.uncertain;
    /** @type {ButtonProps|null} */ let primary = null;
    /** @type {ButtonProps|null} */ let secondary = null;
    if (state === 'review') {
      primary = { label: 'Install and share', disabled: !app.uri || !localReady, onclick: () => { void install(app); } };
    }
    if (state === 'installed') {
      primary = { label: 'Open', disabled: !f.localId, onclick: () => { void openApp(f.localId, f.id); } };
      if (f.updatable && !f.mine && f.localId) {
        const localId = f.localId;
        secondary = { label: 'Update', onclick: () => { void update(app, localId); } };
      }
    }
    if (state === 'failed') {
      primary = { label: 'Try again', onclick: () => { void (f.localId ? update(app, f.localId) : install(app)); } };
    }
    if (state === 'unknown') primary = { label: 'Refresh', disabled: refreshing, onclick: () => { void manualRefresh(); } };
    const panel = state === 'cant-run' ? cantRunPanel()
      : state === 'conflict' ? conflictPanel({
        disabled: effectBusy || !f.localId,
        onFork: () => { if (f.localId) void update(app, f.localId, 'fork'); },
        onReplace: () => { if (f.localId) void update(app, f.localId, 'replace'); },
        onCancel: () => { conflicts.delete(f.id); goBack(); },
      })
        : installPanel({
          state,
          message: state === 'installing'
            ? `You can leave this page. The ${f.state === 'updating' ? 'update' : 'install'} keeps going.`
            : state === 'failed' || state === 'unknown' ? f.state ?? null : null,
          notice: notices[f.id] ?? (state === 'review' && !localReady ? libraryStatus({ ready: false, failed: localFailed }) : null),
          error: alertLine?.key === f.id ? alertLine.text : null,
          primary, secondary,
        });
    return m('.disc-home.disc-view.disc-page', { key: `app:${key}` }, [
      backLink({ onclick: goBack }),
      appHead({
        name, letter: letterOf(name), tone: toneOf(f.id), maker: makerOf(app.publisher),
        onMaker: () => { if (app.publisher) openMaker(app.publisher); },
        kb: kbLabel(app.size), modified: state === 'conflict', description: app.description,
      }),
      panel,
      state === 'cant-run' || state === 'conflict' ? null : safetyLines(),
      techView(appFacts(app), typeof app.includes_wasm === 'boolean' ? WASM_HINT : null),
    ]);
  };

  const linkPage = () => {
    const target = linkPreview ?? linkPending;
    if (!target) { route = { page: 'root' }; return null; }
    // why the full address: any peer can sign a card that names this uri.
    // Borrow a name only from the card its own publisher signed.
    const card = apps.find(app => discoveryAddress(app) === target.address);
    const name = linkPreview?.name ?? card?.name ?? 'Unnamed app';
    const installing = !!linkPending && linkBusy === 'install';
    const state = pageState({
      incompatible: linkPreview?.runtimeCompatibility?.status === 'unsupported', conflict: false,
      busy: installing ? 'installing' : linkFailure || undefined,
      uncertain: !!linkPending && !installing, installed: !!linkAppId,
    });
    const blocked = !attrs.enabled || !!linkBusy;
    /** @type {ButtonProps|null} */ const primary = state === 'review'
      ? { label: 'Install and share', disabled: blocked || !linkPreview, onclick: () => { void installLink(); } }
      : state === 'failed' ? { label: 'Try again', disabled: blocked || !linkPreview, onclick: () => { void installLink(); } }
        : state === 'unknown' ? { label: 'Refresh', disabled: !!linkBusy, onclick: () => { void reconcileLink(); } }
          : state === 'installed' ? { label: 'Open', disabled: !!linkBusy, onclick: () => { void openLinkApp(); } } : null;
    const bytes = bytesLabel(linkPreview?.decodedBytes);
    /** @type {Fact[]} */ const list = [
      { label: 'Made by', value: target.publisher, code: true, copy: copyButton('link:did', target.publisher) },
      { label: 'Version', value: target.hash, code: true },
      { label: 'Share link', value: target.address, code: true, copy: copyButton('link:address', target.address) },
    ];
    if (bytes) list.push({ label: 'Size', value: bytes });
    list.push({ label: 'WebAssembly', value: wasmLabel(linkPreview?.containsWasm) });
    list.push({ label: 'Runtime', value: linkPreview?.runtimeCompatibility?.message ?? 'Runtime requirements not specified.' });
    const tone = toneOf(card?.dwapp_id ?? target.uri);
    return m('.disc-home.disc-view.disc-page', { key: 'link' }, [
      backLink({ onclick: goBack }),
      appHead({
        name, letter: letterOf(name), tone, maker: makerOf(target.publisher),
        onMaker: () => openMaker(target.publisher), kb: kbLabel(linkPreview?.decodedBytes), description: card?.description,
      }),
      state === 'cant-run' ? cantRunPanel() : installPanel({
        state: state === 'conflict' ? 'review' : state,
        message: state === 'installing' ? 'You can leave this page. The install keeps going.'
          : state === 'unknown' ? 'peerd could not confirm whether the install finished. Refresh to check before trying again.'
            : state === 'failed' ? linkFailure : null,
        notice: linkNotice || null,
        error: alertLine?.key === 'link' ? alertLine.text : null,
        primary, secondary: null,
      }),
      state === 'cant-run' ? null : safetyLines(),
      techView(list),
    ]);
  };

  /** @param {string} did */
  const makerPage = (did) => {
    const name = contactNames.get(did) ?? null;
    const title = name ?? shortKey(did);
    const rows = apps.filter(app => app.publisher === did).map(app => appRow(appTileProps(app, false)));
    return m('.disc-home.disc-view.disc-page', { key: `maker:${did}` }, [
      backLink({ onclick: goBack }),
      makerHead({ title, letter: letterOf(title), tone: toneOf(did), saved: !!name }),
      m('.disc-section.disc-section--tight', [
        m('.type-label-strong', `Apps from ${title}`),
        m('ul.disc-app-list', rows),
      ]),
      techView([{ label: 'Made by', value: did, code: true, copy: copyButton(`maker:${did}:did`, did) }]),
    ]);
  };

  const rootPage = () => {
    const view = rootOf(pill === 'included');
    return view === 'start' ? startView() : view === 'looking' ? lookingView() : view === 'empty' ? emptyView()
      : gridView(view === 'offline');
  };

  /** @param {{dom: Element|null}} vnode */
  const afterRender = (vnode) => {
    rootDom = vnode.dom;
    if (attrs.enabled) startPolling(); else stopPolling();
    if (!pendingFocus || !rootDom) return;
    const { selector, scroll, fallback, ifLost } = pendingFocus;
    pendingFocus = null;
    const host = scrollHost();
    if (host && scroll !== null) host.scrollTop = scroll;
    // why ifLost: a settled install offers Open, which runs the app. Take
    // focus there only when it fell off the removed button, never from a
    // control the user moved to meanwhile.
    if (ifLost && document.activeElement && document.activeElement !== document.body) return;
    const target = (selector ? rootDom.querySelector(selector) : null) ?? (fallback ? rootDom.querySelector(fallback) : null);
    if (target instanceof HTMLElement) target.focus({ preventScroll: scroll !== null });
  };

  return {
    oninit() {
      // why: only the fences (in-flight and unknown effects) outlive a mount,
      // and an unknown one keeps its text, which says why install stays off.
      // A settled outcome describes the Library as it was, and the user may
      // have deleted or updated the app there since, so the catalog decides.
      for (const id of Object.keys(busy)) if (!['installing', 'updating'].includes(busy[id]) && !unconfirmed.has(id)) delete busy[id];
      for (const id of Object.keys(installedId)) delete installedId[id];
      for (const id of Object.keys(notices)) delete notices[id];
      conflicts.clear();
      try {
        const saved = sessionStorage.getItem(PENDING_KEY);
        if (saved) {
          linkPending = immutableAppRoot(saved);
          linkInput = linkPending.address;
          shareOpen = true;
          route = { page: 'link' };
        }
      } catch {
        linkError = 'Could not read the pending install receipt. Reload before installing.';
        linkBusy = 'receipt';
        shareOpen = true;
      }
    },
    oncreate: afterRender,
    onupdate: afterRender,
    onremove() {
      dead = true;
      linkEpoch++;
      choiceAttempt++;
      stopPolling();
      if (choiceTimer) clearTimeout(choiceTimer);
      if (copyTimer) clearTimeout(copyTimer);
    },
    /** @param {{attrs: Attrs}} vnode */
    view(vnode) {
      attrs = vnode.attrs;
      if (viewEnabled && !attrs.enabled) { linkEpoch++; linkPreview = null; route = { page: 'root' }; }
      viewEnabled = attrs.enabled;
      answerKey(attrs.openKey);
      if (!attrs.enabled) return [startView()];
      const page = route.page === 'app' ? appPage(route.key) : route.page === 'link' ? linkPage()
        : route.page === 'maker' ? makerPage(route.did) : null;
      return [page ?? rootPage()];
    },
  };
};
